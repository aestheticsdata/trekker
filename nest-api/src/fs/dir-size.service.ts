import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { LIMITS } from "@audit/limits";
import { RateLimitService } from "@audit/rate-limit.service";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { DU_SIZE_RUNGS, firstSizeRung, isNiceFailure, probeFlavour, shouldDemote } from "@scans/du-flavour";
import { SCAN_NICE } from "@scans/scan-limits";

/**
 * What a directory actually contains (TRE-107).
 *
 * The listing cannot answer this and should not try. `readdir` reports a
 * directory's own inode block — 4096, for an empty directory and for one
 * holding half a terabyte alike — and TRE-13 buys its 260 ms over ten thousand
 * entries precisely by never looking below a row. So the number arrives
 * afterwards, from `du`, over a stream the client can abandon.
 *
 * Deliberately not a method on `FsService`. `list` answers in milliseconds and
 * this does not answer in bounded time at all; sharing a service would mean
 * sharing a lifetime, and the only interesting thing about this one is that it
 * ends when the person navigates away.
 */

/** One directory's answer. Exactly one of `bytes` and `error` is present. */
export interface DirSizeFrame {
  name: string;
  bytes?: number;
  /**
   * `du` walked what it could and was refused somewhere below, so the figure is
   * a floor rather than the total. The client says so rather than presenting an
   * undercount as the answer.
   */
  partial?: boolean;
  /** Why there is no figure: `EACCES`, or `du` itself failing on this host. */
  error?: string;
}

export interface OpenDirSizesArgs {
  userId: string;
  hostId: string;
  path: string;
  /** Index of the first row the client has on screen, and how many. */
  firstVisible: number;
  visibleCount: number;
}

export interface DirSizeRun {
  /** Settles when every walk has finished, failed, or been abandoned. */
  done: Promise<void>;
  /** Kills every `du` still running and drops the rest of the queue. */
  cancel(): void;
}

export interface OpenedDirSizes {
  realPath: string;
  /** The directories that will be reported, in the order they were queued. */
  names: readonly string[];
  /**
   * Begins the walks.
   *
   * Separate from `open` so the caller can write its response headers first. A
   * `du` over a warm directory can answer in under a millisecond, and a frame
   * emitted before `writeHead` would make Express send its own headers — an SSE
   * stream that is not `text/event-stream`, failing at the client for a reason
   * nothing on this side would report.
   */
  start(emit: (frame: DirSizeFrame) => void): DirSizeRun;
}

/**
 * How many `du` processes one stream may have running.
 *
 * Four rather than one because independent subtrees walk independently, and IO
 * concurrency is where the wall-clock saving is — the same reason a parallel
 * disk-usage tool beats `du` without doing less work. Four rather than forty
 * because past a handful the spindle or the SSH channel is the limit and all
 * that grows is the load somebody else's server is carrying.
 */
export const DIR_SIZE_CONCURRENCY = 4;

/**
 * `du -s` prints one short line. This is not a budget, it is a refusal to keep
 * reading something that is no longer `du -s` output.
 */
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

/** Shared by every walk on one stream, so a demotion is learnt once. */
interface RungState {
  index: number;
  niced: boolean;
}

@Injectable()
export class DirSizeService {
  private readonly logger = new Logger(DirSizeService.name);

  constructor(
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly limits: RateLimitService,
  ) {}

  /**
   * Everything that can refuse happens here, before the caller writes a header:
   * the rate limit, the roots guard, and the `readdir` that says whether the
   * directory can be read at all. After this returns, the only way to report a
   * problem is a frame on a response that already said 200.
   */
  async open(args: OpenDirSizesArgs): Promise<OpenedDirSizes> {
    // Named at the call site, not passed as a variable: `audit-coverage.spec.ts`
    // tells an enforced limit from a mentioned one by matching `consume(LIMITS.x`.
    const verdict = await this.limits.consume(LIMITS.dirSizes, args.userId);
    if (!verdict.allowed) {
      throw new HttpException(
        RateLimitService.describe(LIMITS.dirSizes, verdict.resetSeconds),
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const driver = await this.factory.forHost(args.hostId, args.userId);
    if (!driver.execStream) {
      throw new HttpException(
        "This host's driver cannot run a command, so directory sizes are not available for it.",
        HttpStatus.NOT_IMPLEMENTED,
      );
    }

    const validated = await this.guard.validate({
      driver,
      userId: args.userId,
      path: args.path,
      intent: "read",
    });

    // Re-read rather than take the names from the client. The client has them —
    // it is looking at them — but a name on the wire is a second path source
    // that the guard has not seen, and this is one `readdir` against a
    // directory it has already cleared.
    const entries = await driver.list(validated.realPath);
    const names = entries.filter((entry) => entry.kind === "directory").map((entry) => entry.name);
    const ordered = visibleFirst(names, args.firstVisible, args.visibleCount);

    return {
      realPath: validated.realPath,
      names: ordered,
      start: (emit) => {
        const controller = new AbortController();
        return {
          done: this.drain(driver, validated.realPath, ordered, emit, controller.signal),
          cancel: () => controller.abort(),
        };
      },
    };
  }

  /** A fixed pool pulling from one shared cursor. */
  private async drain(
    driver: HostDriver,
    realPath: string,
    names: readonly string[],
    emit: (frame: DirSizeFrame) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (names.length === 0) return;

    const probe = await probeFlavour(driver);
    const rungs: RungState = { index: firstSizeRung(probe), niced: true };
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return;
        const index = cursor++;
        if (index >= names.length) return;

        const name = names[index];
        try {
          const frame = await this.sizeOf(driver, posix.join(realPath, name), rungs, signal);
          if (signal.aborted) return;
          emit({ name, ...frame });
        } catch (error) {
          // An abandoned walk is not a failure worth reporting to a client that
          // has already gone.
          if (signal.aborted) return;
          this.logger.debug(`du -s failed for ${name}: ${String(error)}`);
          emit({ name, error: "EIO" });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(DIR_SIZE_CONCURRENCY, names.length) }, worker));
  }

  /**
   * One directory, one `du -s`.
   *
   * The rung and the `nice` prefix are both negotiated the way a scan
   * negotiates them, and for the same reasons — see `du-flavour.ts`. What
   * differs is what a non-zero exit means. `du` answers 1 both when it walked
   * everything and when it was refused a subtree, so the exit code alone cannot
   * tell a total from a floor. Standard output can:
   *
   *   $ du -s locked            # a subtree below it is unreadable
   *   du: locked/inner: Permission denied
   *   0    locked               # ... and a figure is still printed
   *
   *   $ du -s locked            # the directory itself is unreadable
   *   du: locked: Permission denied
   *                             # ... and nothing is
   *
   * So a figure on stdout is an answer, qualified by the exit code, and no
   * figure is an error. Nothing here has to guess from the wording of stderr.
   */
  private async sizeOf(
    driver: HostDriver,
    target: string,
    rungs: RungState,
    signal: AbortSignal,
  ): Promise<Omit<DirSizeFrame, "name">> {
    for (;;) {
      const rung = DU_SIZE_RUNGS[rungs.index];

      // Checked in `open`; re-checked rather than asserted, because a non-null
      // assertion here would be a claim about a caller this method cannot see.
      if (!driver.execStream) return { error: "ENOSYS" };

      const running = await driver.execStream("du", [...rung.args, target], {
        signal,
        nice: rungs.niced ? SCAN_NICE : undefined,
        maxStderrBytes: MAX_STDERR_BYTES,
      });

      const stdout = await collect(running.stdout);
      const result = await running.done;
      if (signal.aborted) return {};

      // `nice` missing from the host, rather than anything about `du`. Drop the
      // prefix for every walk on this stream and run this one again.
      if (stdout.trim() === "" && rungs.niced && isNiceFailure(result.code)) {
        rungs.niced = false;
        continue;
      }

      if (
        shouldDemote({ code: result.code, stdout, stderr: result.stderr }) &&
        rungs.index + 1 < DU_SIZE_RUNGS.length
      ) {
        rungs.index += 1;
        continue;
      }

      const figure = leadingInteger(stdout);
      if (figure === null) return { error: refusalOf(result.stderr) };

      const bytes = figure * rung.unitBytes;
      return result.code === 0 ? { bytes } : { bytes, partial: true };
    }
  }
}

/**
 * The rows on screen first, then everything else in listing order.
 *
 * The pane is virtualised, so "on screen" is about forty rows out of however
 * many the directory holds — this is what puts the first answers where the eye
 * already is. The rest still runs: sorting by size and the footer total both
 * need every row, so the queue drains rather than stopping at the fold.
 */
export function visibleFirst(names: readonly string[], firstVisible: number, visibleCount: number): string[] {
  const from = Math.max(0, Math.min(firstVisible, names.length));
  const to = Math.max(from, Math.min(from + Math.max(0, visibleCount), names.length));
  return [...names.slice(from, to), ...names.slice(0, from), ...names.slice(to)];
}

/**
 * `du -s` prints `<figure>\t<path>`, and only the figure is wanted.
 *
 * Reading it off the front is what makes the record safe without `-0`: the
 * number is complete before any part of the name has been looked at, so a
 * directory called `"1\n999999"` cannot become an answer.
 */
export function leadingInteger(stdout: string): number | null {
  const match = /^\s*(\d+)/.exec(stdout);
  if (match === null) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** What to call a refusal, from what `du` said about it. */
export function refusalOf(stderr: string): string {
  if (/permission denied/i.test(stderr)) return "EACCES";
  if (/no such file|cannot access/i.test(stderr)) return "ENOENT";
  if (/not a directory/i.test(stderr)) return "ENOTDIR";
  return "EIO";
}

/** One short line, read to the end so the process is never left blocked on a full pipe. */
async function collect(stdout: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdout) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAX_STDOUT_BYTES) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
