"use client";

import { Inspector } from "@components/explorer/inspector";
import { Pane } from "@components/explorer/pane";
import {
  backTarget,
  explorerReducer,
  forwardTarget,
  initialState,
  openTarget,
  upTarget,
} from "@components/explorer/pane-state";
import { HostManager } from "@components/hosts/host-manager";
import { useToast } from "@components/ui/toast";
import { globToRegExp, joinPath, resolveTarget, sortRows } from "@helpers/listing";
import { fetchListing } from "@lib/api/fs";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";

import type { PaneCallbacks } from "@components/explorer/pane";
import type { PaneIndex, PaneView } from "@components/explorer/pane-state";
import type { SplitMode } from "@components/shell/toolbar";
import type { SortKey } from "@helpers/listing";
import type { FileRow } from "@lib/api/fs";
import type { HostView } from "@lib/api/hosts";

/**
 * The two panes and everything shared between them (TRE-16, rewired by TRE-18).
 *
 * Where a pane *is* — its host, path, sort key and direction — is no longer
 * held here: it is in the URL, and arrives as a prop with a setter. What stays
 * is the memory around it, the tabs, history stacks, selection and cursor that
 * a link has no business carrying.
 *
 * The consequence worth knowing is that navigation is now two writes that must
 * agree: the reducer records where we were, the URL records where we are. They
 * are issued together from `go()` and from nowhere else, which is what keeps
 * them from drifting — and why there is no effect syncing one back into the
 * other, the loop this refactor exists to avoid.
 */

/** Fresh enough that a chmod shows up, slow enough not to refetch on a glance. */
const STALE_MS = 10_000;

/** One pane's share of the URL. */
export interface PaneUrl {
  host: string | null;
  path: string;
  sort: SortKey;
  dir: 1 | -1;
}

export function Explorer({
  hosts,
  hostsPending = false,
  panes,
  onPaneChange,
  active,
  onActiveChange,
  glob,
  onGlobChange,
  onMatchesChange,
  splitMode,
  heat,
  inspector,
  onInspectorChange,
  onSelectionChange,
  manageHostsFor,
  onManageHosts,
}: {
  hosts: readonly HostView[];
  /** True while the hosts query is in flight, so an unbound pane waits rather
   * than announcing it has no host. */
  hostsPending?: boolean;
  panes: readonly [PaneUrl, PaneUrl];
  onPaneChange: (pane: PaneIndex, patch: Partial<PaneUrl>) => void;
  active: PaneIndex;
  onActiveChange: (pane: PaneIndex) => void;
  glob: string;
  onGlobChange: (glob: string) => void;
  /** Reported up so the toolbar's hit count can show it. */
  onMatchesChange: (matches: number | null) => void;
  splitMode: SplitMode;
  heat: boolean;
  /** Whether the 218px panel is showing (TRE-17 §4). URL-backed, like the split. */
  inspector: boolean;
  onInspectorChange: (open: boolean) => void;
  onSelectionChange: (selection: { row: FileRow; path: string } | null) => void;
  /** Which pane opened the host manager, if any — owned by the page so the
   * sidebar can open it too. */
  manageHostsFor: PaneIndex | null;
  onManageHosts: (pane: PaneIndex | null) => void;
}) {
  const [memory, dispatch] = useReducer(explorerReducer, undefined, () => initialState());
  const { push } = useToast();
  const queryClient = useQueryClient();
  /** Set once a host has been bound automatically, so it happens per pane once. */
  const [seeded, setSeeded] = useState<[boolean, boolean]>([false, false]);

  const views: [PaneView, PaneView] = [
    { ...memory.panes[0], hostId: panes[0].host, path: panes[0].path, sort: panes[0].sort, dir: panes[0].dir },
    { ...memory.panes[1], hostId: panes[1].host, path: panes[1].path, sort: panes[1].sort, dir: panes[1].dir },
  ];

  const defaultHost = hosts.find((host) => host.transport === "LOCAL") ?? hosts[0] ?? null;

  /**
   * Bind a pane that has no host, or one whose host no longer exists.
   *
   * The second case is what a URL makes possible: a link can name a host that
   * was deleted, or that belongs to somebody else's account, and the parser
   * cannot know — it only checks the shape. Reconciling here is the same path a
   * deleted host already takes (TRE-43).
   */
  useEffect(() => {
    if (hostsPending) return;
    for (const index of [0, 1] as const) {
      const bound = panes[index].host;
      const known = bound !== null && hosts.some((host) => host.id === bound);
      if (known || (bound === null && seeded[index])) continue;
      if (!defaultHost) continue;
      onPaneChange(index, { host: defaultHost.id, path: defaultHost.homePath });
      setSeeded((current) => {
        const next: [boolean, boolean] = [current[0], current[1]];
        next[index] = true;
        return next;
      });
    }
  }, [hosts, hostsPending, panes, defaultHost, onPaneChange, seeded]);

  // Solo mode shows one pane; that pane must be the one the keyboard, the glob
  // and every toolbar action are pointed at, or they all drive a pane nobody
  // can see.
  useEffect(() => {
    if (splitMode === "left" && active !== 0) onActiveChange(0);
    if (splitMode === "right" && active !== 1) onActiveChange(1);
  }, [splitMode, active, onActiveChange]);

  const listings = [useListing(views[0]), useListing(views[1])] as const;

  // Every row in a paint ages against one instant, so two rows a millisecond
  // apart never render as "59min" and "1h".
  const now = Date.now();

  const rendered = [0, 1].map((index) => {
    const listing = listings[index];
    const entries = listing.data?.entries ?? [];
    // The glob is the active pane's filter, exactly as the mockup has it.
    const filtered = glob.trim() && index === active ? entries.filter(matcher(glob)) : entries;
    return {
      rows: sortRows(filtered, views[index].sort, views[index].dir),
      hiddenByGlob: entries.length - filtered.length,
      listing,
    };
  });

  const activeView = rendered[active];

  useEffect(() => {
    onMatchesChange(glob.trim() ? activeView.rows.length : null);
  }, [glob, activeView.rows.length, onMatchesChange]);

  // A directory that has just finished loading gets its cursor on the first
  // row, so ↓ moves to the second rather than re-selecting the first.
  const firstNames = [rendered[0].rows[0]?.name ?? null, rendered[1].rows[0]?.name ?? null] as const;
  const cursors = [memory.panes[0].cur, memory.panes[1].cur] as const;
  useEffect(() => {
    for (const index of [0, 1] as const) {
      const first = firstNames[index];
      if (first !== null && cursors[index] === null) {
        dispatch({ type: "cursor", pane: index, name: first });
      }
    }
  }, [firstNames, cursors]);

  const activePane = views[active];
  // Indexed, not searched: `sel.includes` once per row is a hundred million
  // comparisons when ⌘A has selected ten thousand of them (TRE-19 §2). Skipped
  // outright while the panel is closed, since nothing else needs the rows.
  const inspecting = inspector ? new Set(activePane.sel) : null;
  const inspected = inspecting ? activeView.rows.filter((row) => inspecting.has(row.name)) : [];
  const cursorRow = activeView.rows.find((row) => row.name === activePane.cur) ?? null;
  const cursorPath = cursorRow ? joinPath(activePane.path, cursorRow.name) : null;

  useEffect(() => {
    onSelectionChange(cursorRow && cursorPath ? { row: cursorRow, path: cursorPath } : null);
  }, [cursorRow, cursorPath, onSelectionChange]);

  /**
   * The one way a pane moves. Both writes are issued here — the reducer's
   * memory of where we were, and the URL's record of where we are — so they
   * cannot disagree.
   */
  const go = (index: PaneIndex, path: string, history = true) => {
    if (path === views[index].path) return;
    dispatch({ type: "navigate", pane: index, path, history });
    onPaneChange(index, { path });
  };

  const open = (index: PaneIndex, row: FileRow) => {
    if (row.type === "dir") {
      go(index, openTarget(views[index].path, row.name));
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
        go(index, resolveTarget(views[index].path, row.linkTarget));
        return;
      }
    }
    push({ tone: "info", message: row.name, detail: "Read-only preview arrives with the inspector (TRE-17)" });
  };

  useKeyboard({
    // The manager is a modal: ↓ over it belongs to nothing behind it.
    enabled: manageHostsFor === null,
    onKey: (event) => {
      const index = active;
      const names = rendered[index].rows.map((row) => row.name);

      switch (event.key) {
        case "Tab":
          onActiveChange(index === 0 ? 1 : 0);
          return true;
        case "ArrowDown":
          dispatch({ type: "move", pane: index, delta: 1, names });
          return true;
        case "ArrowUp":
          dispatch({ type: "move", pane: index, delta: -1, names });
          return true;
        case "Enter": {
          const row = rendered[index].rows.find((candidate) => candidate.name === views[index].cur);
          if (row) open(index, row);
          return true;
        }
        case "Backspace": {
          const up = upTarget(views[index].path);
          if (up) go(index, up);
          return true;
        }
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

  // ⌘I is its own listener rather than a case in the switch above: that one
  // stands down while a modifier is held and while the glob field has focus,
  // both of which are correct for ⌫ and the arrow keys and wrong for a chord
  // nothing else in the browser is going to want.
  useShortcut({
    enabled: manageHostsFor === null,
    key: "i",
    inFields: true,
    onPress: () => onInspectorChange(!inspector),
  });

  // ⌘A selects what the pane is showing, from the array (TRE-19 §2). Nothing
  // here counts rows in the DOM, so a selection of ten thousand costs the same
  // as a selection of ten — but inside the glob field ⌘A still means "select
  // this text", which is why this one stands down there and ⌘I does not.
  useShortcut({
    enabled: manageHostsFor === null,
    key: "a",
    inFields: false,
    onPress: () => dispatch({ type: "selectAll", pane: active, names: rendered[active].rows.map((row) => row.name) }),
  });

  const callbacksFor = (index: PaneIndex): PaneCallbacks => ({
    onFocus: () => onActiveChange(index),
    onCd: (path) => go(index, path),
    onUp: () => {
      const up = upTarget(views[index].path);
      if (up) go(index, up);
    },
    onBack: () => {
      const target = backTarget(views[index]);
      if (!target) return;
      dispatch({ type: "stacks", pane: index, ...target });
      onPaneChange(index, { path: target.path });
    },
    onForward: () => {
      const target = forwardTarget(views[index]);
      if (!target) return;
      dispatch({ type: "stacks", pane: index, ...target });
      onPaneChange(index, { path: target.path });
    },
    onOpen: (row) => open(index, row),
    onNewTab: () => dispatch({ type: "newTab", pane: index, path: views[index].path }),
    onSelectTab: (tab) => {
      const path = memory.panes[index].tabs[tab];
      if (path === undefined) return;
      dispatch({ type: "selectTab", pane: index, tab });
      onPaneChange(index, { path });
    },
    onSort: (key: SortKey) => {
      // Second click on the same column reverses it. A different column starts
      // ascending — except size, where the question is always "what is eating
      // the disk", so the first click puts the biggest at the top.
      const pane = views[index];
      onPaneChange(
        index,
        pane.sort === key ? { dir: pane.dir === 1 ? -1 : 1 } : { sort: key, dir: key === "size" ? -1 : 1 },
      );
    },
    onRowClick: (name, modifiers) =>
      dispatch({
        type: "click",
        pane: index,
        name,
        names: rendered[index].rows.map((row) => row.name),
        extend: modifiers.extend,
        toggle: modifiers.toggle,
      }),
    onHostMenu: () => onManageHosts(index),
    onClearGlob: () => onGlobChange(""),
  });

  // Pointing at a directory is a reliable signal that it is about to be
  // opened, whether the pointer is a mouse or the keyboard cursor.
  const prefetch = (pane: PaneView, row: FileRow) => {
    if (row.type !== "dir" || pane.hostId === null) return;
    const path = joinPath(pane.path, row.name);
    queryClient.prefetchQuery({
      queryKey: [QUERY_KEYS.DIRECTORY, pane.hostId, path],
      queryFn: () => fetchListing(pane.hostId as string, path),
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

  const prefetchFromEvent = (pane: PaneView, rows: readonly FileRow[], target: EventTarget | null) => {
    const name = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-row]")?.dataset.row;
    const row = name ? rows.find((candidate) => candidate.name === name) : undefined;
    if (row) prefetch(pane, row);
  };

  /**
   * A host that has just been created, edited or deleted (TRE-43).
   *
   * The list is refetched rather than patched — the server owns the slug, the
   * normalised roots and whether a credential is stored — and any pane left
   * pointing at a deleted host is unbound, which hands it back to the binding
   * effect above.
   */
  const onHostsChanged = ({ host, deleted }: { host: HostView; deleted?: boolean }) => {
    void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.HOSTS] });
    if (!deleted) void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, host.id] });
    // A deleted host needs no unbinding here. Once the list comes back without
    // it, the pane's id matches nothing and the reconciling effect above binds
    // it to whatever is left — the same path a URL naming a stale host takes,
    // which is one behaviour instead of two.
  };

  return (
    // Two rows of nesting, not one: the split arranges the panes, and the
    // inspector sits beside whatever that arrangement produced. Left flat, a
    // solo pane would stack the panel underneath itself rather than beside it.
    <div className="flex h-full min-h-0">
      <div className={`flex min-h-0 min-w-0 flex-1 ${splitMode === "split" ? "flex-row" : "flex-col"}`}>
        {([0, 1] as const).map((index) => {
          const solo = splitMode !== "split";
          const shown = splitMode === "split" || (splitMode === "left" ? index === 0 : index === 1);
          if (solo && !shown) return null;

          const pane = views[index];
          const view = rendered[index];
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
                active={active === index}
                host={hosts.find((host) => host.id === pane.hostId) ?? null}
                rows={view.rows}
                meta={view.listing.data?.meta ?? null}
                // A disabled query never leaves `isPending`, so an unbound pane
                // would shimmer for ever if that alone drove the skeleton.
                loading={hostsPending || (pane.hostId !== null && view.listing.isPending)}
                error={view.listing.error}
                glob={index === active ? glob.trim() : ""}
                hiddenByGlob={index === active ? view.hiddenByGlob : 0}
                heat={heat}
                now={now}
                callbacks={callbacksFor(index)}
              />
            </div>
          );
        })}
      </div>

      {inspector && (
        <Inspector
          host={hosts.find((host) => host.id === activePane.hostId) ?? null}
          path={activePane.path}
          rows={activeView.rows}
          selected={inspected}
          sort={activePane.sort}
          dir={activePane.dir}
          glob={glob.trim()}
          loading={hostsPending || (activePane.hostId !== null && activeView.listing.isPending)}
          error={activeView.listing.error}
          now={now}
          onClose={() => onInspectorChange(false)}
        />
      )}

      {manageHostsFor !== null && (
        <HostManager
          hosts={hosts}
          boundHostId={panes[manageHostsFor].host}
          onPick={(host) => onPaneChange(manageHostsFor, { host: host.id, path: host.homePath })}
          onChanged={onHostsChanged}
          onClose={() => onManageHosts(null)}
        />
      )}
    </div>
  );
}

function useListing(pane: PaneView) {
  return useQuery({
    // Two panes on the same directory of the same host share this entry.
    queryKey: [QUERY_KEYS.DIRECTORY, pane.hostId, pane.path],
    queryFn: () => fetchListing(pane.hostId as string, pane.path),
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
function useKeyboard({ enabled, onKey }: { enabled: boolean; onKey: (event: KeyboardEvent) => boolean }) {
  useEffect(() => {
    if (!enabled) return;
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
  }, [enabled, onKey]);
}

/**
 * One ⌘-chord. `metaKey || ctrlKey` rather than a platform check: this app is
 * read on a Mac and on Linux, and a shortcut that works on only one of them is
 * a shortcut nobody trusts.
 *
 * `inFields` is the whole difference from `useKeyboard`, which stands down
 * wholesale while someone is typing. A chord the browser has no use for inside
 * a text field (⌘I) should still work there; one that already means something
 * (⌘A) must not be stolen.
 */
function useShortcut({
  enabled,
  key,
  inFields,
  onPress,
}: {
  enabled: boolean;
  key: string;
  inFields: boolean;
  onPress: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== key) return;
      if (!inFields) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      }
      event.preventDefault();
      onPress();
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled, key, inFields, onPress]);
}
