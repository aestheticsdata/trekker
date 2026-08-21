/**
 * Why a running tail was stopped (TRE-34), and the two reasons must not be
 * confused — the same requirement `scan-signals.ts` states, arriving at a
 * different answer because a tail has nothing to reconcile.
 *
 * A **last subscriber leaving** is the ordinary end of a tail, and it is the
 * ticket's headline requirement rather than a tidy-up: the source stops the
 * instant nobody is listening, so `ps` on the host is clean while the tab is
 * still animating shut. The entry lingers briefly afterwards holding only its
 * ring buffer, so a reconnect resumes instead of re-reading.
 *
 * A **shutdown** is the API stopping underneath one. There is no bookkeeping to
 * write and no row to sweep — a tail produces nothing that outlives the
 * process — so the two paths differ in exactly one respect: a shutdown does not
 * bother lingering, because nothing will be there to reconnect to.
 *
 * Its own file so neither the registry nor the sources has to import the other.
 */

export const CLOSED_BY_LAST_SUBSCRIBER = "trekker:tail-idle";
export const CLOSED_BY_SHUTDOWN = "trekker:tail-shutdown";

export function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === CLOSED_BY_SHUTDOWN;
}
