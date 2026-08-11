import { type ObservedHostKey, SshConnectionPool } from "@hosts/drivers/ssh-connection.pool";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";

/** Audit kinds this service writes. Read by the activity strip. */
export const HOST_KEY_PINNED = "host.key.pinned";
export const HOST_KEY_MISMATCH = "host.key.mismatch";
export const HOST_KEY_ACCEPTED = "host.key.accepted";

/**
 * How long one mismatch stands for the ones behind it.
 *
 * Long enough to swallow a polling loop, short enough that a mismatch tomorrow
 * is its own entry rather than being folded into today's.
 */
const MISMATCH_AUDIT_WINDOW_MS = 15 * 60_000;

/**
 * Trust on first use, refuse on mismatch (TRE-10).
 *
 * The pool decides — synchronously, mid-handshake — whether to continue. This
 * service is everything that happens *after* that decision and must not be on
 * its critical path: recording the first sighting, and turning a refusal into
 * something a person can see and act on.
 */
@Injectable()
export class HostKeyService {
  private readonly logger = new Logger(HostKeyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pool: SshConnectionPool,
  ) {}

  /**
   * The verifier's report, handled off the handshake stack.
   *
   * Deliberately returns void and swallows its own failures. It is called from
   * a synchronous ssh2 callback that cannot await anything, so an unhandled
   * rejection here would take down the process rather than fail the connection
   * — and the connection has already been allowed or refused by this point.
   */
  handleObservation(hostId: string, userId: string, observed: ObservedHostKey): void {
    if (observed.verdict === "matched" && !observed.relabelFrom) return;

    const work = observed.relabelFrom
      ? this.relabel(hostId, observed, observed.relabelFrom)
      : observed.verdict === "trusted"
        ? this.pin(hostId, userId, observed)
        : this.refuse(hostId, userId, observed);

    void work.catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Could not record host key ${observed.verdict} for host ${hostId}: ${reason}`);
    });
  }

  /**
   * Rewrite a pre-TRE-10 pin under the algorithm the host actually offers.
   *
   * The fingerprint already matched, so nothing about what is trusted changes
   * here — only the label, which was a placeholder the form hardcoded. Doing it
   * on the connection that proved the match means the fleet heals itself as
   * hosts are used, with no migration guessing at values it never recorded.
   *
   * `verifiedAt` is carried over rather than reset: the user did confirm this
   * fingerprint on the create form, and that fact belongs to the fingerprint,
   * not to the label being corrected.
   */
  private async relabel(hostId: string, observed: ObservedHostKey, staleAlgorithm: string): Promise<void> {
    const stale = await this.prisma.hostKnownKeys.findUnique({
      where: { hostId_algorithm: { hostId, algorithm: staleAlgorithm } },
      select: { fingerprint: true, firstSeenAt: true, verifiedAt: true },
    });
    // Another connection got here first; the row is already correct.
    if (!stale || stale.fingerprint !== observed.fingerprint) return;

    await this.prisma.$transaction([
      this.prisma.hostKnownKeys.deleteMany({ where: { hostId, algorithm: staleAlgorithm } }),
      this.prisma.hostKnownKeys.upsert({
        where: { hostId_algorithm: { hostId, algorithm: observed.algorithm } },
        create: {
          hostId,
          algorithm: observed.algorithm,
          fingerprint: observed.fingerprint,
          firstSeenAt: stale.firstSeenAt,
          verifiedAt: stale.verifiedAt,
        },
        update: {},
      }),
    ]);

    this.logger.log(`Host key pin relabelled for ${hostId}: "${staleAlgorithm}" is really ${observed.algorithm}`);
  }

  /**
   * First sighting becomes the pin. `verifiedAt` stays null: nobody has read
   * this fingerprint back against the real machine, and the UI says so rather
   * than implying a check that never happened.
   */
  private async pin(hostId: string, userId: string, observed: ObservedHostKey): Promise<void> {
    const created = await this.prisma.hostKnownKeys.createMany({
      // A concurrent first connection on the same host races us here. The
      // unique index on (hostId, algorithm) is what makes that a no-op instead
      // of two rows, and skipDuplicates is what keeps it from throwing.
      data: [
        {
          hostId,
          algorithm: observed.algorithm,
          fingerprint: observed.fingerprint,
        },
      ],
      skipDuplicates: true,
    });

    if (created.count === 0) return;

    await this.audit(userId, hostId, HOST_KEY_PINNED, `Pinned ${observed.algorithm} host key on first connect`, {
      algorithm: observed.algorithm,
      fingerprint: observed.fingerprint,
    });
    this.logger.log(`Host key pinned for ${hostId}: ${observed.algorithm} ${observed.fingerprint}`);
  }

  /**
   * A pinned host offered something else. The connection is already refused —
   * ssh2 aborted it before authentication — so this is about making sure the
   * refusal is loud and that nothing else is still talking to that address.
   */
  private async refuse(hostId: string, userId: string, observed: ObservedHostKey): Promise<void> {
    // Other pooled connections for this host were established against the old
    // key and may predate the change. They are not trustworthy now.
    this.pool.evictHost(hostId, "host key mismatch");

    // The sidebar polls each host's summary on a timer, so a host in this state
    // produces a refusal every cycle. One row per cycle would bury the activity
    // strip in identical entries and make the audit trail useless exactly when
    // someone needs to read it. The refusal itself still happens on every
    // connection — it is only the recording of it that is collapsed.
    const recent = await this.prisma.activityLog.findFirst({
      where: {
        hostId,
        kind: HOST_KEY_MISMATCH,
        createdAt: { gt: new Date(Date.now() - MISMATCH_AUDIT_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return;

    await this.audit(
      userId,
      hostId,
      HOST_KEY_MISMATCH,
      `Host key mismatch — connection refused before authenticating`,
      {
        algorithm: observed.algorithm,
        offered: observed.fingerprint,
        pinned: observed.pinned,
      },
    );

    // Warn, not error: this is an expected security outcome with a defined
    // response, and it should be readable in the log without a stack trace.
    this.logger.warn(
      `Host key mismatch for ${hostId} (${observed.algorithm}): offered ${observed.fingerprint}, pinned ${observed.pinned ?? "none for this algorithm"}`,
    );
  }

  /**
   * Replace a pin, deliberately (TRE-10 §3).
   *
   * Hosts do get reinstalled, so this path has to exist — but it is its own
   * endpoint reached from the host edit screen, never a retry button on the
   * error the mismatch produced. The fingerprint is echoed back by the caller
   * so accepting is a decision about a specific key rather than about whatever
   * answers next.
   */
  async accept(userId: string, hostId: string, algorithm: string, fingerprint: string): Promise<void> {
    const host = await this.prisma.hosts.findFirst({
      where: { id: hostId, userId },
      select: { id: true },
    });
    if (!host) throw new NotFoundException(`No such host: ${hostId}`);

    const current = await this.prisma.hostKnownKeys.findUnique({
      where: { hostId_algorithm: { hostId, algorithm } },
      select: { fingerprint: true },
    });

    if (current?.fingerprint === fingerprint) {
      // Already the pin. Confirming it is a verification, not a change.
      await this.prisma.hostKnownKeys.update({
        where: { hostId_algorithm: { hostId, algorithm } },
        data: { verifiedAt: new Date() },
      });
      await this.audit(userId, hostId, HOST_KEY_ACCEPTED, `Confirmed ${algorithm} host key`, {
        algorithm,
        fingerprint,
      });
      return;
    }

    await this.prisma.hostKnownKeys.upsert({
      where: { hostId_algorithm: { hostId, algorithm } },
      create: { hostId, algorithm, fingerprint, verifiedAt: new Date() },
      update: { fingerprint, firstSeenAt: new Date(), verifiedAt: new Date() },
    });

    // The pooled connections were built against the key being replaced.
    this.pool.evictHost(hostId, "host key replaced");

    await this.audit(userId, hostId, HOST_KEY_ACCEPTED, `Accepted a new ${algorithm} host key`, {
      algorithm,
      fingerprint,
      replaced: current?.fingerprint ?? null,
    });
    this.logger.warn(`Host key replaced for ${hostId} (${algorithm}) by user ${userId}`);
  }

  private async audit(
    userId: string,
    hostId: string,
    kind: string,
    summary: string,
    payload: Prisma.InputJsonObject,
  ): Promise<void> {
    await this.prisma.activityLog.create({
      data: {
        userId,
        hostId,
        kind,
        summary: summary.slice(0, 255),
        tag: null,
        payload,
      },
    });
  }
}
