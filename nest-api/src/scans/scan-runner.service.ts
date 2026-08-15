import { Injectable, Logger } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { ExecStream, HostDriver } from "@hosts/drivers/host-driver";
import { DU_RUNGS, type DuRung, firstRung, isNiceFailure, probeFlavour, shouldDemote } from "@scans/du-flavour";
import { countUnreadable, DuParser } from "@scans/du-parse";
import { confirmDuplicates, type DuplicateReport, NO_DUPLICATES } from "@scans/duplicate-finder";
import { type AggregateResult, ScanAggregator } from "@scans/scan-aggregator";
import { type ScanPhase, ScanEventsService, type ScanProgress } from "@scans/scan-events.service";
import { ENTRY_BATCH, KEEP_SCANS_PER_ROOT, PROGRESS_TICK_MS, SCAN_NICE } from "@scans/scan-limits";
import { isShutdown } from "@scans/scan-signals";
import { PrismaService } from "../prisma/prisma.service";

/**
 * One scan, end to end (TRE-32).
 *
 * **It never throws.** The queue calls it and forgets it; anything that escapes
 * would be an unhandled rejection with a row left `RUNNING` and a host locked
 * out of scanning by its own `runningSlot`. Every exit from `run` writes a
 * terminal status or deliberately leaves the row for the boot sweep, and there
 * is no third option.
 *
 * **The row is written exactly twice.** Once as `RUNNING` by the service that
 * accepted the request, once here when the scan ends. Nothing is written per
 * record — there are millions — and the entries land in the *same transaction*
 * as the terminal write. That is what makes "no partial scan marked complete"
 * a property of the shape rather than a thing to be careful about: at every
 * instant, including a `kill -9` halfway through, a scan has all of its rows or
 * none of them.
 */

interface ScanRow {
  id: string;
  hostId: string;
  userId: string;
  root: string;
  realPath: string;
  depth: number;
}

interface WalkOutcome {
  aggregate: AggregateResult;
  rung: DuRung;
  niced: boolean;
  unreadableCount: number;
}

/** What a scan ended as, from the runner's point of view. */
type Ending =
  | { kind: "done"; walk: WalkOutcome; duplicates: DuplicateReport }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string }
  /** The API is stopping. Write nothing; the next boot sweeps it. */
  | { kind: "abandoned" };

@Injectable()
export class ScanRunnerService {
  private readonly logger = new Logger(ScanRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly events: ScanEventsService,
  ) {}

  async run(scan: ScanRow, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    let driver: HostDriver | null = null;
    let ending: Ending;

    // Live figures the progress tick reads. Held here rather than passed
    // around so the tick has one place to look and the walk has one place to
    // write, with no callback per record.
    const live = { phase: "probing" as ScanPhase, inodes: 0, bytes: 0n, hashedBytes: null as bigint | null };

    const tick = setInterval(() => {
      this.emit(scan, "RUNNING", live, startedAt, null);
    }, PROGRESS_TICK_MS);
    tick.unref();

    try {
      driver = await this.factory.forHost(scan.hostId, scan.userId);

      live.phase = "walking";
      const walk = await this.walk(driver, scan, signal, live);

      if (isShutdown(signal)) {
        ending = { kind: "abandoned" };
      } else if (signal.aborted) {
        ending = { kind: "cancelled" };
      } else if (walk.aggregate.totalBytes === null) {
        // The root record is the authoritative total and the definition of a
        // complete walk. Without it we have a prefix of a filesystem, and
        // storing that as a finished scan would put a confident number under a
        // question nothing answered.
        ending = { kind: "failed", message: "The walk ended before it reached the top of the tree." };
      } else {
        live.phase = "hashing";
        const duplicates = await this.duplicates(driver, walk, signal, live);
        ending = isShutdown(signal)
          ? { kind: "abandoned" }
          : signal.aborted
            ? { kind: "cancelled" }
            : { kind: "done", walk, duplicates };
      }
    } catch (error) {
      ending = isShutdown(signal)
        ? { kind: "abandoned" }
        : signal.aborted
          ? { kind: "cancelled" }
          : { kind: "failed", message: describeFailure(error) };
      if (ending.kind === "failed") {
        this.logger.warn(`Scan ${scan.id} of ${scan.root} failed: ${(error as Error).message}`);
      }
    } finally {
      clearInterval(tick);
      await driver?.dispose().catch(() => undefined);
    }

    live.phase = "saving";
    await this.settle(scan, ending, live, startedAt);
  }

  /**
   * The walk, down the rung ladder until one of them answers.
   *
   * A rung is only abandoned on evidence that the host refused a flag — see
   * `shouldDemote`, and note that exit 1 is never such evidence: GNU `du` exits
   * 1 on an unreadable subtree and still prints everything it could read, which
   * is the commonest successful scan of a system directory there is.
   */
  private async walk(
    driver: HostDriver,
    scan: ScanRow,
    signal: AbortSignal,
    live: { inodes: number; bytes: bigint },
  ): Promise<WalkOutcome> {
    if (!driver.execStream) {
      throw new Error("This host's driver cannot stream a command, so it cannot be scanned.");
    }

    const probe = await probeFlavour(driver);
    let niced = true;

    for (let index = firstRung(probe); index < DU_RUNGS.length; index += 1) {
      const rung = DU_RUNGS[index];
      const attempt = await this.attempt(driver, scan, rung, signal, live, niced);

      if (attempt.niceRefused) {
        // The host has no `nice`, so the prefix — not `du` — is what failed.
        // Retry the same rung without it and record that the scan was not
        // de-prioritised, rather than demoting a `du` that was never asked.
        niced = false;
        this.logger.log(`Host ${scan.hostId} has no usable nice; scanning at normal priority`);
        const retry = await this.attempt(driver, scan, rung, signal, live, false);
        if (!retry.demote) return { ...retry.outcome, niced: false };
        continue;
      }

      if (!attempt.demote) return { ...attempt.outcome, niced };
    }

    throw new Error("No form of `du` on this host produced a readable result.");
  }

  /** One `du` invocation, parsed as it arrives. */
  private async attempt(
    driver: HostDriver,
    scan: ScanRow,
    rung: DuRung,
    signal: AbortSignal,
    live: { inodes: number; bytes: bigint },
    niced: boolean,
  ): Promise<{
    demote: boolean;
    niceRefused: boolean;
    outcome: Omit<WalkOutcome, "niced">;
  }> {
    const aggregator = new ScanAggregator({
      root: scan.realPath,
      depth: scan.depth,
      hasTime: rung.hasTime,
      hasFiles: rung.hasFiles,
      now: Date.now(),
    });
    const parser = new DuParser(rung);

    // Re-checked here rather than asserted away. `walk` refuses a driver that
    // cannot stream before it reaches this, so the branch is unreachable — but
    // a non-null assertion would be a claim the type system cannot see the
    // reason for, and this is a method somebody may call from somewhere else.
    if (!driver.execStream) {
      throw new Error("This host's driver cannot stream a command, so it cannot be scanned.");
    }
    const running: ExecStream = await driver.execStream("du", [...rung.args, scan.realPath], {
      signal,
      nice: niced ? SCAN_NICE : undefined,
    });

    let sawStdout = false;

    // `for await` rather than a 'data' listener, and that is the backpressure:
    // the loop body is the parser, so a parser falling behind stops reading,
    // which stops the channel's window opening, which stops the remote `du`.
    // A listener would buffer a filesystem's worth of records into this process
    // on the walk's behalf.
    for await (const chunk of running.stdout) {
      const buffer = chunk as Buffer;
      if (buffer.length > 0) sawStdout = true;
      for (const record of parser.push(buffer)) {
        aggregator.add(record);
        live.inodes += 1;
        live.bytes += record.bytes;
      }
    }
    for (const record of parser.end()) {
      aggregator.add(record);
      live.inodes += 1;
      live.bytes += record.bytes;
    }

    const result = await running.done;
    const aggregate = aggregator.finish();

    // A cancelled walk is not a rung that failed. Return what there is and let
    // the caller read the signal.
    if (signal.aborted) {
      return {
        demote: false,
        niceRefused: false,
        outcome: { aggregate, rung, unreadableCount: countUnreadable(result.stderr) },
      };
    }

    if (!sawStdout && isNiceFailure(result.code)) {
      return { demote: false, niceRefused: true, outcome: { aggregate, rung, unreadableCount: 0 } };
    }

    return {
      demote: shouldDemote({ code: result.code, stdout: sawStdout ? "x" : "", stderr: result.stderr }),
      niceRefused: false,
      outcome: { aggregate, rung, unreadableCount: countUnreadable(result.stderr) },
    };
  }

  /** The duplicate pass, which a rung with no per-file records cannot do. */
  private async duplicates(
    driver: HostDriver,
    walk: WalkOutcome,
    signal: AbortSignal,
    live: { hashedBytes: bigint | null },
  ): Promise<DuplicateReport> {
    if (!walk.rung.hasFiles) return NO_DUPLICATES;

    return confirmDuplicates(walk.aggregate.duplicateCandidates, walk.aggregate.duplicatesDropped, {
      driver,
      signal,
      onProgress: (hashed) => {
        live.hashedBytes = hashed;
      },
    });
  }

  /**
   * The terminal write, and the only place entries are created.
   *
   * One transaction: the status, the facts, every entry row, the superseded
   * scan's deletion and the per-root trim. Either the scan exists complete or
   * it does not exist as a finished scan at all.
   */
  private async settle(
    scan: ScanRow,
    ending: Ending,
    live: { inodes: number; bytes: bigint },
    startedAt: number,
  ): Promise<void> {
    if (ending.kind === "abandoned") {
      // Deliberately nothing. The row stays RUNNING and the next boot's sweep
      // finds it — the same path a `kill -9` takes, which is why it is the one
      // that gets exercised.
      this.logger.log(`Scan ${scan.id} left for the next boot to reap`);
      return;
    }

    try {
      if (ending.kind === "done") {
        await this.saveDone(scan, ending.walk, ending.duplicates);
      } else {
        await this.prisma.diskScans.update({
          where: { id: scan.id },
          data: {
            status: ending.kind === "cancelled" ? "CANCELLED" : "FAILED",
            finishedAt: new Date(),
            runningSlot: null,
            error: ending.kind === "failed" ? ending.message.slice(0, 500) : null,
          },
        });
      }
    } catch (error) {
      // The scan finished and the database refused the result. Nothing here can
      // recover it, and throwing would only turn it into an unhandled
      // rejection — but the slot must not be left held, or the host can never
      // be scanned again.
      this.logger.error(`Scan ${scan.id} could not be recorded: ${(error as Error).message}`);
      await this.prisma.diskScans
        .update({
          where: { id: scan.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            runningSlot: null,
            error: "The result could not be saved.",
          },
        })
        .catch(() => undefined);
    }

    const status = ending.kind === "done" ? "DONE" : ending.kind === "cancelled" ? "CANCELLED" : "FAILED";
    this.emit(
      scan,
      status,
      { ...live, phase: "saving", hashedBytes: null },
      startedAt,
      ending.kind === "failed" ? ending.message : null,
    );
  }

  private async saveDone(scan: ScanRow, walk: WalkOutcome, duplicates: DuplicateReport): Promise<void> {
    const aggregate = walk.aggregate;
    const total = aggregate.totalBytes ?? 0n;

    const rows = aggregate.entries.map((entry) => ({
      scanId: scan.id,
      path: entry.path,
      bytes: entry.bytes,
      percent: shareOf(entry.bytes, total),
      parentPath: entry.parentPath,
      depth: entry.depth,
      kind: entry.kind,
    }));

    const superseded = await this.prisma.diskScans.findUnique({
      where: { id: scan.id },
      select: { supersedesId: true },
    });

    await this.prisma.$transaction([
      this.prisma.diskScans.update({
        where: { id: scan.id },
        data: {
          status: "DONE",
          finishedAt: new Date(),
          runningSlot: null,
          error: null,
          totalBytes: total,
          inodes: aggregate.inodes,
          flavour: walk.rung.flavour,
          niced: walk.niced,
          unreadableCount: walk.unreadableCount,
          truncated: aggregate.truncated,
          largestPath: aggregate.largest?.path ?? null,
          largestBytes: aggregate.largest?.bytes ?? null,
          oldFileCount: walk.rung.hasTime ? aggregate.oldFileCount : null,
          oldFileBytes: walk.rung.hasTime ? aggregate.oldFileBytes : null,
          oldFileBefore: walk.rung.hasTime ? aggregate.oldFileBefore : null,
          dupGroupsCandidate: walk.rung.hasFiles ? duplicates.candidates : null,
          dupGroupsConfirmed: walk.rung.hasFiles ? duplicates.confirmed : null,
          dupGroupsSkipped: walk.rung.hasFiles ? duplicates.skipped : null,
          dupReclaimableBytes: walk.rung.hasFiles ? duplicates.reclaimableBytes : null,
        },
      }),
      ...batches(rows, ENTRY_BATCH).map((batch) => this.prisma.diskScanEntries.createMany({ data: batch })),
      // The scan this one replaced has done its job of keeping the panel warm.
      // `onDelete: SetNull` nulls the pointer on the survivor as a side effect.
      ...(superseded?.supersedesId
        ? [this.prisma.diskScans.deleteMany({ where: { id: superseded.supersedesId } })]
        : []),
    ]);

    await this.trim(scan);
  }

  /**
   * Keep the last few DONE scans of a root and drop the rest.
   *
   * The supersede chain only ever holds one, so it does not bound this on its
   * own: scanning `/var`, then `/home`, then `/var` again leaves rows outside
   * the chain. Outside the terminal transaction because it is housekeeping —
   * failing it must not fail a scan that succeeded.
   */
  private async trim(scan: ScanRow): Promise<void> {
    try {
      const keep = await this.prisma.diskScans.findMany({
        where: { hostId: scan.hostId, root: scan.root, status: "DONE" },
        orderBy: { startedAt: "desc" },
        select: { id: true },
        skip: KEEP_SCANS_PER_ROOT,
      });
      if (keep.length === 0) return;
      await this.prisma.diskScans.deleteMany({ where: { id: { in: keep.map((row) => row.id) } } });
    } catch (error) {
      this.logger.warn(`Could not trim old scans for ${scan.root}: ${(error as Error).message}`);
    }
  }

  private emit(
    scan: ScanRow,
    status: ScanProgress["status"],
    live: { phase: ScanPhase; inodes: number; bytes: bigint; hashedBytes: bigint | null },
    startedAt: number,
    error: string | null,
  ): void {
    this.events.emit(scan.userId, {
      id: scan.id,
      hostId: scan.hostId,
      root: scan.root,
      status,
      phase: live.phase,
      inodes: live.inodes,
      bytes: live.bytes.toString(),
      elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      hashedBytes: live.hashedBytes?.toString() ?? null,
      error,
    });
  }
}

/**
 * A rectangle's share of the scan root, to two decimals.
 *
 * Through `Number` rather than in BigInt arithmetic: the column is a
 * `Decimal(5,2)` and the value is a label, so the precision a double loses here
 * is far below what is stored. The bytes are the truth and they stay exact.
 */
function shareOf(bytes: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Math.round((Number(bytes) / Number(total)) * 10_000) / 100;
}

function batches<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    out.push(rows.slice(index, index + size));
  }
  return out;
}

/**
 * Fixed English chosen from the error's class. The remote message is never
 * stored: it is another machine's text, it can carry a path the reader has no
 * business seeing in this row, and it is not written for them.
 */
function describeFailure(error: unknown): string {
  if (isDriverError(error)) {
    switch (error.code) {
      case "EACCES":
      case "EPERM":
        return "Permission denied on the host.";
      case "ENOENT":
        return "`du` is not installed on this host, or the root is gone.";
      case "EUNREACHABLE":
        return "The connection to the host dropped while the scan was running.";
      case "EAUTH":
        return "The host refused the stored credential.";
      case "EHOSTKEY":
        return "The host key does not match the pinned one.";
      case "ETIMEDOUT":
        return "The host stopped responding.";
      default:
        return `The host refused with ${error.code}.`;
    }
  }
  return "The scan could not be completed.";
}
