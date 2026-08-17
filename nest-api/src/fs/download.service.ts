import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { AuditService } from "@audit/audit.service";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import { toHttp } from "@fs/driver-http";
import { basename, type ByteRange } from "@fs/download-headers";
import { entryCeiling } from "@fs/permissions.service";
import { walkTree } from "@fs/tree-walk";
import { zipTree } from "@fs/zip-stream";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { isPermissionRefusal, SudoRunnerService } from "@hosts/sudo/sudo-runner.service";

import type { HostDriver } from "@hosts/drivers/host-driver";
import type { Readable } from "node:stream";

/**
 * Getting a file off a host and onto a laptop (TRE-26).
 *
 * Two shapes behind one route. A file streams as itself, with a length and a
 * resumable window. A directory streams as a zip built while it is sent, with
 * no length because nobody knows one yet. Everything they share — the guard,
 * the limit, the audit row, the headers — is decided here, once.
 *
 * **Nothing is buffered.** Not in memory, not on the API's disk. A twenty
 * gigabyte file moves through this service in whatever the socket will take,
 * because at no point does anything here hold more than a chunk. That is a
 * property of how it is written rather than a setting, so the spec beside this
 * file measures it instead of asserting it.
 *
 * **The audit row is written here rather than by the interceptor.** The
 * interceptor watches the mutating verbs on purpose — the log is a record of
 * decisions, and burying them under directory listings is how a trail stops
 * being read. A download mutates nothing and is still the one read worth
 * recording: it is the operation that takes a copy of somebody's data off the
 * fleet, and "who took what, when, how much of it" is the question asked
 * afterwards. So this is a GET that opens and settles its own row.
 */

/**
 * 416. Nest's `HttpStatus` does not name it, and the number is the contract the
 * client reads — a resumable download that gets anything else retries forever.
 */
const RANGE_NOT_SATISFIABLE = 416;

/** Everything decided before a byte is written, which is all of it. */
export interface DownloadPlan {
  driver: HostDriver;
  /** The resolved path. Never the requested one. */
  realPath: string;
  /** What the client should see the download called. */
  filename: string;
  kind: "file" | "directory";
  /** Bytes, for a file. Absent for an archive, whose size is not knowable. */
  size?: number;
  /** Entries the archive will hold. Absent for a file. */
  entries?: number;
  /** Symlinks the archive leaves out, so the caller can say so. */
  skippedLinks?: number;
}

export interface PlanOptions {
  /**
   * Whether to spend this user's download rate limit. Default true; false only
   * where the caller has spent a limit of its own — see `LinkService.redeem`.
   */
  charge?: boolean;
}

/** An opened download: the bytes, and the row that has to be closed after them. */
export interface OpenedDownload {
  stream: Readable;
  /** Call once the response is finished, with what actually went out. */
  settle: (bytes: number, outcome: "success" | "failure", detail?: string) => Promise<void>;
}

@Injectable()
export class DownloadService {
  private readonly logger = new Logger(DownloadService.name);

  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly limits: RateLimitService,
    private readonly audit: AuditService,
    private readonly sudoRunner: SudoRunnerService,
  ) {}

  /**
   * Everything that can refuse, before anything is sent.
   *
   * The order matters more here than on the POST routes. Once a byte of the
   * body has been written the status line is gone and there is no way to say
   * "actually, no" — a 403 discovered halfway through an archive reaches the
   * client as a truncated zip. So the guard runs, the stat runs, the walk runs
   * and the limit is spent, and only then does the controller touch the
   * response.
   */
  async plan(userId: string, hostId: string, path: string, options: PlanOptions = {}): Promise<DownloadPlan> {
    const driver = await this.driverFor(hostId, userId);
    const validated = await this.guard.validate({ driver, userId, path, intent: "read" });
    const realPath = validated.realPath;

    // Per request. A download's reach is already bounded by the roots — it can
    // only take what the account could already open — so what this bounds is
    // the rate of a script rather than the volume of a person.
    //
    // Not charged when a signed link is being redeemed (TRE-66): that request
    // has already spent `LIMITS.signedLink` against the caller's IP, and
    // charging the issuer's per-minute budget as well would let one shared URL
    // lock its author out of their own downloads.
    if (options.charge !== false) {
      const verdict = await this.limits.consume(LIMITS.download, userId);
      if (!verdict.allowed) {
        throw new HttpException(
          RateLimitService.describe(LIMITS.download, verdict.resetSeconds),
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const stat = await this.statOf(driver, realPath);
    const filename = basename(realPath);

    if (stat.kind === "directory") {
      const ceiling = entryCeiling();
      const walked = await walkTree(driver, realPath, ceiling);
      if (walked.exceeded) {
        throw new HttpException(
          {
            statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
            code: "ETOOMANY",
            message: `${path} holds more than ${ceiling.toLocaleString("en-GB")} entries. Download a subdirectory, or raise the ceiling on the server.`,
            ceiling,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      return {
        driver,
        realPath,
        filename: `${filename}.zip`,
        kind: "directory",
        entries: walked.paths.length,
        skippedLinks: walked.skippedLinks,
      };
    }

    // A fifo or a device node would stream forever, or block, and neither is a
    // download. `stat` follows the link the guard already resolved, so a
    // symlink to a file arrives here as a file.
    if (stat.kind !== "file") {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          code: "ENOTREGULAR",
          message: `${path} is a ${stat.kind}, which has no contents to download.`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return { driver, realPath, filename, kind: "file", size: stat.size };
  }

  /**
   * Open the row, then the bytes.
   *
   * In that order, and the row is opened with `AuditService.open`, which fails
   * closed — a download that cannot be recorded does not happen. The same trade
   * the mutating routes make, for the same reason: this application's claim is
   * that everything done to a fleet is recorded, and an unrecorded copy of a
   * directory is exactly the event somebody comes looking for later.
   */
  async open(
    userId: string,
    sessionId: string | undefined,
    hostId: string,
    requestedPath: string,
    plan: DownloadPlan,
    range: ByteRange | null,
  ): Promise<OpenedDownload> {
    const rowId = await this.audit.open({
      userId,
      sessionId,
      hostId,
      kind: "file.download",
      summary:
        plan.kind === "directory"
          ? `download ${plan.filename} · ${count(plan.entries ?? 0, "entry", "entries")}`
          : `download ${plan.filename}${range ? ` · bytes ${range.start}-${range.end}` : ""}`,
      tag: plan.kind === "directory" ? "zip" : undefined,
      // Not destructive: it takes nothing away, and the flag decides a
      // retention window whose long end is for changes that cannot be read back
      // off the filesystem. What was downloaded still exists.
      destructive: false,
      payload: {
        paths: [requestedPath],
        kind: plan.kind,
        ...(plan.entries === undefined ? {} : { entries: plan.entries }),
        ...(plan.skippedLinks ? { skippedLinks: plan.skippedLinks } : {}),
        ...(range === null ? {} : { range: `${range.start}-${range.end}` }),
      },
    });

    const started = Date.now();
    const stream = await this.stream(plan, range, sessionId);

    return {
      stream,
      settle: async (bytes, outcome, detail) => {
        if (outcome === "failure") {
          // The row already carries this; the log is for the operator watching
          // a host rather than the account reading its own history. A download
          // that dies at the same byte every time is a host problem, and that
          // pattern is only visible here.
          this.logger.warn(`Download of ${plan.realPath} ended after ${bytes} bytes: ${detail ?? "no detail"}`);
        }
        // `bytes` is what left this process, counted on the way past — not the
        // size the plan predicted. On an interrupted download those differ, and
        // the one worth recording is the one that got there.
        await this.audit.settle(rowId, outcome, Date.now() - started, { bytes }, detail);
      },
    };
  }

  /**
   * The bytes for a plan, and nothing else — no row, no limit, no headers.
   *
   * Public because TRE-66 redeems a signed link: that route opens its own audit
   * row (attributed to the issuer, with the visitor's IP) and spends its own
   * IP-scoped limit, so it needs the streaming half of `open` without the
   * session-shaped half. Splitting it here is what keeps the two routes from
   * growing two ideas of how a file is read.
   */
  async stream(plan: DownloadPlan, range: ByteRange | null = null, sessionId?: string): Promise<Readable> {
    return plan.kind === "directory" ? this.archive(plan) : this.file(plan.driver, plan.realPath, range, sessionId);
  }

  private async archive(plan: DownloadPlan): Promise<Readable> {
    // Walked a second time rather than carried from the plan. The plan's walk
    // answered "is this small enough to send"; this one is the manifest, and
    // between them a file may have appeared. Re-walking costs one listing pass
    // and means the archive describes the tree it is actually reading.
    const walked = await walkTree(plan.driver, plan.realPath, entryCeiling());
    return zipTree(plan.driver, plan.realPath, walked.details).stream;
  }

  private async file(
    driver: HostDriver,
    realPath: string,
    range: ByteRange | null,
    sessionId?: string,
  ): Promise<Readable> {
    try {
      return await driver.createReadStream(realPath, range === null ? {} : { start: range.start, end: range.end });
    } catch (error) {
      // A root-owned file, with a window open (TRE-29). SFTP cannot be
      // elevated, so the bytes come from `sudo cat` instead — streamed, never
      // collected, so this stays the claim the rest of the file makes.
      if (isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, driver.hostId)) {
        // **`cat` cannot take a window.** Nothing on either allowlist can:
        // `tail -c +N` would give a start with no end, and bounding it needs a
        // second program and a pipe, which is exactly what shell-quote.ts
        // exists to prevent. So a root-owned file downloads whole or not at
        // all, and a resumed download of one is refused in those words rather
        // than silently answered with the entire file — which a client asking
        // for bytes 1000-2000 would write over the top of what it already had.
        if (range !== null) {
          throw new HttpException(
            {
              statusCode: RANGE_NOT_SATISFIABLE,
              code: "ENORANGESUDO",
              message:
                "This file can only be read with sudo, and a sudo read cannot start partway through. " +
                "Download it from the beginning.",
            },
            RANGE_NOT_SATISFIABLE,
          );
        }
        return this.sudoRunner.stream(driver, sessionId, driver.hostId, "cat", ["--", realPath]);
      }
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }

  private async statOf(driver: HostDriver, realPath: string) {
    try {
      return await driver.stat(realPath);
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    try {
      return await this.factory.forHost(hostId, userId);
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
