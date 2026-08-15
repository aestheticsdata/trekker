/**
 * Why a running scan was aborted — the same two reasons a transfer has, and the
 * same requirement that they not be confused (TRE-32).
 *
 * A **cancellation** is somebody pressing stop. The scan is over and is recorded
 * as `CANCELLED`: nothing was written to the host, nothing is half-done, and
 * the previous scan of that root is still there to look at.
 *
 * A **shutdown** is the API stopping underneath a scan. No terminal status is
 * written at all — the row is left `RUNNING` for the next boot to find, which
 * is the one code path that also handles a `kill -9`, and therefore the one
 * that gets exercised.
 *
 * Where this parts company with `transfer-signals.ts` is what the next boot
 * then does. A transfer resumes: bytes somebody is waiting for have already
 * moved, and there is per-item bookkeeping designed to pick them up. A scan is
 * **failed and left alone**. It produced nothing — entries are written only in
 * the terminal transaction, so there is no partial state to reconcile — and
 * resuming would mean starting a fresh multi-minute walk on somebody's server,
 * unprompted, minutes after a deploy, on every host that had one running. The
 * previous scan is still served with its age, and the button is right there.
 *
 * Its own file so neither the queue nor the runner has to import the other.
 */

export const CANCELLED_BY_USER = "trekker:scan-cancelled";
export const CANCELLED_BY_SHUTDOWN = "trekker:scan-shutdown";

export function isShutdown(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === CANCELLED_BY_SHUTDOWN;
}
