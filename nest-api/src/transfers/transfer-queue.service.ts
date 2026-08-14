import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { CANCELLED_BY_SHUTDOWN, CANCELLED_BY_USER } from "@transfers/transfer-signals";
import { TransferRunnerService } from "@transfers/transfer-runner.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * How many transfers actually run, and when (TRE-23 §1, §6).
 *
 * Two caps, answering two different questions, and neither is a rate limit —
 * `LIMITS.transferJobs` is the rate limit and its comment says why these are not
 * expressible as one.
 *
 * **How many at once**, so a person who queues six directories gets the first
 * one finishing rather than six crawling. **How many touching one host**, so a
 * transfer never takes every slot in that host's SSH pool: the pool is six
 * connections wide and a running job holds one at each end, so two jobs on a
 * host still leave four for the browsing that person is doing while they wait.
 *
 * The queue is a field on a singleton, which is a statement about deployment:
 * this API runs as one process. Two would each keep their own count and the cap
 * would be whatever number times two — see `TransferEventsService`, which makes
 * the same assumption for the same reason and would need the same fix.
 */

const DEFAULT_IN_FLIGHT = 3;
const DEFAULT_PER_HOST = 2;

export function maxInFlight(): number {
  const override = Number.parseInt(process.env.TREKKER_TRANSFERS_IN_FLIGHT ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_IN_FLIGHT : override;
}

export function maxPerHost(): number {
  const override = Number.parseInt(process.env.TREKKER_TRANSFERS_PER_HOST ?? "", 10);
  return Number.isNaN(override) || override < 1 ? DEFAULT_PER_HOST : override;
}

interface Waiting {
  id: string;
  hosts: readonly string[];
}

@Injectable()
export class TransferQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TransferQueueService.name);
  private readonly waiting: Waiting[] = [];
  private readonly running = new Map<string, { controller: AbortController; hosts: readonly string[] }>();
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: TransferRunnerService,
  ) {}

  /**
   * Pick up what a restart interrupted (TRE-23 §1).
   *
   * Jobs left in `RUNNING` are jobs whose process died — nothing else can leave
   * one there, because a job that ends writes its own terminal status. Their
   * in-flight items go back to `PENDING` and the job re-enters the queue.
   *
   * Restarting an item rather than resuming it is the whole reason the runner
   * writes to a `.part` and renames: an interrupted item left nothing under its
   * real name, so re-running it from the top is safe and needs no bookkeeping
   * about how far it got. What it does leave is a hidden `.part` file, which is
   * named so that anyone who finds one knows what it is.
   *
   * Failures here are logged and swallowed. An API that will not boot because
   * it could not reclaim a transfer is worse at its job than one that boots
   * without the transfer.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const stranded = await this.prisma.transferJobs.findMany({
        where: { status: { in: ["RUNNING", "QUEUED"] } },
        select: { id: true, srcHostId: true, dstHostId: true, status: true },
        orderBy: { createdAt: "asc" },
      });
      if (stranded.length === 0) return;

      await this.prisma.transferItems.updateMany({
        where: { jobId: { in: stranded.map((job) => job.id) }, status: "RUNNING" },
        data: { status: "PENDING" },
      });

      const interrupted = stranded.filter((job) => job.status === "RUNNING").length;
      this.logger.log(
        `Reclaiming ${stranded.length} transfer(s) after a restart` +
          (interrupted > 0 ? `, ${interrupted} of which were mid-flight` : ""),
      );

      for (const job of stranded) {
        this.enqueue(job.id, [job.srcHostId, job.dstHostId]);
      }
    } catch (error) {
      this.logger.error(`Could not reclaim interrupted transfers: ${(error as Error).message}`);
    }
  }

  /**
   * Stop feeding the queue and let the running jobs be picked up next boot.
   *
   * Aborted with the shutdown reason, which the runner reads: their rows stay
   * `RUNNING`, which is exactly the state `onApplicationBootstrap` looks for.
   * A deploy is not a decision to abandon somebody's transfer.
   */
  onModuleDestroy(): void {
    this.stopping = true;
    this.waiting.length = 0;
    for (const [id, entry] of this.running) {
      entry.controller.abort(CANCELLED_BY_SHUTDOWN);
      this.logger.log(`Transfer ${id} left running for the next boot to reclaim`);
    }
  }

  /** Put a job in line. Runs immediately when there is room. */
  enqueue(jobId: string, hosts: ReadonlyArray<string | null>): void {
    if (this.stopping) return;
    if (this.running.has(jobId) || this.waiting.some((entry) => entry.id === jobId)) return;

    this.waiting.push({ id: jobId, hosts: hosts.filter((host): host is string => host !== null) });
    this.pump();
  }

  /**
   * Stop one. Returns whether there was anything to stop — a job still waiting
   * is simply dropped from the line, and one that has already finished is not
   * this service's to answer for.
   */
  cancel(jobId: string): "running" | "waiting" | "unknown" {
    const entry = this.running.get(jobId);
    if (entry) {
      entry.controller.abort(CANCELLED_BY_USER);
      return "running";
    }

    const index = this.waiting.findIndex((candidate) => candidate.id === jobId);
    if (index === -1) return "unknown";
    this.waiting.splice(index, 1);
    return "waiting";
  }

  /** For the controller, so a queued job's position is not a lie. */
  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  /**
   * Start whatever fits. Called after every enqueue and after every finish, so
   * a slot never sits idle while something is waiting for it.
   *
   * Scans the whole line rather than only its head: the job at the front may be
   * blocked by its host's cap while the one behind it touches two idle
   * machines, and refusing to look past the head would idle the server on
   * behalf of a queue position nobody can see.
   */
  private pump(): void {
    if (this.stopping) return;

    const inFlight = maxInFlight();
    const perHost = maxPerHost();

    for (let index = 0; index < this.waiting.length && this.running.size < inFlight;) {
      const candidate = this.waiting[index];
      if (candidate.hosts.some((host) => this.countOn(host) >= perHost)) {
        index += 1;
        continue;
      }

      this.waiting.splice(index, 1);
      this.start(candidate);
    }
  }

  private countOn(host: string): number {
    let count = 0;
    for (const entry of this.running.values()) {
      if (entry.hosts.includes(host)) count += 1;
    }
    return count;
  }

  private start(job: Waiting): void {
    const controller = new AbortController();
    this.running.set(job.id, { controller, hosts: job.hosts });

    // Deliberately not awaited: `pump` is synchronous and this is the point at
    // which a job stops being the queue's problem. The runner never throws.
    void this.runner
      .run(job.id, controller.signal)
      .catch((error: unknown) => {
        this.logger.error(`Transfer ${job.id} escaped the runner: ${(error as Error).message}`);
      })
      .finally(() => {
        this.running.delete(job.id);
        this.pump();
      });
  }
}
