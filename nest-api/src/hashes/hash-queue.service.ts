import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { type HashJob, HashRunnerService } from "@hashes/hash-runner.service";
import { MAX_JOBS_IN_FLIGHT } from "@hashes/hash-limits";
import { CANCELLED_BY_SHUTDOWN, CANCELLED_BY_USER } from "@hashes/hash-signals";

/**
 * Which checksum jobs exist, and the only thing that can stop one (TRE-27).
 *
 * **This queue is the whole record of a job.** There is no `HashJobs` table
 * behind it, which is where it parts company with `ScanQueueService` and
 * `TransferQueueService` — both of those hold an `AbortController` for a row
 * the database owns, and both need a boot sweep to clear what a crash left
 * `RUNNING`.
 *
 * Nothing is left here. A hash job's output is one `FileHashes` row per file,
 * written as each file finishes, so a process that dies mid-job leaves a table
 * holding every digest it had earned and no row claiming work that is not
 * happening. There is nothing to reap, so there is no `onApplicationBootstrap`
 * — and its absence is a property of the shape rather than an omission.
 *
 * What is lost to a restart is the job: its progress feed stops, and whoever
 * was watching sees the stream go quiet. The recovery is to ask again, which
 * costs a click and re-reads only the files that had not finished. That is a
 * worse story than the transfers' resume and a much better one than the scans'
 * — and it is bought by writing per file, not by machinery.
 */

interface Running {
  job: HashJob;
  controller: AbortController;
}

export interface QueuedView {
  id: string;
  hostId: string;
  files: number;
  bytesTotal: bigint;
  /** Waiting for a slot rather than reading anything yet. */
  queued: boolean;
}

@Injectable()
export class HashQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(HashQueueService.name);
  private readonly running = new Map<string, Running>();
  private readonly waiting: HashJob[] = [];
  private stopping = false;

  constructor(private readonly runner: HashRunnerService) {}

  /**
   * Abort everything.
   *
   * The runner writes a terminal `CANCELLED` frame naming the shutdown, and
   * every digest already computed is already in the table. Nothing else to do:
   * no rows to leave for a sweep, because there are none.
   */
  onModuleDestroy(): void {
    this.stopping = true;
    this.waiting.length = 0;
    for (const entry of this.running.values()) {
      entry.controller.abort(CANCELLED_BY_SHUTDOWN);
    }
  }

  /**
   * Put a job in line, and say whether it had to wait.
   *
   * The answer is returned rather than assumed, because `pump` is synchronous:
   * a job enqueued when there is room is *already running* by the time this
   * returns, and a POST that answered "queued" regardless would tell the panel
   * a job is waiting for a slot at the moment it started reading.
   */
  enqueue(job: HashJob): QueuedView {
    if (this.stopping) {
      // Nothing will run it and nothing else will say so. Reported as waiting,
      // which is true right up until the process exits under it.
      return viewOf(job, true);
    }
    this.waiting.push(job);
    this.pump();
    return viewOf(job, !this.running.has(job.id));
  }

  /**
   * Stop one, if it belongs to this account.
   *
   * Ownership is checked here rather than by the caller, and the answer for a
   * job owned by somebody else is the answer for a job that does not exist. A
   * queue that said "not yours" would confirm the id is real, which is an
   * existence oracle over other people's work for the price of a guess.
   */
  cancel(userId: string, jobId: string): "running" | "waiting" | "unknown" {
    const entry = this.running.get(jobId);
    if (entry && entry.job.userId === userId) {
      entry.controller.abort(CANCELLED_BY_USER);
      return "running";
    }

    const index = this.waiting.findIndex((job) => job.id === jobId && job.userId === userId);
    if (index === -1) return "unknown";
    // Dropped from the line, and the caller says so: no runner ever touched it,
    // so nothing else will emit a terminal frame for it.
    this.waiting.splice(index, 1);
    return "waiting";
  }

  /**
   * The job that is going to hash this exact path, if there is one.
   *
   * What the inspector's "computing…" is drawn from on a cold load, before any
   * frame of the feed has arrived — a page reloaded mid-job would otherwise
   * show "not computed" for a file that is being read right now.
   *
   * Coverage, not "a job on this host": somebody hashing `/var/log` while
   * looking at `/etc/hosts` is not somebody who is about to be told the second
   * file's digest, and a panel that said "computing…" over it would be waiting
   * for a frame that is never coming.
   */
  covering(userId: string, hostId: string, path: string): QueuedView | null {
    for (const entry of this.running.values()) {
      if (matches(entry.job, userId, hostId, path)) return viewOf(entry.job, false);
    }
    for (const job of this.waiting) {
      if (matches(job, userId, hostId, path)) return viewOf(job, true);
    }
    return null;
  }

  private pump(): void {
    if (this.stopping) return;

    while (this.waiting.length > 0 && this.running.size < MAX_JOBS_IN_FLIGHT) {
      const job = this.waiting.shift();
      if (!job) return;
      this.start(job);
    }
  }

  private start(job: HashJob): void {
    const controller = new AbortController();
    this.running.set(job.id, { job, controller });

    // Deliberately not awaited: `pump` is synchronous and this is where a job
    // stops being the queue's problem. The runner never throws.
    void this.runner
      .run(job, controller.signal)
      .catch((error: unknown) => {
        this.logger.error(`Hash job ${job.id} escaped the runner: ${(error as Error).message}`);
      })
      .finally(() => {
        this.running.delete(job.id);
        this.pump();
      });
  }
}

function viewOf(job: HashJob, queued: boolean): QueuedView {
  return { id: job.id, hostId: job.hostId, files: job.targets.length, bytesTotal: job.bytesTotal, queued };
}

function matches(job: HashJob, userId: string, hostId: string, path: string): boolean {
  if (job.userId !== userId || job.hostId !== hostId) return false;
  return job.targets.some((target) => target.path === path);
}
