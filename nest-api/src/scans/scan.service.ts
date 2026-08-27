import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { toHttp } from "@fs/driver-http";
import type { StartScanDto } from "@scans/dto/start-scan.dto";
import { ScanQueueService } from "@scans/scan-queue.service";
import { DEFAULT_DEPTH, MAX_DEPTH, STALE_AFTER_SECONDS, STALE_RUNNING_AFTER_MS } from "@scans/scan-limits";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The scan routes' service (TRE-32): accept one, serve the last one, stop one.
 *
 * Nothing long-running happens here. A scan takes minutes, so the POST creates
 * a row, hands it to the queue and returns — a request that waited for the walk
 * would be a request that dies to a proxy timeout with a `du` still running on
 * somebody's server behind it.
 */

export interface ScanEntryView {
  path: string;
  bytes: string;
  percent: number;
  kind: "DIRECTORY" | "FILE" | "OTHER";
  depth: number;
  /**
   * On the local denylist, and so refused however it is reached (TRE-105).
   *
   * Present only where it is true, and only for the owner — see
   * `PathGuardService.disclosableDenial` for why a member is told nothing.
   * Omitted rather than sent as `false`, so a member's payload is exactly the
   * bytes it was before this field existed.
   */
  denied?: boolean;
}

export interface ScanFactsView {
  largest: { path: string; bytes: string } | null;
  oldFiles: { count: string; bytes: string; before: Date } | null;
  duplicates: { candidates: number; confirmed: number; skipped: number; reclaimableBytes: string } | null;
}

export interface ScanView {
  id: string;
  hostId: string;
  root: string;
  depth: number;
  status: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  flavour: "GNU" | "PORTABLE" | "SUBTOTALS";
  niced: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  /**
   * Seconds since the scan finished, computed here. The client's clock is not
   * ours, and "finished 4 minutes ago" drawn against a browser whose time is
   * wrong is a wrong statement made confidently.
   */
  ageSeconds: number | null;
  /** Older than the threshold below. */
  stale: boolean;
  /** Sent so the panel need not hardcode a policy the server owns. */
  staleAfterSeconds: number;
  totalBytes: string | null;
  inodes: string | null;
  unreadableCount: number;
  truncated: boolean;
  error: string | null;
  facts: ScanFactsView;
}

export interface ScanLevelView {
  /** The directory this level describes. */
  at: string;
  /** That directory's own subtotal, so a client can size the rectangles. */
  parentBytes: string;
  entries: ScanEntryView[];
}

export interface ScanStateView {
  /** The newest finished scan of this root, or null if there has never been one. */
  scan: ScanView | null;
  /** A scan of this host happening right now, whatever root it is walking. */
  running: ScanView | null;
  /** One treemap level of `scan`. Null when there is no finished scan. */
  level: ScanLevelView | null;
}

@Injectable()
export class ScanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly queue: ScanQueueService,
  ) {}

  /**
   * Accept a scan, or explain which one is already running.
   *
   * The root goes through the guard like every other path in the application:
   * `read` intent, because a scan reads. That is also what turns the client's
   * path into the real one `du` is given — a symlinked root resolved here is a
   * root that cannot walk out of the allowlist.
   */
  async start(userId: string, hostId: string, dto: StartScanDto): Promise<ScanView> {
    const depth = clampDepth(dto.depth);
    await this.reapStaleSlot(hostId);

    const driver = await this.run(() => this.factory.forHost(hostId, userId));
    let realPath: string;
    try {
      const validated = await this.guard.validate({ driver, userId, path: dto.root, intent: "read" });
      realPath = validated.realPath;
    } finally {
      await driver.dispose().catch(() => undefined);
    }

    // The newest finished scan of this root, kept alive until the new one
    // reaches DONE so the panel never goes blank while this scan runs.
    const previous = await this.prisma.diskScans.findFirst({
      where: { hostId, root: realPath, status: "DONE" },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });

    let created: { id: string };
    try {
      created = await this.prisma.diskScans.create({
        data: {
          hostId,
          root: realPath,
          depth,
          status: "RUNNING",
          // The unique index that makes "one scan per host at a time" a promise
          // the database keeps rather than a check this service performs.
          runningSlot: hostId,
          supersedesId: previous?.id ?? null,
        },
        select: { id: true },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two requests passed the check in the same tick. The database refused
      // the second, and the answer it gets is the same one it would have got
      // had it arrived a moment later.
      throw await this.alreadyRunning(hostId);
    }

    this.queue.enqueue({ id: created.id, hostId, userId, root: realPath, realPath, depth });
    return this.view(await this.load(userId, created.id));
  }

  /**
   * The panel's whole payload: the newest finished scan of a root, whatever is
   * running, and one level of the treemap.
   *
   * `at` walks into the stored tree without a new scan — the levels are all in
   * the database, and drilling into one is an indexed read of a few dozen rows.
   */
  async state(userId: string, hostId: string, root: string, at?: string): Promise<ScanStateView> {
    await this.assertHost(userId, hostId);

    const scan = await this.prisma.diskScans.findFirst({
      where: { hostId, root, status: "DONE" },
      orderBy: { startedAt: "desc" },
    });
    const running = await this.prisma.diskScans.findFirst({
      where: { hostId, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });

    // Asked once and handed down, rather than per row: the predicate closes
    // over a single host lookup, and a level is a few dozen entries.
    const level = scan
      ? await this.level(
          scan.id,
          at ?? scan.root,
          scan.totalBytes ?? 0n,
          await this.guard.disclosableDenial(hostId, userId),
        )
      : null;

    return {
      scan: scan ? this.view(scan) : null,
      running: running ? this.view(running) : null,
      level,
    };
  }

  /**
   * Stop the scan running on this host.
   *
   * A scan still waiting in line has no runner to abort, so its terminal status
   * is written here — the runner would otherwise never touch the row and it
   * would sit `RUNNING` until a restart swept it.
   */
  async cancel(userId: string, hostId: string): Promise<ScanView> {
    await this.assertHost(userId, hostId);

    const running = await this.prisma.diskScans.findFirst({
      where: { hostId, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    if (!running) throw new NotFoundException("No scan is running on this host.");

    if (this.queue.cancel(running.id) !== "running") {
      await this.prisma.diskScans.update({
        where: { id: running.id },
        data: { status: "CANCELLED", finishedAt: new Date(), runningSlot: null },
      });
    }

    return this.view(await this.load(userId, running.id));
  }

  /** One treemap level, straight off its index. */
  private async level(
    scanId: string,
    at: string,
    total: bigint,
    denied: (realPath: string) => boolean,
  ): Promise<ScanLevelView> {
    const rows = await this.prisma.diskScanEntries.findMany({
      where: { scanId, parentPath: at },
      orderBy: { bytes: "desc" },
    });

    // The parent's own row carries the number the level sums to. Falling back
    // to the scan total covers the root, whose parentPath is the empty string.
    const parent = await this.prisma.diskScanEntries.findFirst({
      where: { scanId, path: at, kind: { not: "OTHER" } },
      select: { bytes: true },
    });

    return {
      at,
      parentBytes: (parent?.bytes ?? total).toString(),
      entries: rows.map((row) => {
        const entry: ScanEntryView = {
          path: row.path,
          bytes: row.bytes.toString(),
          percent: Number(row.percent),
          kind: row.kind,
          depth: row.depth,
        };
        // The stored path is already the resolved one — a scan is enqueued
        // with `realPath` — which is what the denylist is written in terms of.
        // Nothing to resolve here, and nothing to ask the host.
        if (denied(row.path)) entry.denied = true;
        return entry;
      }),
    };
  }

  /**
   * A RUNNING row older than the ceiling is one the boot sweep never got to —
   * a kill during shutdown, a crash mid-sweep. Left alone it holds the
   * `runningSlot` key and locks the host out of scanning permanently, which is
   * a bad way to find out that the sweep failed.
   */
  private async reapStaleSlot(hostId: string): Promise<void> {
    if (this.queue.isRunning(hostId)) return;
    await this.prisma.diskScans.updateMany({
      where: { hostId, status: "RUNNING", startedAt: { lt: new Date(Date.now() - STALE_RUNNING_AFTER_MS) } },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        runningSlot: null,
        error: "This scan was abandoned and has been cleared.",
      },
    });
  }

  /**
   * The 409 a second start gets, carrying the scan that is already running.
   *
   * Not a 202 returning the other scan: "start a scan of /var" answered with a
   * scan of /home would have the client drawing the wrong root under the right
   * label. Not a bare 409 either — the body is what lets the panel switch to
   * watching the live scan without a second request to find out what it is.
   */
  private async alreadyRunning(hostId: string): Promise<ConflictException> {
    const running = await this.prisma.diskScans.findFirst({
      where: { hostId, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    return new ConflictException({
      statusCode: 409,
      message: running
        ? `A scan of ${running.root} is already running on this host.`
        : "A scan is already running on this host.",
      scan: running ? this.view(running) : null,
    });
  }

  private async assertHost(userId: string, hostId: string): Promise<void> {
    const host = await this.prisma.hosts.findFirst({ where: { id: hostId, userId }, select: { id: true } });
    // A host that is not yours is a 404, never a 403 — the response must not
    // confirm the id exists.
    if (!host) throw new NotFoundException("Host not found");
  }

  private async load(userId: string, scanId: string): Promise<ScanRow> {
    const scan = await this.prisma.diskScans.findFirst({ where: { id: scanId, host: { userId } } });
    if (!scan) throw new NotFoundException("Scan not found");
    return scan;
  }

  private view(scan: ScanRow): ScanView {
    const ageSeconds = scan.finishedAt
      ? Math.max(0, Math.round((Date.now() - scan.finishedAt.getTime()) / 1000))
      : null;

    return {
      id: scan.id,
      hostId: scan.hostId,
      root: scan.root,
      depth: scan.depth,
      status: scan.status,
      flavour: scan.flavour,
      niced: scan.niced,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      ageSeconds,
      stale: ageSeconds !== null && ageSeconds > STALE_AFTER_SECONDS,
      staleAfterSeconds: STALE_AFTER_SECONDS,
      totalBytes: scan.totalBytes?.toString() ?? null,
      inodes: scan.inodes?.toString() ?? null,
      unreadableCount: scan.unreadableCount,
      truncated: scan.truncated,
      error: scan.error,
      facts: {
        largest:
          scan.largestPath !== null && scan.largestBytes !== null
            ? { path: scan.largestPath, bytes: scan.largestBytes.toString() }
            : null,
        oldFiles:
          scan.oldFileCount !== null && scan.oldFileBytes !== null && scan.oldFileBefore !== null
            ? {
                count: scan.oldFileCount.toString(),
                bytes: scan.oldFileBytes.toString(),
                before: scan.oldFileBefore,
              }
            : null,
        duplicates:
          scan.dupGroupsCandidate !== null
            ? {
                candidates: scan.dupGroupsCandidate,
                confirmed: scan.dupGroupsConfirmed ?? 0,
                skipped: scan.dupGroupsSkipped ?? 0,
                reclaimableBytes: (scan.dupReclaimableBytes ?? 0n).toString(),
              }
            : null,
      },
    };
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

/** The shape `view` reads. Declared rather than imported so the spec can build one. */
export interface ScanRow {
  id: string;
  hostId: string;
  root: string;
  depth: number;
  status: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  flavour: "GNU" | "PORTABLE" | "SUBTOTALS";
  niced: boolean;
  startedAt: Date;
  finishedAt: Date | null;
  totalBytes: bigint | null;
  inodes: bigint | null;
  unreadableCount: number;
  truncated: boolean;
  error: string | null;
  largestPath: string | null;
  largestBytes: bigint | null;
  oldFileCount: bigint | null;
  oldFileBytes: bigint | null;
  oldFileBefore: Date | null;
  dupGroupsCandidate: number | null;
  dupGroupsConfirmed: number | null;
  dupGroupsSkipped: number | null;
  dupReclaimableBytes: bigint | null;
}

/**
 * Depth is clamped rather than refused. The DTO already rejects a value outside
 * the range, so this is the default path and the belt-and-braces one at once.
 */
function clampDepth(depth: number | undefined): number {
  if (depth === undefined) return DEFAULT_DEPTH;
  return Math.min(MAX_DEPTH, Math.max(1, Math.trunc(depth)));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}
