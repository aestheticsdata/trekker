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
import { PermissionsModal } from "@components/explorer/permissions-modal";
import { RenameModal } from "@components/explorer/rename-modal";
import { HostManager } from "@components/hosts/host-manager";
import { CollapsiblePane } from "@components/ui/collapsible-pane";
import { useToast } from "@components/ui/toast";
import { globToRegExp, joinPath, parentPath, resolveTarget, sortRows } from "@helpers/listing";
import { fetchListing, fetchStat } from "@lib/api/fs";
import { QUERY_KEYS } from "@lib/query/keys";
import { warmDirectory } from "@lib/query/warm-directory";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useState } from "react";

import type { PaneCallbacks } from "@components/explorer/pane";
import type { PaneIndex, PaneView } from "@components/explorer/pane-state";
import type { PermissionsTarget } from "@components/explorer/permissions-modal";
import type { RenameMode, RenameTarget } from "@components/explorer/rename-modal";
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
  animate,
  onSelectionChange,
  manageHostsFor,
  onManageHosts,
  permissionsOpen,
  onPermissionsOpenChange,
  renameMode,
  onRenameMode,
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
  /** Whether a change to the split or the inspector is one somebody just made,
   * and so worth animating (TRE-62 §4). False until the first one. */
  animate: boolean;
  onSelectionChange: (selection: { row: FileRow; path: string } | null) => void;
  /** Which pane opened the host manager, if any — owned by the page so the
   * sidebar can open it too. */
  manageHostsFor: PaneIndex | null;
  onManageHosts: (pane: PaneIndex | null) => void;
  /** The toolbar's `permissions` button, owned by the page for the same reason
   * the host manager is: the button lives up there, the selection lives here. */
  permissionsOpen: boolean;
  onPermissionsOpenChange: (open: boolean) => void;
  /**
   * Which rename form is open, or null for none (TRE-22). Owned by the page for
   * the same reason `permissions` is.
   *
   * A mode rather than a boolean because the two entry points promise different
   * things: the toolbar's button is labelled `regex rename` and must open the
   * pattern, F2 on one entry means "rename this" and must open the name.
   */
  renameMode: RenameMode | null;
  onRenameMode: (mode: RenameMode | null) => void;
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
  // Also computed while either modal is open: the toolbar's buttons need the
  // selection whether or not the panel that usually shows it is up.
  const inspecting = inspector || permissionsOpen || renameMode !== null ? new Set(activePane.sel) : null;
  const inspected = inspecting ? activeView.rows.filter((row) => inspecting.has(row.name)) : [];
  const cursorRow = activeView.rows.find((row) => row.name === activePane.cur) ?? null;
  const cursorPath = cursorRow ? joinPath(activePane.path, cursorRow.name) : null;

  useEffect(() => {
    onSelectionChange(cursorRow && cursorPath ? { row: cursorRow, path: cursorPath } : null);
  }, [cursorRow, cursorPath, onSelectionChange]);

  /**
   * What the permissions modal is aimed at (TRE-21).
   *
   * With nothing selected it is the directory the pane is showing — which is
   * the case the toolbar button lands in most often, since opening a folder is
   * how you arrive at wanting to change its mode. That needs the directory's
   * own stat, which the listing does not carry; it shares the inspector's cache
   * entry, so it is usually already there.
   */
  const needsDirectoryStat = permissionsOpen && inspected.length === 0 && activePane.hostId !== null;
  const directoryStat = useQuery({
    queryKey: [QUERY_KEYS.ENTRY, activePane.hostId, activePane.path],
    queryFn: () => fetchStat(activePane.hostId as string, activePane.path),
    enabled: needsDirectoryStat,
    staleTime: STALE_MS,
    retry: false,
    throwOnError: false,
  });

  const permissionsTarget: PermissionsTarget | null =
    !permissionsOpen || activePane.hostId === null
      ? null
      : inspected.length > 0
        ? { hostId: activePane.hostId, directory: activePane.path, entries: inspected }
        : directoryStat.data
          ? // The stat's `name` is the basename, so the parent is where it
            // lives and the modal joins the two back into the same path.
            {
              hostId: activePane.hostId,
              directory: parentPath(activePane.path),
              entries: [directoryStat.data],
            }
          : null;

  /**
   * What the rename modal is aimed at (TRE-22).
   *
   * The selection when there is one, and the row under the cursor when there is
   * not — which is what F2 means everywhere else and what the mockup's own
   * shortcut hint promises. Unlike the permissions modal it never falls back to
   * the directory the pane is showing: renaming the directory you are standing
   * in leaves the pane pointing at a path that no longer exists, and that is a
   * navigation decision this ticket has no business making.
   */
  const renameEntries = inspected.length > 0 ? inspected : cursorRow ? [cursorRow] : [];
  const renameTarget: RenameTarget | null =
    renameMode === null || activePane.hostId === null || renameEntries.length === 0
      ? null
      : { hostId: activePane.hostId, directory: activePane.path, entries: renameEntries };

  // A target of nothing renders nothing, which would leave the mode set and the
  // toolbar's button dead until something else cleared it. The button cannot
  // know — it is up in the shell and the selection is down here — so the answer
  // is given once the pane knows its own contents, and not while it is still
  // loading them, or opening on a cold pane would close itself.
  const renameEmpty =
    renameMode !== null &&
    !hostsPending &&
    !activeView.listing.isPending &&
    (activePane.hostId === null || renameTarget === null);
  useEffect(() => {
    if (!renameEmpty) return;
    onRenameMode(null);
    push({ tone: "info", message: "Nothing to rename", detail: "Select an entry, or put the cursor on one" });
  }, [renameEmpty, onRenameMode, push]);

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
          // Aimed at the pane the key was pressed in, which is the active one —
          // stated anyway, because the target below reads `activePane` and the
          // two must not be able to disagree. An empty pane is handled where
          // the toolbar's button lands too, rather than twice.
          //
          // One entry opens on the name, because that is what F2 means in every
          // file manager. A selection opens on the pattern, because there is no
          // single name to type. Either way the other form is one click away.
          onActiveChange(index);
          onRenameMode(renameEntries.length === 1 ? "name" : "pattern");
          return true;
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
    warmDirectory(queryClient, pane.hostId, joinPath(pane.path, row.name), STALE_MS);
  };

  // The keyboard's half of the same idea: arrowing onto a directory warms it.
  const cursorDirectory = cursorRow?.type === "dir" ? cursorPath : null;
  const activeHostId = activePane.hostId;
  useEffect(() => {
    if (!cursorDirectory || activeHostId === null) return;
    warmDirectory(queryClient, activeHostId, cursorDirectory, STALE_MS);
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
      {/* A query container, so a pane that is collapsing can hold its width in
          `cqw` (TRE-62): half of this row is what a pane in a split is, and a
          percentage would resolve against the box that is animating. The row
          also hands both panes one clock, since a split change is an arrival
          and a departure at once — a pane arrives whenever the split goes on. */}
      <div
        className="pane-row @container flex min-h-0 min-w-0 flex-1"
        data-motion={splitMode === "split" ? "open" : "close"}
      >
        {([0, 1] as const).map((index) => {
          const shown = splitMode === "split" || (splitMode === "left" ? index === 0 : index === 1);
          const pane = views[index];
          const view = rendered[index];
          return (
            <CollapsiblePane
              key={index}
              open={shown}
              // What this pane is worth when it is showing: half the row beside
              // its neighbour, all of it alone. A pane on its way out keeps the
              // one it had, which is why the wrapper holds it rather than
              // reading this prop on the way down.
              size={splitMode === "split" ? "50cqw" : "100cqw"}
              fills
              animate={animate}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a cache warm-up on hover, with no behaviour of its own */}
              <div
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
            </CollapsiblePane>
          );
        })}
      </div>

      <CollapsiblePane
        open={inspector}
        size="var(--spacing-inspector)"
        animate={animate}
        // The panel's own breakpoint, moved out to the box that has the width:
        // below 1100px there is no inspector at all, and a wrapper animating
        // open behind `display: none` would hand 218px to a panel that is not
        // there. A resize across it is not an open, and animates nothing.
        className="hidden inspector:flex"
      >
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
          onEditPermissions={() => onPermissionsOpenChange(true)}
        />
      </CollapsiblePane>

      {permissionsTarget && (
        <PermissionsModal
          target={permissionsTarget}
          onClose={() => onPermissionsOpenChange(false)}
          onApplied={() => {
            // Both caches: the listing carries the mode column, and the
            // inspector reads its own stat for the selected entry.
            void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, permissionsTarget.hostId] });
            void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.ENTRY, permissionsTarget.hostId] });
          }}
        />
      )}

      {renameTarget && renameMode && (
        <RenameModal
          target={renameTarget}
          initialMode={renameMode}
          onClose={() => onRenameMode(null)}
          onApplied={() => {
            // The listing carries the names, and the inspector's stat is keyed
            // by a path that may no longer exist.
            void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, renameTarget.hostId] });
            void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.ENTRY, renameTarget.hostId] });
            // The selection is a list of names, and those names are what just
            // changed (TRE-16 §3). Leaving it would highlight rows that are
            // gone and hand the next action a stale list.
            dispatch({ type: "selectNone", pane: active });
          }}
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
