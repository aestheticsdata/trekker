import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { ScanRunnerService } from "@scans/scan-runner.service";
import { MAX_SCANS_IN_FLIGHT } from "@scans/scan-limits";
import { CANCELLED_BY_SHUTDOWN, CANCELLED_BY_USER } from "@scans/scan-signals";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Which scans are running, and the only thing that can stop one (TRE-32).
 *
 * **This is not where "one scan per host" is enforced.** That is
 * `DiskScans.runningSlot`, a unique index, and it has to be: a field on a
 * singleton cannot survive a restart, and a check-then-insert spanning two Node
 * ticks is a race whose prize is two `du`s walking somebody's filesystem at
 * once. What lives here is the `AbortController` — which the database cannot
 * hold — and a process-wide cap.
 *
 * The cap is two rather than the transfers' three, and for a different reason
 * than theirs: a transfer is bounded by the network, while a scan spends real
 * CPU *on this box* parsing a few hundred megabytes of records. Two scans is
 * two record loops competing with every request the API is also serving.
 */

interface Running {
  scanId: string;
  hostId: string;
  controller: AbortController;
}

export interface QueuedScan {
  id: string;
  hostId: string;
  userId: string;
  root: string;
  realPath: string;
  depth: number;
}

@Injectable()
export class ScanQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScanQueueService.name);
  private readonly running = new Map<string, Running>();
  private readonly waiting: QueuedScan[] = [];
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: ScanRunnerService,
  ) {}

  /**
   * Clear what a restart interrupted.
   *
   * Scans left `RUNNING` are scans whose process died — nothing else can leave
   * one there, because a scan that ends writes its own terminal status. They
   * are **failed, not resumed**, which is where this parts company with
   * `TransferQueueService`. A transfer stopped halfway has moved bytes somebody
   * is waiting for and has bookkeeping designed to pick them up; a scan stopped
   * halfway has produced nothing at all, because entries are only ever written
   * in the terminal transaction. There is no state to reconcile, and resuming
   * would mean starting a fresh multi-minute walk on every host that had one
   * going, minutes after a deploy, with nobody having asked.
   *
   * The previous DONE scan of that root is untouched and still the newest one,
   * so the panel keeps showing it with its age. The restart is invisible except
   * that the scan somebody started did not finish, and the button is there.
   *
   * This sweep is **not optional housekeeping**: a stranded row holds the
   * `runningSlot` unique key and locks that host out of scanning until
   * something nulls it. Failures are logged and swallowed all the same — an API
   * that will not boot because it could not tidy up is worse at its job than
   * one that boots untidy, and the POST path has its own stale-slot escape.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const { count } = await this.prisma.diskScans.updateMany({
        where: { status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          runningSlot: null,
          error: "The API restarted while this scan was running.",
        },
      });
      if (count > 0) this.logger.log(`Cleared ${count} scan(s) stranded by a restart`);
    } catch (error) {
      this.logger.error(`Could not clear stranded scans: ${(error as Error).message}`);
    }
  }

  /**
   * Abort everything and write nothing.
   *
   * The rows stay `RUNNING`, which is exactly what `onApplicationBootstrap`
   * looks for. One code path for a deploy and for a `kill -9`, so the one that
   * matters is also the one that runs every time.
   */
  onModuleDestroy(): void {
    this.stopping = true;
    this.waiting.length = 0;
    for (const entry of this.running.values()) {
      entry.controller.abort(CANCELLED_BY_SHUTDOWN);
    }
  }

  /** Put a scan in line. Runs immediately when there is room. */
  enqueue(scan: QueuedScan): void {
    if (this.stopping) return;
    this.waiting.push(scan);
    this.pump();
  }

  /**
   * Stop one. Returns whether there was anything to stop — a scan still waiting
   * is dropped from the line, and the caller writes its terminal status, since
   * no runner ever touched it.
   */
  cancel(scanId: string): "running" | "waiting" | "unknown" {
    for (const entry of this.running.values()) {
      if (entry.scanId !== scanId) continue;
      entry.controller.abort(CANCELLED_BY_USER);
      return "running";
    }

    const index = this.waiting.findIndex((scan) => scan.id === scanId);
    if (index === -1) return "unknown";
    this.waiting.splice(index, 1);
    return "waiting";
  }

  /** Whether this host has a scan actually running in this process. */
  isRunning(hostId: string): boolean {
    return this.running.has(hostId);
  }

  private pump(): void {
    if (this.stopping) return;

    while (this.waiting.length > 0 && this.running.size < MAX_SCANS_IN_FLIGHT) {
      const next = this.waiting.findIndex((scan) => !this.running.has(scan.hostId));
      if (next === -1) return;
      const [scan] = this.waiting.splice(next, 1);
      this.start(scan);
    }
  }

  private start(scan: QueuedScan): void {
    const controller = new AbortController();
    this.running.set(scan.hostId, { scanId: scan.id, hostId: scan.hostId, controller });

    // Deliberately not awaited: `pump` is synchronous and this is where a scan
    // stops being the queue's problem. The runner never throws.
    void this.runner
      .run(scan, controller.signal)
      .catch((error: unknown) => {
        this.logger.error(`Scan ${scan.id} escaped the runner: ${(error as Error).message}`);
      })
      .finally(() => {
        this.running.delete(scan.hostId);
        this.pump();
      });
  }
}
