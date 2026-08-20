/**
 * Every bound a checksum job runs under, in one table (TRE-27).
 *
 * The same habit as `scan-limits.ts` next door, and the same distinction: these
 * are not rate limits. `LIMITS.hashJobs` bounds how often somebody may *start*
 * one; these bound what one costs once it has been accepted. The ticket asks
 * for both — "a hash job on a large tree is bounded by file count and total
 * size" — and asks that a job over either be "refused with the numbers", which
 * is why every constant here reaches the refusal message rather than being
 * applied silently.
 */

/**
 * Paths one request may name, before any directory is expanded.
 *
 * The same number `MAX_PATHS` gives the delete and permission routes, and
 * deliberately the same: it bounds the *body*, not the work, and a selection is
 * a selection whichever operation it is aimed at. What the work costs is the
 * two bounds below.
 */
export { MAX_PATHS } from "@fs/permissions.service";

/**
 * Files one job will hash.
 *
 * Five thousand, which is far more than anybody selects by hand and is really a
 * bound on what a *directory* expands to. It is also the walk's ceiling, so a
 * selection over it costs a walk that stops rather than a walk of the whole
 * tree followed by a refusal — the answer arrives in seconds and names why.
 *
 * Because the walk stops early, the refusal can only ever say "more than this",
 * which is honest and is the reason the message is phrased that way.
 */
export const MAX_FILES_PER_JOB = 5_000;

/**
 * Bytes one job will read.
 *
 * 64 GiB. At the 100–200 MB/s a spinning disk or a modest SSD sustains
 * sequentially, that is five to ten minutes of a host's IO — the outer edge of
 * what somebody waits for before concluding the thing is stuck, and well past
 * the "hashing a 20 GB archive takes minutes" the ticket describes as ordinary.
 *
 * A ceiling on the job rather than on the file: one 40 GiB image and four
 * hundred small ones are the same amount of reading, and a per-file cap would
 * refuse the first while waving the second through.
 */
export const MAX_JOB_BYTES = 64n * 1024n * 1024n * 1024n;

/**
 * Jobs this process runs at once, across every host and account.
 *
 * Three, which is the number `LIMITS` declared for this operation before it
 * existed — under the name `TREKKER_LIMIT_HASHES_IN_FLIGHT`, which is what it
 * always meant. It is a concurrency cap and never was a rate limit, so it lives
 * here with the other costs and the counter next door bounds starts instead.
 * See `audit/limits.ts`.
 *
 * Higher than the scans' two: a scan spends real CPU in this process parsing
 * hundreds of megabytes of `du` records, and a hash job that runs remotely
 * spends almost none — it waits on somebody else's disk. The streamed fallback
 * is the exception, and it is bounded by the network long before it is bounded
 * by this.
 */
export const MAX_JOBS_IN_FLIGHT = inFlightFromEnv();

/** How often the progress feed emits while a job runs. */
export const PROGRESS_TICK_MS = 700;

/**
 * How de-prioritised `sha256sum` runs on the host.
 *
 * The same fifteen the scan's walk uses, and with the same caveat: hashing is
 * IO-bound and CPU niceness does not ration IO. It makes the process
 * scheduling polite and does not make the disk reads polite. What actually
 * keeps a host usable under this is the in-flight cap above.
 */
export const HASH_NICE = 15;

function inFlightFromEnv(): number {
  const override = Number.parseInt(process.env.TREKKER_HASHES_IN_FLIGHT ?? "", 10);
  return Number.isNaN(override) || override < 1 ? 3 : override;
}
