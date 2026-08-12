"use client";

import { useAuth } from "@auth/context/AuthContext";
import { fetchLastLayout, saveLastLayout } from "@lib/api/users";
import { QUERY_KEYS } from "@lib/query/keys";
import { EXPLORER_URL_KEYS } from "@lib/url/explorer-params";
import { serialiseLayout } from "@schemas/layout";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { StoredLayout } from "@schemas/layout";

/**
 * Session restore (TRE-51): a bare URL reopens the layout the account left.
 *
 * The whole correctness condition is the `coldOpen` test below. A URL carrying
 * any explorer parameter is a deliberate link and is left exactly as given —
 * overwriting one with the reader's own last position would break it silently,
 * because what they would see is a plausible explorer pointed at the wrong
 * thing rather than an error.
 */

/** Long enough that a burst of navigation is one write, short enough to survive a closed tab. */
const WRITE_DEBOUNCE_MS = 1000;

export interface SessionLayoutArgs {
  current: StoredLayout;
  applyLayout: (layout: StoredLayout) => void;
  /**
   * The hosts this account actually has. A stored host that has since been
   * deleted defaults its pane rather than failing the restore — the user did
   * not ask for this and should not have to acknowledge its failure. Undefined
   * while they are still loading, which is why restore waits for them.
   */
  knownHostIds: readonly string[] | undefined;
}

export function useSessionLayout({ current, applyLayout, knownHostIds }: SessionLayoutArgs): void {
  const { csrfToken } = useAuth();
  const searchParams = useSearchParams();

  // Answered once, on the first render, and never again — a lazy initial state
  // rather than a ref written during render. nuqs puts parameters in the query
  // string as soon as anything changes, so by the second render every URL looks
  // deliberate and the question can no longer be asked honestly.
  const [coldOpen] = useState(() => !EXPLORER_URL_KEYS.some((key) => searchParams.has(key)));

  const { data: stored, isPending } = useQuery({
    queryKey: [QUERY_KEYS.LAYOUT],
    queryFn: fetchLastLayout,
    enabled: coldOpen,
    // Asked once per cold open. Refetching it would mean restoring over a
    // layout the user has since changed by hand.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    // Losing the last position is not worth an error boundary.
    throwOnError: false,
    retry: false,
  });

  const appliedRef = useRef(false);
  const lastWrittenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!coldOpen || appliedRef.current) return;
    // Wait for the hosts: applying first and reconciling after would show the
    // pane binding to a host and then losing it, which reads as a bug.
    if (isPending || knownHostIds === undefined) return;

    appliedRef.current = true;
    if (!stored) return;

    const restored = degradeToKnownHosts(stored, knownHostIds);
    // Nothing is written back for what we just applied — the layout on screen
    // is the layout in the database, and a write here would be a round trip
    // that changes nothing. That holds only because both sides go through the
    // same serialiser; see the note on it.
    lastWrittenRef.current = serialiseLayout(restored);
    applyLayout(restored);
  }, [coldOpen, isPending, knownHostIds, stored, applyLayout]);

  // The string, not the object, is the dependency. `current` is rebuilt on
  // every render, so depending on it would re-run this effect — and therefore
  // restart the debounce — on every unrelated re-render the page has, of which
  // there are several a second while a directory is loading. The write would
  // then never fire.
  const serialised = serialiseLayout(current);

  useEffect(() => {
    // Never write before restore has had its turn: a cold open sits on the
    // defaults for a moment, and saving those would erase the layout this hook
    // is in the middle of fetching.
    if (coldOpen && !appliedRef.current) return;
    if (serialised === lastWrittenRef.current) return;

    const timer = setTimeout(() => {
      lastWrittenRef.current = serialised;
      // Fire and forget. Two tabs race and the last one wins, deliberately:
      // this is a seed for the next cold open, not shared state. A failed
      // write is dropped — losing the last position is not worth a toast.
      void saveLastLayout(JSON.parse(serialised) as StoredLayout, csrfToken).catch(() => undefined);
    }, WRITE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [coldOpen, serialised, csrfToken]);
}

/**
 * A pane whose host is gone opens on nothing rather than on a host id that
 * resolves to no host. The path goes with it: a path only means something
 * against the machine it was read from.
 */
function degradeToKnownHosts(layout: StoredLayout, knownHostIds: readonly string[]): StoredLayout {
  const keep = (pane: StoredLayout["a"]): StoredLayout["a"] =>
    pane.host && knownHostIds.includes(pane.host) ? pane : { ...pane, host: null, path: "/" };

  return { ...layout, a: keep(layout.a), b: keep(layout.b) };
}
