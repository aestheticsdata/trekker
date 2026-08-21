/**
 * Every bound a live tail runs under, in one table (TRE-34).
 *
 * The same habit as `scans/scan-limits.ts`: "what will a tail actually cost"
 * should be one file to read rather than a grep across six. These are not rate
 * limits — the rate limit is `LIMITS.tail` and it bounds how often somebody may
 * *open* one. These bound what one costs once it is open.
 *
 * The env overrides follow the house pattern and are deliberately **not** in
 * `env.validation.ts`, which lists only what the API refuses to boot without. A
 * tail with a mistyped poll interval should fall back to the default and run,
 * not stop the process from starting.
 */

/**
 * How often the poller asks the host how big the file is.
 *
 * Chosen against the ticket's own bar — "a line appears in the browser in under
 * two seconds, through nginx". One poll interval, plus one SFTP round trip,
 * plus nginx forwarding an unbuffered chunk, is comfortably inside two seconds
 * with margin for a slow link. Going faster buys nothing a reader can perceive
 * and multiplies the round trips; going slower starts eating the budget.
 *
 * 1.4 `stat` calls a second per tailed file is invisible load on any host that
 * is worth tailing.
 */
export const TAIL_POLL_MS = msFromEnv("TREKKER_TAIL_POLL_MS", 700);

/**
 * How long an entry outlives its last subscriber.
 *
 * The *source* stops immediately — that is the ticket's whole point, and there
 * is no grace period on it. This is how long the cheap half stays: the ring
 * buffer, the byte offset and the sequence number, with no process, no
 * connection and no timer but the reaper.
 *
 * Ten seconds is longer than `EventSource`'s default three-second retry with
 * room for one failed attempt, and short enough that a closed tab's state is
 * gone before anybody could look for it. Without it, a laptop lid closed and
 * reopened re-reads the tail of the file and shows the reader the same forty
 * lines a second time.
 */
export const TAIL_LINGER_MS = msFromEnv("TREKKER_TAIL_LINGER_MS", 10_000);

/**
 * Lines an entry keeps for replay.
 *
 * Matches the browser's own cap, deliberately: a reconnect can then restore
 * exactly what that client had rather than approximately, and the two numbers
 * drifting apart is how a gap marker appears where nothing was lost.
 */
export const TAIL_RING_LINES = 2_000;

/**
 * The longest single line the framer will emit, in bytes.
 *
 * Two failures this prevents, and they are different. A structured log that
 * writes one 2 GB JSON object on one line must not become a 2 GB string in this
 * process's heap. And a *binary* file with no newline in it at all must not
 * grow the carry without bound — which is the same failure arriving by a route
 * nobody plans for, because the path came from a picker that only offered log
 * files and somebody typed a URL instead.
 */
export const TAIL_MAX_LINE_BYTES = 8_192;

/**
 * Bytes that may sit in one subscriber's socket before it starts losing lines.
 *
 * The ticket's rule is that a backgrounded tab must never apply backpressure to
 * the reader, so this is the number that converts unbounded buffering into a
 * bounded drop. A quarter of a megabyte is a few thousand log lines: enough
 * that a tab briefly descheduled loses nothing at all, small enough that a
 * hundred abandoned-but-open sockets cost 25 MB rather than the process.
 */
export const TAIL_SUBSCRIBER_BUFFER_BYTES = bytesFromEnv("TREKKER_TAIL_CLIENT_BUFFER_BYTES", 256 * 1024);

/**
 * How far back the first read reaches for the opening screenful.
 *
 * A bounded read is the point: "give me the last 200 lines" has no byte answer
 * until the file has been read, so the poller reads a window off the end and
 * counts lines within it. 64 KiB is 200 lines of anything but the widest logs,
 * and the first line of the window is discarded as a fragment.
 */
export const TAIL_BACKFILL_BYTES = 65_536;

/** The opening line count when the client does not ask for one. */
export const TAIL_INITIAL_LINES_DEFAULT = 200;

/**
 * The most the client may ask for, and the DTO's bound.
 *
 * The ticket asks for the line count to be bounded and this is where. A
 * thousand lines is more scrollback than the strip can show without the
 * browser's own cap taking over anyway.
 */
export const TAIL_INITIAL_LINES_MAX = 1_000;

/**
 * Subscriptions one session may hold at once.
 *
 * Two panes times two tabs is the realistic ceiling of what one person watches.
 * Counted in *subscriptions*, not distinct files, so two tabs on one file cost
 * two: the cap governs what a session holds open, and sharing a process is an
 * efficiency this application performs, not an allowance it grants.
 */
export const MAX_TAILS_PER_SESSION = countFromEnv("TREKKER_TAIL_MAX_PER_SESSION", 4);

/**
 * Distinct files being tailed on one host at once, across every session.
 *
 * Counted in *entries*, so the sharing does count here. Six pollers is about
 * eight `stat` calls a second on that host, which is nothing — the number is
 * really a bound on how much of the interactive pool a tail may occupy at the
 * moment several of them happen to tick together.
 */
export const MAX_TAILS_PER_HOST = countFromEnv("TREKKER_TAIL_MAX_PER_HOST", 6);

/**
 * Consecutive failed ticks before the stream gives up and says so.
 *
 * Ten, which at the poll interval is about seven seconds of a host refusing to
 * answer. Fewer would end a tail over one dropped packet; more would leave a
 * dead stream looking alive for long enough to be believed.
 */
export const TAIL_MAX_CONSECUTIVE_ERRORS = 10;

/** Stderr kept from a LOCAL `tail`, for the error frame. */
export const TAIL_MAX_STDERR_BYTES = 4_096;

/**
 * How often the LOCAL path checks whether the file rotated under it.
 *
 * Only the exec path needs this. `tail -F` reopens by name on its own and says
 * nothing about it that reaches us — stderr is drained by the driver and never
 * handed out — so a cheap `stat` is what turns a rotation into something the
 * strip can mark. Locally the inode is always present, so this is exact rather
 * than heuristic.
 *
 * Faster than it needs to be for correctness and deliberately so: the marker is
 * only useful if it lands near the lines it separates, and a local `stat` is
 * too cheap to be worth rationing.
 */
export const TAIL_ROTATE_CHECK_MS = 1_000;

/**
 * The heartbeat, matching every other stream in this application.
 *
 * An idle stream is indistinguishable from a dead one to every proxy between
 * here and the browser, and a tail is idle by design most of the time — which
 * makes this the one feed where the heartbeat is load-bearing rather than
 * precautionary.
 */
export const TAIL_HEARTBEAT_MS = 20_000;

/**
 * Forces the polling source onto a LOCAL host.
 *
 * The poll path is what every real deployment runs, and without this it is the
 * one path a laptop cannot exercise — so the tests and `verify:tail` would only
 * ever prove the branch that almost nobody takes.
 */
export function forcePoll(): boolean {
  return process.env.TREKKER_TAIL_FORCE_POLL === "1";
}

function msFromEnv(variable: string, fallback: number): number {
  const override = Number.parseInt(process.env[variable] ?? "", 10);
  return Number.isNaN(override) || override < 100 ? fallback : override;
}

function countFromEnv(variable: string, fallback: number): number {
  const override = Number.parseInt(process.env[variable] ?? "", 10);
  return Number.isNaN(override) || override < 1 ? fallback : override;
}

function bytesFromEnv(variable: string, fallback: number): number {
  const override = Number.parseInt(process.env[variable] ?? "", 10);
  return Number.isNaN(override) || override < 1_024 ? fallback : override;
}
