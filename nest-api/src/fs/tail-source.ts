import { DriverError, isDriverError } from "@hosts/drivers/driver-error";
import type { ExecStream, FileStat, HostDriver } from "@hosts/drivers/host-driver";
import { LineFramer } from "@fs/tail-lines";
import {
  TAIL_BACKFILL_BYTES,
  TAIL_MAX_CONSECUTIVE_ERRORS,
  TAIL_MAX_STDERR_BYTES,
  TAIL_POLL_MS,
  TAIL_ROTATE_CHECK_MS,
} from "@fs/tail-limits";

/**
 * The two ways to follow a file (TRE-34 §1), behind one interface.
 *
 * **Over SSH there is no remote process, and that is the ticket.** `SshDriver`
 * documents the reason at its abort path: OpenSSH's sshd does not implement the
 * RFC 4254 signal request, so the only kill available is closing the channel,
 * and a `tail -F` on a quiet log takes SIGPIPE *the next time it writes* —
 * which for a quiet log is never. Four of the ticket's acceptance criteria are
 * about a process that must not survive the tab, and no arrangement of
 * `execStream` over SSH can satisfy them.
 *
 * Worse than the orphan: `execStream` borrows a **background** pool lease, and
 * background work gets `maxConcurrency - RESERVED_INTERACTIVE` — four slots per
 * (host, user). Four abandoned tails is the ceiling, and the fifth borrower
 * queues on a waiting list that `ssh-connection.pool.ts` documents as having no
 * timeout. Four quiet logs would permanently wedge every disk scan on the host.
 *
 * So the remote path polls `stat` and reads the byte delta through SFTP: brief
 * *interactive* leases, milliseconds each, and nothing to leave behind. What it
 * costs is one poll interval of latency, which the ticket's own two-second bar
 * has ample room for. See the design note for the `timeout`-prefix option and
 * why it lost.
 *
 * The exec path is kept for LOCAL hosts, where `spawn({ signal })` is a real
 * SIGTERM to a real pid, and it is genuinely better there: no polling, no
 * interval, and the kernel does the waiting.
 */

export interface TailSink {
  onLines(lines: string[], truncated: number): void;
  onRotated(): void;
  /** `fatal` ends the stream; anything else is reported and the tail continues. */
  onError(message: string, fatal: boolean): void;
}

export interface TailSourceArgs {
  driver: HostDriver;
  realPath: string;
  initialLines: number;
  /** Bytes already delivered to this entry, when an entry is being resumed. */
  resumeFrom: number | null;
  signal: AbortSignal;
  sink: TailSink;
}

export interface TailSource {
  readonly kind: "tail" | "poll";
  /** Never throws. Failures arrive on the sink, because the stream is open. */
  start(): void;
  /** Bytes consumed so far, so a reconnect inside the linger resumes exactly. */
  readonly offset: number;
}

/**
 * `stat` the file, read what is new. The path every SSH host takes.
 *
 * Ticks are **non-overlapping** — a `running` flag, and the next tick scheduled
 * from the end of the previous one rather than by `setInterval`. On a link
 * slower than the interval a `setInterval` stacks reads and delivers lines out
 * of order, which is the one corruption a log viewer must not have.
 */
export class PollTailSource implements TailSource {
  readonly kind = "poll";

  private readonly framer = new LineFramer();
  private timer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;
  private missing = false;
  private inode: number | null = null;
  private started = false;

  offset = 0;

  constructor(private readonly args: TailSourceArgs) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.args.signal.addEventListener("abort", () => this.stop(), { once: true });
    void this.backfill();
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.args.signal.aborted) return;
    this.timer = setTimeout(() => void this.tick(), TAIL_POLL_MS);
    // The process must not be held open by a poll loop.
    this.timer.unref();
  }

  /**
   * The opening screenful.
   *
   * "The last N lines" has no byte answer until something has read the file, so
   * a bounded window off the end is read and lines are counted within it. The
   * first line of that window is discarded whenever the window did not start at
   * byte zero — it is the back half of a line, and showing it would put a
   * fragment at the top of every tail of a large file.
   */
  private async backfill(): Promise<void> {
    try {
      const stat = await this.args.driver.stat(this.args.realPath);
      this.inode = stat.inode ?? null;

      // A resume inside the linger window: the client already has everything up
      // to here, and re-reading would show it the same lines twice.
      if (this.args.resumeFrom !== null && this.args.resumeFrom <= stat.size) {
        this.offset = this.args.resumeFrom;
        this.schedule();
        return;
      }

      const start = Math.max(0, stat.size - TAIL_BACKFILL_BYTES);
      this.offset = stat.size;

      if (stat.size > 0) {
        const framed = await this.read(start, stat.size - 1);
        const whole = start > 0 ? framed.slice(1) : framed;
        const kept = whole.slice(-this.args.initialLines);
        if (kept.length > 0) this.emit(kept);
      }
    } catch (error) {
      this.fail(error);
    }
    this.schedule();
  }

  private async tick(): Promise<void> {
    if (this.args.signal.aborted) return;

    try {
      const stat = await this.args.driver.stat(this.args.realPath);
      this.consecutiveErrors = 0;

      if (this.missing) {
        // The replacement has appeared. Start from its beginning.
        this.missing = false;
        this.offset = 0;
        this.inode = stat.inode ?? null;
        this.framer.reset();
      }

      if (this.rotated(stat)) {
        this.args.sink.onRotated();
        this.offset = 0;
        this.inode = stat.inode ?? null;
        this.framer.reset();
      }

      if (stat.size > this.offset) {
        const framed = await this.read(this.offset, stat.size - 1);
        this.offset = stat.size;
        if (framed.length > 0) this.emit(framed);
      }
    } catch (error) {
      if (isDriverError(error) && error.code === "ENOENT") {
        // Rotated away and the replacement not yet created. Announce it once,
        // then keep looking: `-F` is in the ticket precisely so that a log
        // rotating at midnight does not silently stop updating.
        if (!this.missing) {
          this.missing = true;
          this.framer.reset();
          this.args.sink.onRotated();
        }
      } else {
        this.fail(error);
      }
    }

    this.schedule();
  }

  /**
   * Whether what we are reading is no longer what we were reading.
   *
   * **Two tests, and it has to be both rather than whichever is available.**
   * The inode catches `create` mode — `logrotate` renames the file away and
   * makes a new one, and if the replacement grows past the old offset before
   * the next tick the inode is the only thing that changed. The size catches
   * `copytruncate`, where the file is emptied *in place*: same inode, so an
   * inode test alone reports no rotation at all, and the next read then takes a
   * byte range from the middle of a file that has started again at zero and
   * renders half a line as though it were a line.
   *
   * An earlier version preferred the inode when the stat carried one and fell
   * back to the size otherwise. That arrangement misses every `copytruncate` on
   * every host that reports an inode — which is every local host — and
   * `verify:tail` is what said so.
   *
   * SFTP v3 has no attribute for an inode, so a remote host has only the second
   * test, and there both modes share one limit: a rotation is seen when the
   * file is smaller than the old offset **at the moment we next look**. At a
   * 700 ms interval that holds unless the log is rewritten past its entire
   * previous length inside one tick — which for a file anybody bothers to
   * rotate is a great deal of traffic. `tail-source.spec.ts` pins that window
   * as a known shape rather than leaving it to be discovered.
   */
  private rotated(stat: FileStat): boolean {
    if (stat.inode !== undefined && this.inode !== null && stat.inode !== this.inode) return true;
    return stat.size < this.offset;
  }

  private async read(start: number, end: number): Promise<string[]> {
    const stream = await this.args.driver.createReadStream(this.args.realPath, { start, end });
    const lines: string[] = [];
    let truncated = 0;

    try {
      for await (const chunk of stream) {
        for (const line of this.framer.push(chunk as Buffer)) {
          lines.push(line.text);
          if (line.truncated) truncated += 1;
        }
      }
    } finally {
      // Releases the SFTP lease whether the read finished or the signal fired.
      stream.destroy();
    }

    this.lastTruncated = truncated;
    return lines;
  }

  private lastTruncated = 0;

  private emit(lines: string[]): void {
    this.args.sink.onLines(lines, this.lastTruncated);
    this.lastTruncated = 0;
  }

  /**
   * A failed tick is reported and survived; a run of them ends the stream.
   *
   * Ending on the first one would kill a tail over a single dropped packet.
   * Never ending would leave a dead stream looking alive for long enough that
   * somebody reads "no new lines" as "nothing is happening on the server".
   */
  private fail(error: unknown): void {
    this.consecutiveErrors += 1;
    const message = isDriverError(error) ? error.message : "The file could not be read.";
    const fatal = this.consecutiveErrors >= TAIL_MAX_CONSECUTIVE_ERRORS;
    this.args.sink.onError(fatal ? `${message} Giving up after repeated failures.` : message, fatal);
    if (fatal) this.stop();
  }
}

/**
 * A real `tail -n N -F`. LOCAL hosts only.
 *
 * `-F` rather than `-f` because it is `--follow=name --retry`: it reopens the
 * path after a rotation instead of following an unlinked inode forever, which
 * is the classic bug this ticket names. `--` guards a path beginning with `-`;
 * paths arrive from the guard already absolute, so it is defence in depth
 * matching the posture `shell-quote.ts` takes everywhere else.
 */
export class ExecTailSource implements TailSource {
  readonly kind = "tail";

  private readonly framer = new LineFramer();
  private stream: ExecStream | null = null;
  private rotateTimer: NodeJS.Timeout | null = null;
  private inode: number | null = null;
  private size: number | null = null;
  private started = false;

  offset = 0;

  constructor(private readonly args: TailSourceArgs) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.run();
  }

  private async run(): Promise<void> {
    const { driver, realPath, initialLines, resumeFrom, signal, sink } = this.args;

    if (typeof driver.execStream !== "function") {
      sink.onError("This host's driver cannot stream a command.", true);
      return;
    }

    // `tail -c +N` starts at byte N, one-indexed, so a resume is exact rather
    // than a re-read of the last screenful.
    const args =
      resumeFrom !== null
        ? ["-c", `+${resumeFrom + 1}`, "-F", "--", realPath]
        : ["-n", String(initialLines), "-F", "--", realPath];

    try {
      this.stream = await driver.execStream("tail", args, { signal, maxStderrBytes: TAIL_MAX_STDERR_BYTES });
    } catch (error) {
      sink.onError(isDriverError(error) ? error.message : "The tail could not be started.", true);
      return;
    }

    this.offset = resumeFrom ?? 0;
    this.watchRotation();

    // A pool eviction — host deleted, credential changed — rejects `done`. Left
    // alone that is an unhandled rejection at shutdown.
    void this.stream.done
      .then((result) => {
        if (signal.aborted) return;
        const detail = result.stderr.trim();
        sink.onError(detail.length > 0 ? detail : "The tail ended.", true);
      })
      .catch(() => {
        if (!signal.aborted) sink.onError("The connection dropped while following the file.", true);
      });

    signal.addEventListener("abort", () => this.stop(), { once: true });

    try {
      // Drained unconditionally, and this is not optional: stdout is a pipe, so
      // a reader that stops reading blocks the child in `write(2)`. Backpressure
      // belongs at the subscriber, never at the source.
      for await (const chunk of this.stream.stdout) {
        const buffer = chunk as Buffer;
        this.offset += buffer.length;
        let truncated = 0;
        const lines: string[] = [];
        for (const line of this.framer.push(buffer)) {
          lines.push(line.text);
          if (line.truncated) truncated += 1;
        }
        if (lines.length > 0) sink.onLines(lines, truncated);
      }
    } catch {
      // The channel went away. `done` above carries the reason.
    }
  }

  /**
   * `tail -F` reopens by name on its own and says nothing about it that reaches
   * us — stderr is drained by the driver and never handed out — so the rotation
   * is announced by comparing inodes. Locally the inode is always present, so
   * this is exact.
   */
  private watchRotation(): void {
    const check = async (): Promise<void> => {
      if (this.args.signal.aborted) return;
      try {
        const stat = await this.args.driver.stat(this.args.realPath);
        // Both tests, for the reason `PollTailSource.rotated` gives at length:
        // a `copytruncate` keeps the inode, so an inode test alone never
        // reports the commonest rotation there is. The two sources have to
        // announce the same events, or the strip's marker means one thing on a
        // local host and something else on a remote one.
        const replaced = this.inode !== null && stat.inode !== undefined && stat.inode !== this.inode;
        const emptied = this.size !== null && stat.size < this.size;
        if (replaced || emptied) {
          this.framer.reset();
          this.args.sink.onRotated();
        }
        if (stat.inode !== undefined) this.inode = stat.inode;
        this.size = stat.size;
      } catch {
        // Mid-rotation the path is briefly absent. `-F` is already retrying.
      }
      this.rotateTimer = setTimeout(() => void check(), TAIL_ROTATE_CHECK_MS);
      this.rotateTimer.unref();
    };

    void check();
  }

  private stop(): void {
    if (this.rotateTimer !== null) clearTimeout(this.rotateTimer);
    this.rotateTimer = null;
  }
}

/**
 * Which source this host gets.
 *
 * A runtime answer rather than a configuration one, in both directions: a
 * driver that cannot stream, or a host with no `tail` on it, falls to the
 * poller without anybody having to know in advance — which is the ticket's
 * "or by polling `stat` … when `tail` is unavailable", arrived at by asking.
 */
export function isExecCapable(driver: HostDriver): boolean {
  return typeof driver.execStream === "function";
}

export function unreachable(message: string): DriverError {
  return new DriverError("EUNREACHABLE", message);
}
