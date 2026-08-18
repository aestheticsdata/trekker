"use client";

import { fetchHosts } from "@lib/api/hosts";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { HostView } from "@lib/api/hosts";

export interface SudoWindowState {
  /** The host this is about, or null when it is not in the list (yet, or ever). */
  host: HostView | null;
  open: boolean;
  remainingMs: number;
}

/**
 * How much of a sudo window is left on one host, live (TRE-29).
 *
 * The server sends `sudoRemainingMs` on every host in `GET /hosts`, which is a
 * *reading* and not a clock: it was true when that response was written and
 * decays from there, and the hosts list is cached for a minute. Rendering it
 * directly would give a badge that sat at `14:32` for a minute and then jumped.
 *
 * So this anchors instead. Each fresh reading becomes an absolute instant, and
 * everything after is arithmetic against the local clock — which is what makes
 * a countdown a countdown rather than a stale number redrawn.
 *
 * Keyed by host id rather than taking a `HostView`, because the callers are not
 * alike: the badge in the top bar holds the whole host, and every operation
 * modal holds only the id of the host its target sits on. Both subscribe to the
 * same hosts query, which is already mounted by the page, so this is a cache
 * read and not a request.
 *
 * One hook for all of them on purpose. The badge and the `#` on each command
 * preview have to agree about whether the window is open, and the way to
 * guarantee that is to compute it the same way from the same field rather than
 * to have one read a number and the other ask a second endpoint.
 *
 * Ticking only while a window is open matters more than it looks. Trekker is an
 * application people leave in a tab all day, and a one-second interval that
 * runs for ever is a wake-up the browser cannot coalesce away.
 */
export function useSudoWindow(hostId: string | null): SudoWindowState {
  const queryClient = useQueryClient();

  // Deduplicated against the page's own hosts query by the shared key, so this
  // adds a subscriber rather than a round trip.
  const { data: hosts } = useQuery({
    queryKey: [QUERY_KEYS.HOSTS],
    queryFn: fetchHosts,
    staleTime: 60_000,
    throwOnError: false,
  });

  const host = hosts?.find((candidate) => candidate.id === hostId) ?? null;
  const reading = host?.sudoRemainingMs ?? 0;

  // `0` means closed, in both. Not null, so the arithmetic below never has to
  // ask which kind of nothing it is holding.
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(0);

  // Re-anchored on every fresh reading, including one that says zero. The
  // server is the authority on whether a window exists; this only interpolates
  // between the moments it says so.
  useEffect(() => {
    if (reading <= 0) {
      setExpiresAt(0);
      return;
    }
    setExpiresAt(Date.now() + reading);
    setNow(Date.now());
  }, [reading]);

  useEffect(() => {
    if (expiresAt === 0) return;

    const id = setInterval(() => {
      const tick = Date.now();
      setNow(tick);

      if (tick >= expiresAt) {
        clearInterval(id);
        // The window has run out locally, so the cached hosts list is now
        // wrong. Refetching is what takes the badge down and turns every `#`
        // back into a `$` — and it goes through the same field the rest of the
        // app reads, so nothing ends up with a second source of truth.
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HOSTS] });
      }
    }, 1000);

    return () => clearInterval(id);
  }, [expiresAt, queryClient]);

  // Zero until the anchoring effect has run, which is also correct for the
  // server render: there is no session-scoped window to draw before hydration.
  const remainingMs = expiresAt === 0 ? 0 : Math.max(0, expiresAt - now);

  return { host, open: remainingMs > 0, remainingMs };
}
