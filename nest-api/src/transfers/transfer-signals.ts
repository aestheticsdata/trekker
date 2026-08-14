/**
 * Why a running transfer was aborted, because the two reasons must not be
 * confused (TRE-23 §1).
 *
 * A **cancellation** is somebody pressing cancel. The job is over, it is
 * recorded as `CANCELLED`, and nothing will pick it up again.
 *
 * A **shutdown** is the API stopping underneath a job that was going fine. The
 * job is not over — its row is deliberately left in `RUNNING` so that the
 * reclaim on the next boot finds it and starts its unfinished items again.
 * Marking it cancelled would be the API deciding, on the operator's behalf and
 * without asking, that a deploy abandons every transfer in flight.
 *
 * Its own file so neither the queue nor the runner has to import the other:
 * the queue decides which reason to abort with, the runner reads it, and a
 * shared constant between them would otherwise be a cycle.
 */

export const CANCELLED_BY_USER = "trekker:transfer-cancelled";
export const CANCELLED_BY_SHUTDOWN = "trekker:transfer-shutdown";

export function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === CANCELLED_BY_SHUTDOWN;
}
