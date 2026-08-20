/**
 * Why a running checksum job was aborted (TRE-27).
 *
 * The same two reasons a scan and a transfer have, and the same requirement
 * that they not be confused — but with a much smaller consequence than either,
 * because of where a hash job keeps its results.
 *
 * A **cancellation** is somebody pressing stop. The job ends as `CANCELLED`,
 * and every file it had already finished keeps its row: digests are written per
 * file as they are earned, not in a terminal transaction. So stopping a job
 * halfway through a hundred files leaves fifty-one cached hashes, and
 * re-queueing the selection later skips all of them.
 *
 * A **shutdown** is the API stopping underneath the job. It ends the same way
 * for the same reason: there is nothing on disk to reconcile and no row to
 * leave `RUNNING` for a boot sweep to find, because the job was never persisted
 * (see `FileHashes` in the schema). This is where it parts company with
 * `scan-signals.ts`, whose whole shutdown protocol exists to hand a half-walked
 * scan to the next boot. Here the next boot has nothing to do, and the work
 * that survived a restart is exactly the work that had finished.
 *
 * They are still two distinct reasons rather than one, because what is said
 * about them differs: a cancelled job is silent, and a job the API ended under
 * somebody deserves to say so.
 *
 * Its own file so neither the queue nor the runner has to import the other.
 */

export const CANCELLED_BY_USER = "trekker:hash-cancelled";
export const CANCELLED_BY_SHUTDOWN = "trekker:hash-shutdown";

export function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === CANCELLED_BY_SHUTDOWN;
}
