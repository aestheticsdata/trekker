/**
 * Every bound a disk scan runs under, in one table (TRE-32).
 *
 * The same habit as `audit/limits.ts`, applied to a service rather than to a
 * route: "what will a scan actually do to this machine" should be one file to
 * read rather than a grep across five. These are not rate limits — the rate
 * limit is `LIMITS.diskScan` and it bounds how often somebody may *start* one.
 * These bound what one costs once it is running.
 *
 * Every bound here has a counter beside it in the aggregator, and every counter
 * reaches the response. A bound that bites silently would turn "the biggest
 * consumers on this disk" into "the biggest consumers we happened to keep",
 * with nothing in the answer to say which one you are reading.
 */

/** Levels of the tree that are persisted. See `DiskScans.depth`. */
export const DEFAULT_DEPTH = 3;

/**
 * The deepest a scan will store.
 *
 * Not a limit on the walk, which is always full depth. Five levels of a treemap
 * is already more rectangles than anyone reads, and the honest way to go deeper
 * is to scan the subdirectory as its own root — which is one click and one
 * `du` that actually answers about that subtree.
 */
export const MAX_DEPTH = 5;

/**
 * Rectangles kept per parent before the rest becomes "other".
 *
 * A treemap level stops being readable somewhere around twenty: past that the
 * rectangles are thinner than their labels. Twenty-four leaves room for the
 * client to drop a few and still have a full-looking level.
 */
export const TOP_PER_PARENT = 24;

/**
 * A child under this share of the scan total is "other" whatever its rank.
 *
 * Without it, a directory holding four hundred tiny subdirectories spends its
 * whole top-K budget on rectangles that round to nothing, and the one child
 * worth seeing is squeezed between them.
 */
export const MIN_CHILD_SHARE = 0.001;

/**
 * Parents the aggregator will track at once.
 *
 * A tree wide enough to exceed this is a tree whose treemap was never going to
 * be read; past the ceiling, new parents fold into the nearest tracked ancestor
 * and `truncated` is set.
 */
export const MAX_PARENTS = 20_000;

/** Hard ceiling on rows written for one scan, whatever the shape of the tree. */
export const MAX_ENTRIES = 20_000;

/**
 * Rows per `createMany`. The same number `TransferService` uses for its items,
 * for the same reason: large enough that the round trips do not dominate, small
 * enough that one statement is not a megabyte of SQL.
 */
export const ENTRY_BATCH = 500;

/** DONE scans kept per (host, root) before the oldest is dropped. */
export const KEEP_SCANS_PER_ROOT = 3;

// ---------------------------------------------------------------- the facts

/** A year, as the "older than" fact means it. */
export const OLD_FILE_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Files smaller than this are never considered as duplicates.
 *
 * The load-bearing bound of the whole duplicate pass. Most inodes on any real
 * filesystem are small, and a duplicate worth reporting is one whose removal
 * gives something back — reclaiming forty kilobytes is not a finding. Indexing
 * only the big ones is what keeps the size map at tens of megabytes on a tree
 * with ten million files in it.
 */
export const MIN_DUP_BYTES = 1024n * 1024n;

/** Distinct sizes tracked. On overflow, stop inserting; never evict. */
export const MAX_SIZE_KEYS = 200_000;

/** Paths remembered per size. A size shared by thousands is not a duplicate. */
export const MAX_PATHS_PER_SIZE = 32;

/** Groups actually hashed, largest reclaimable first. The rest stay candidates. */
export const MAX_DUP_GROUPS = 200;

/** A single file larger than this is not hashed: reading it costs more than the answer. */
export const MAX_HASH_BYTES = 2n * 1024n * 1024n * 1024n;

/** Total bytes the hash pass may read before it stops and reports what it has. */
export const HASH_BUDGET_BYTES = 20n * 1024n * 1024n * 1024n;

/**
 * The two argv bounds on a `sha256sum` call are **not here**, and this note is
 * the pointer that says so (TRE-27).
 *
 * They were, until checksum jobs became a second caller of the same command.
 * `MAX_ARGS_PER_CALL` and `MAX_ARGV_BYTES` now live in `@hosts/sha256-sum`
 * beside the chunker that applies them, because they are a fact about what a
 * command line will carry rather than a fact about what a disk scan may cost —
 * which is what everything else in this file is. A scan-specific copy would be
 * a second number to keep in step with the same `ARG_MAX`.
 */

// ---------------------------------------------------------------- the run

/**
 * How de-prioritised the remote walk runs. Fifteen of a possible nineteen:
 * clearly out of the way, without being the "only when nothing else wants the
 * CPU" of nineteen, which on a busy host is a scan that never finishes.
 *
 * Worth saying plainly, because the ticket asks for it and it is half true:
 * `du` is IO-bound and CPU niceness does not ration IO. What actually keeps a
 * host responsive under a scan is one scan at a time and the pool's reserved
 * interactive slots. This makes the parsing and the process scheduling polite;
 * it does not make the disk reads polite.
 */
export const SCAN_NICE = 15;

/** How often the progress feed emits while a scan runs. */
export const PROGRESS_TICK_MS = 700;

/**
 * When a finished scan starts being labelled stale.
 *
 * A day. Not a guess about how fast disks fill — a guess about how long a
 * number can be presented as current before somebody acts on it wrongly. The
 * threshold travels to the client alongside the flag, so the panel says "stale"
 * without hardcoding a policy the server owns.
 */
export const STALE_AFTER_SECONDS = hoursFromEnv("TREKKER_SCAN_STALE_AFTER_HOURS", 24) * 3600;

/**
 * A RUNNING scan older than this is treated as abandoned by the POST path.
 *
 * The boot sweep is what normally clears these, so reaching this means the
 * sweep itself did not run — a kill during shutdown, a crash mid-sweep. Without
 * it one stale row holds the `runningSlot` unique key and locks that host out
 * of scanning permanently, which is a bad way to find out.
 */
export const STALE_RUNNING_AFTER_MS = 6 * 60 * 60 * 1000;

/** Scans this process will run at once, across all hosts. */
export const MAX_SCANS_IN_FLIGHT = inFlightFromEnv();

function hoursFromEnv(variable: string, fallback: number): number {
  const override = Number.parseInt(process.env[variable] ?? "", 10);
  return Number.isNaN(override) || override < 1 ? fallback : override;
}

function inFlightFromEnv(): number {
  const override = Number.parseInt(process.env.TREKKER_SCANS_IN_FLIGHT ?? "", 10);
  // Two, not three: parsing a few hundred megabytes of records is work on this
  // box as well as on the host being scanned.
  return Number.isNaN(override) || override < 1 ? 2 : override;
}
