import { fetchListing } from "@lib/api/fs";
import { QUERY_KEYS } from "@lib/query/keys";

import type { QueryClient } from "@tanstack/react-query";

/**
 * Warm a directory listing ahead of the click, unless the last answer for it
 * was a refusal (TRE-59).
 *
 * The guard is not an optimisation. `staleTime` does not apply to an errored
 * query — TanStack treats an entry with no data as stale whatever the time
 * says (`isStaleByTime` returns true on `data === undefined` before it looks
 * at the clock), and `prefetchQuery` refetches on exactly that. So without
 * this, a cursor resting on one forbidden directory is a fresh HTTP request
 * per `mouseover`, each one a `realpath` on the host and an SFTP round trip on
 * an SSH one. The pane looked idle; the host was not.
 *
 * All this does is extend the same `staleTime` over refusals: a "no" is an
 * answer, and an answer is worth remembering for as long as a listing is. What
 * it deliberately does *not* do is remember it forever — after the window the
 * next hover asks again, which is how a path that becomes reachable (a chmod,
 * a widened root) comes back without anything having to notify this function.
 *
 * `isInvalidated` looks like the right signal for that and is not: query-core
 * sets it on *every* error, not only on `invalidateQueries` — "flag existing
 * data as invalidated if we get a background error", `query.js` reducer, case
 * "error". Reading it here would make the guard a no-op, silently. Measured,
 * not assumed: see the harness in the ticket.
 *
 * Clicking is unaffected: it mounts the pane's own listing query, which
 * refetches an errored entry on mount whatever this decided. A deliberate
 * choice is allowed to be wrong twice — it is the guessing that has to stop.
 *
 * It lives here rather than inside the explorer for two reasons: it is cache
 * policy with no view in it, and a component file cannot be driven by a
 * harness that counts requests, which is the only honest way to check a change
 * whose whole subject is how many were made.
 */
export function warmDirectory(queryClient: QueryClient, hostId: string, path: string, staleTime: number): void {
  const queryKey = [QUERY_KEYS.DIRECTORY, hostId, path];

  const state = queryClient.getQueryState(queryKey);
  if (state?.status === "error" && Date.now() - state.errorUpdatedAt < staleTime) return;

  void queryClient.prefetchQuery({
    queryKey,
    queryFn: () => fetchListing(hostId, path),
    staleTime,
    // A guess that fails should cost one request, not four.
    retry: false,
  });
}
