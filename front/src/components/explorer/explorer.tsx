"use client";

import { Pane } from "@components/explorer/pane";
import { explorerReducer, initialState, pathOf } from "@components/explorer/pane-state";
import { useToast } from "@components/ui/toast";
import { globToRegExp, joinPath, resolveTarget, sortRows } from "@helpers/listing";
import { fetchListing } from "@lib/api/fs";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer } from "react";

import type { PaneCallbacks } from "@components/explorer/pane";
import type { PaneIndex, PaneState } from "@components/explorer/pane-state";
import type { SplitMode } from "@components/shell/toolbar";
import type { SortKey } from "@helpers/listing";
import type { FileRow } from "@lib/api/fs";
import type { HostView } from "@lib/api/hosts";

/**
 * The two panes and everything shared between them (TRE-16).
 *
 * Data, keyboard and layout live here; a pane draws what it is given. That
 * split is what lets `⇥` move the keyboard between two identical components
 * and lets a future transfer (TRE-23) read "the other pane" without either
 * pane knowing the other exists.
 */

/** Fresh enough that a chmod shows up, slow enough not to refetch on a glance. */
const STALE_MS = 10_000;

export function Explorer({
  hosts,
  hostsPending = false,
  glob,
  onGlobChange,
  onMatchesChange,
  splitMode,
  heat,
  onSelectionChange,
}: {
  hosts: readonly HostView[];
  /** True while the hosts query is in flight, so an unbound pane waits rather
   * than announcing it has no host. */
  hostsPending?: boolean;
  glob: string;
  onGlobChange: (glob: string) => void;
  /** Reported up so the toolbar's hit count can show it. */
  onMatchesChange: (matches: number | null) => void;
  splitMode: SplitMode;
  heat: boolean;
  onSelectionChange: (selection: { row: FileRow; path: string } | null) => void;
}) {
  const [state, dispatch] = useReducer(explorerReducer, undefined, () => initialState());
  const { push } = useToast();
  const queryClient = useQueryClient();

  // One host for both panes until the sidebar can choose (TRE-18). The panes
  // are already independent; only the picker is missing.
  const defaultHost = hosts.find((host) => host.transport === "LOCAL") ?? hosts[0] ?? null;

  useEffect(() => {
    if (!defaultHost) return;
    for (const index of [0, 1] as const) {
      if (state.panes[index].hostId === null) {
        dispatch({ type: "host", pane: index, hostId: defaultHost.id, path: defaultHost.homePath });
      }
    }
  }, [defaultHost, state.panes]);

  // Solo mode shows one pane; that pane must be the one the keyboard, the glob
  // and every toolbar action are pointed at, or they all drive a pane nobody
  // can see.
  useEffect(() => {
    if (splitMode === "left" && state.active !== 0) dispatch({ type: "focus", pane: 0 });
    if (splitMode === "right" && state.active !== 1) dispatch({ type: "focus", pane: 1 });
  }, [splitMode, state.active]);

  const listings = [useListing(state.panes[0]), useListing(state.panes[1])] as const;

  // Every row in a paint ages against one instant, so two rows a millisecond
  // apart never render as "59min" and "1h".
  const now = Date.now();

  const views = [0, 1].map((index) => {
    const pane = state.panes[index];
    const listing = listings[index];
    const entries = listing.data?.entries ?? [];
    // The glob is the active pane's filter, exactly as the mockup has it.
    const filtered = glob.trim() && index === state.active ? entries.filter(matcher(glob)) : entries;
    return {
      rows: sortRows(filtered, pane.sort, pane.dir),
      hiddenByGlob: entries.length - filtered.length,
      listing,
    };
  });

  const activeView = views[state.active];

  // The toolbar shows the hit count and the status bar the selected row; both
  // belong to the active pane, and both are the shell's to draw.
  useEffect(() => {
    onMatchesChange(glob.trim() ? activeView.rows.length : null);
  }, [glob, activeView.rows.length, onMatchesChange]);

  // A directory that has just finished loading gets its cursor on the first
  // row, so ↓ moves to the second rather than re-selecting the first.
  const firstNames = [views[0].rows[0]?.name ?? null, views[1].rows[0]?.name ?? null] as const;
  const cursors = [state.panes[0].cur, state.panes[1].cur] as const;
  useEffect(() => {
    for (const index of [0, 1] as const) {
      const first = firstNames[index];
      if (first !== null && cursors[index] === null) {
        dispatch({ type: "cursor", pane: index, name: first });
      }
    }
  }, [firstNames, cursors]);

  const activePane = state.panes[state.active];
  const cursorRow = activeView.rows.find((row) => row.name === activePane.cur) ?? null;
  const cursorPath = cursorRow ? joinPath(pathOf(activePane), cursorRow.name) : null;

  // Depends on the row object and its path, both stable between renders, so
  // the parent storing what it receives cannot feed this effect back to itself.
  useEffect(() => {
    onSelectionChange(cursorRow && cursorPath ? { row: cursorRow, path: cursorPath } : null);
  }, [cursorRow, cursorPath, onSelectionChange]);

  const open = (index: PaneIndex, row: FileRow) => {
    if (row.type === "dir") {
      dispatch({ type: "open", pane: index, name: row.name, isDirectory: true });
      return;
    }
    if (row.type === "link") {
      if (row.linkInsideRoot === false) {
        push({
          tone: "warning",
          message: "That link leaves the allowed roots",
          detail: row.linkTarget ?? row.name,
        });
        return;
      }
      if (row.linkTarget) {
        // Resolved against the directory holding the link: readlink returns
        // the target as written, and most of them are written relative.
        dispatch({ type: "cd", pane: index, path: resolveTarget(pathOf(state.panes[index]), row.linkTarget) });
        return;
      }
    }
    push({ tone: "info", message: row.name, detail: "Read-only preview arrives with the inspector (TRE-17)" });
  };

  useKeyboard({
    onKey: (event) => {
      const index = state.active;
      const names = views[index].rows.map((row) => row.name);

      switch (event.key) {
        case "Tab":
          dispatch({ type: "switch" });
          return true;
        case "ArrowDown":
          dispatch({ type: "move", pane: index, delta: 1, names });
          return true;
        case "ArrowUp":
          dispatch({ type: "move", pane: index, delta: -1, names });
          return true;
        case "Enter": {
          const row = views[index].rows.find((candidate) => candidate.name === state.panes[index].cur);
          if (row) open(index, row);
          return true;
        }
        case "Backspace":
          dispatch({ type: "up", pane: index });
          return true;
        case "F2":
        case "F5":
        case "F6":
        case "Delete":
          push({ tone: "info", message: "Not yet", detail: "File operations arrive in M2" });
          return true;
        default:
          return false;
      }
    },
  });

  const callbacksFor = (index: PaneIndex): PaneCallbacks => ({
    onFocus: () => dispatch({ type: "focus", pane: index }),
    onCd: (path) => dispatch({ type: "cd", pane: index, path }),
    onUp: () => dispatch({ type: "up", pane: index }),
    onBack: () => dispatch({ type: "back", pane: index }),
    onForward: () => dispatch({ type: "forward", pane: index }),
    onOpen: (row) => open(index, row),
    onNewTab: () => dispatch({ type: "newTab", pane: index }),
    onSelectTab: (tab) => dispatch({ type: "selectTab", pane: index, tab }),
    onSort: (key: SortKey) => dispatch({ type: "sort", pane: index, key }),
    onRowClick: (name, modifiers) =>
      dispatch({
        type: "click",
        pane: index,
        name,
        names: views[index].rows.map((row) => row.name),
        extend: modifiers.extend,
        toggle: modifiers.toggle,
      }),
    onHostMenu: () => push({ tone: "info", message: "Choosing a host", detail: "The sidebar arrives in TRE-18" }),
    onClearGlob: () => onGlobChange(""),
  });

  // Pointing at a directory is a reliable signal that it is about to be
  // opened, whether the pointer is a mouse or the keyboard cursor.
  const prefetch = (pane: PaneState, row: FileRow) => {
    const hostId = pane.hostId;
    if (row.type !== "dir" || hostId === null) return;
    const path = joinPath(pathOf(pane), row.name);
    queryClient.prefetchQuery({
      queryKey: [QUERY_KEYS.DIRECTORY, hostId, path],
      queryFn: () => fetchListing(hostId, path),
      staleTime: STALE_MS,
      // A guess that fails should cost one request, not four.
      retry: false,
    });
  };

  // The keyboard's half of the same idea: arrowing onto a directory warms it.
  const cursorDirectory = cursorRow?.type === "dir" ? cursorPath : null;
  const activeHostId = activePane.hostId;
  useEffect(() => {
    if (!cursorDirectory || activeHostId === null) return;
    queryClient.prefetchQuery({
      queryKey: [QUERY_KEYS.DIRECTORY, activeHostId, cursorDirectory],
      queryFn: () => fetchListing(activeHostId, cursorDirectory),
      staleTime: STALE_MS,
      retry: false,
    });
  }, [cursorDirectory, activeHostId, queryClient]);

  const prefetchFromEvent = (pane: PaneState, rows: readonly FileRow[], target: EventTarget | null) => {
    const name = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-row]")?.dataset.row;
    const row = name ? rows.find((candidate) => candidate.name === name) : undefined;
    if (row) prefetch(pane, row);
  };

  return (
    <div className={`flex h-full min-h-0 ${splitMode === "split" ? "flex-row" : "flex-col"}`}>
      {([0, 1] as const).map((index) => {
        const solo = splitMode !== "split";
        const shown = splitMode === "split" || (splitMode === "left" ? index === 0 : index === 1);
        if (solo && !shown) return null;

        const pane = state.panes[index];
        const view = views[index];
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: a cache warm-up on hover, with no behaviour of its own
          <div
            key={index}
            className="flex min-h-0 min-w-0 flex-1"
            onMouseOver={(event) => prefetchFromEvent(pane, view.rows, event.target)}
            onFocus={(event) => prefetchFromEvent(pane, view.rows, event.target)}
          >
            <Pane
              pane={pane}
              active={state.active === index}
              host={hosts.find((host) => host.id === pane.hostId) ?? null}
              rows={view.rows}
              meta={view.listing.data?.meta ?? null}
              // A disabled query never leaves `isPending`, so an unbound pane
              // would shimmer for ever if that alone drove the skeleton.
              loading={hostsPending || (pane.hostId !== null && view.listing.isPending)}
              error={view.listing.error}
              glob={index === state.active ? glob.trim() : ""}
              hiddenByGlob={index === state.active ? view.hiddenByGlob : 0}
              heat={heat}
              now={now}
              callbacks={callbacksFor(index)}
            />
          </div>
        );
      })}
    </div>
  );
}

function useListing(pane: PaneState) {
  const path = pathOf(pane);
  return useQuery({
    // Two panes on the same directory of the same host share this entry.
    queryKey: [QUERY_KEYS.DIRECTORY, pane.hostId, path],
    queryFn: () => fetchListing(pane.hostId as string, path),
    enabled: pane.hostId !== null,
    staleTime: STALE_MS,
    // A denial or a missing directory is an answer, not a blip: retrying just
    // delays the explanation the pane is about to show.
    retry: false,
    throwOnError: false,
  });
}

function matcher(glob: string): (row: FileRow) => boolean {
  const pattern = globToRegExp(glob.trim());
  return (row) => pattern.test(row.name);
}

/**
 * The keyboard layer (TRE-16 §4). It listens on the window because the panes
 * hold no focus of their own — the cursor is a roving one, drawn by the active
 * pane — and it stands down entirely while someone is typing, or the glob
 * field would swallow `⌫` and the arrow keys would move the cursor instead of
 * the caret.
 */
function useKeyboard({ onKey }: { onKey: (event: KeyboardEvent) => boolean }) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // ⏎ on a focused control belongs to that control. Swallowing it here
      // would mean "clear filter" and the breadcrumbs could be reached by
      // keyboard but never activated with one.
      if (event.key === "Enter" && target?.closest("button, a, select")) return;

      if (onKey(event)) event.preventDefault();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onKey]);
}
