/**
 * Resolves to `fallback` if `promise` has not settled within `ms`.
 *
 * Health probes must be bounded. A dependency that is *unreachable* usually
 * fails fast; a dependency that is *mid-outage* often does not fail at all — it
 * hangs while a client library waits for a reconnection that may never come.
 * Without a ceiling here, one dead dependency makes the health endpoint itself
 * unanswerable, which is the opposite of what it exists for.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}
