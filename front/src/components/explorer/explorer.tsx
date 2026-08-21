"use client";

import { useAuth } from "@auth/context/AuthContext";
import { CompareModal } from "@components/explorer/compare-modal";
import { CreateModal } from "@components/explorer/create-modal";
import { DeleteModal } from "@components/explorer/delete-modal";
import { Inspector } from "@components/explorer/inspector";
import { Pane } from "@components/explorer/pane";
import {
  backTarget,
  explorerReducer,
  forwardTarget,
  initialState,
  openTarget,
  PARENT_NAME,
  upTarget,
} from "@components/explorer/pane-state";
import { PermissionsModal } from "@components/explorer/permissions-modal";
import { RenameModal } from "@components/explorer/rename-modal";
import { TransferModal } from "@components/explorer/transfer-modal";
import { HostManager } from "@components/hosts/host-manager";
import { resolveActions } from "@components/shell/actions";
import { CollapsiblePane } from "@components/ui/collapsible-pane";
import { ContextMenu } from "@components/ui/context-menu";
import { useToast } from "@components/ui/toast";
import { useUploads } from "@components/ui/uploads";
import { cutNamesIn, describeClipboard, nameList, resolvePaste, splitHeld } from "@helpers/clipboard";
import { volumeFor } from "@helpers/disks";
import { globToRegExp, joinPath, parentPath, resolveTarget, sortRows } from "@helpers/listing";
import { createBookmark } from "@lib/api/bookmarks";
import { ApiError } from "@lib/api/client";
import { fetchDisks } from "@lib/api/disks";
import { startDownload } from "@lib/api/download";
import { fetchListing, fetchStat } from "@lib/api/fs";
import { startTransfer } from "@lib/api/transfers";
import { QUERY_KEYS } from "@lib/query/keys";
import { useHashJob } from "@lib/query/use-hash-job";
import { useSignedLink } from "@lib/query/use-signed-link";
import { warmDirectory } from "@lib/query/warm-directory";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useRef, useState } from "react";

import type { CompareCopy, CompareTarget } from "@components/explorer/compare-modal";
import type { CreateMode, CreateTarget } from "@components/explorer/create-modal";
import type { DeleteTargetSelection } from "@components/explorer/delete-modal";
import type { PaneCallbacks } from "@components/explorer/pane";
import type { PaneIndex, PaneView } from "@components/explorer/pane-state";
import type { PermissionsTarget } from "@components/explorer/permissions-modal";
import type { RenameMode, RenameTarget } from "@components/explorer/rename-modal";
import type { TransferTarget } from "@components/explorer/transfer-modal";
import type { ActionContext, ActionId, TargetKind } from "@components/shell/actions";
import type { SplitMode } from "@components/shell/toolbar";
import type { Clipboard, ClipboardMode } from "@helpers/clipboard";
import type { SortKey } from "@helpers/listing";
import type { Point } from "@helpers/menu";
import type { CompareEntry, CompareResult } from "@lib/api/compare";
import type { DiskMount } from "@lib/api/disks";
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
  /** The file this pane's live tail is following (TRE-34), or null for none. */
  tail: string | null;
}

/** A paste that has become a transfer (TRE-71 §4). */
interface PasteInFlight {
  target: TransferTarget;
  /**
   * What was held when it started. Its mode decides whether the clipboard
   * survives the paste, and its directory is the one the names are leaving.
   */
  source: Clipboard;
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
  createMode,
  onCreateMode,
  duplicateRequested,
  onDuplicateRequestedChange,
  deleteOpen,
  onDeleteOpenChange,
  downloadRequested,
  onDownloadRequestedChange,
  uploadRequested,
  onUploadRequestedChange,
  transferMode,
  onTransferMode,
  compareOpen,
  onCompareOpenChange,
  onClipboardChange,
  clearClipboardRequested,
  onClearClipboardRequestedChange,
  onActionContextChange,
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
   * things: the toolbar's button must open the pattern, which nothing else
   * reaches, F2 on one entry means "rename this" and must open the name.
   */
  renameMode: RenameMode | null;
  onRenameMode: (mode: RenameMode | null) => void;
  /**
   * Which create form is open, or null for none (TRE-69). A mode for the same
   * reason `renameMode` is one — the modal serves a directory and a file.
   *
   * Unlike every other target here it is aimed at the pane's *directory*
   * rather than at the selection: a new entry goes into the place the pane is
   * standing in, which is the only place a pane unambiguously names.
   */
  createMode: CreateMode | null;
  onCreateMode: (mode: CreateMode | null) => void;
  /**
   * `duplicate` (TRE-69 §2). A request rather than a state, like the download:
   * it opens nothing, queues a transfer from the selection into the directory
   * that selection already sits in, and reports through the queue widget.
   */
  duplicateRequested: boolean;
  onDuplicateRequestedChange: (requested: boolean) => void;
  /** The toolbar's `rm` button (TRE-25). Owned by the page, like the two above. */
  deleteOpen: boolean;
  onDeleteOpenChange: (open: boolean) => void;
  /**
   * The toolbar's `download` button (TRE-26), owned by the page for the same
   * reason as the three above — except that this one opens nothing, so it is a
   * request rather than a state: the explorer starts the download and turns it
   * off again, and the flag is never true across two renders.
   */
  downloadRequested: boolean;
  onDownloadRequestedChange: (requested: boolean) => void;
  /** The toolbar's `upload` button (TRE-65). A request, like the download. */
  uploadRequested: boolean;
  onUploadRequestedChange: (requested: boolean) => void;
  /**
   * Which transfer modal is open, or null for none (TRE-24). An operation
   * rather than a boolean, for the reason `renameMode` is one: F5 and the
   * `copy` button mean copy, F6 and `move` mean move, and the modal's own
   * heading and CTA say which.
   */
  transferMode: "copy" | "move" | null;
  onTransferMode: (mode: "copy" | "move" | null) => void;
  /**
   * The toolbar's `compare ⇄` button (TRE-28). Owned by the page like the
   * others, and a boolean rather than a target: what it compares is always the
   * two panes' own directories, which this component already knows.
   */
  compareOpen: boolean;
  onCompareOpenChange: (open: boolean) => void;
  /**
   * What the clipboard is holding, in the one sentence the status bar shows
   * (TRE-71 §3) — null when it is holding nothing.
   *
   * A string rather than the store itself: the bar is up in the shell and has
   * no business knowing about hosts, directories and modes, and it is the same
   * inversion `onSelectionChange` already resolves this way.
   */
  onClipboardChange: (held: string | null) => void;
  /**
   * The click on that line, which clears (TRE-71 §3). A request rather than a
   * state, like the toolbar's download: the button is up in the shell and the
   * store is down here, and there is no dialogue for it to be the state of.
   */
  clearClipboardRequested: boolean;
  onClearClipboardRequestedChange: (requested: boolean) => void;
  /**
   * What the toolbar's action row should be resolved against (TRE-70 §4).
   *
   * The row is up in the shell and what it would act on is down here, which is
   * the inversion `onSelectionChange` already resolves this way — except that
   * this one carries no handlers and no reasons, only the facts. The page runs
   * `resolveActions` on it, so the row and the menu are answering the same
   * question with the same function.
   */
  onActionContextChange: (context: ActionContext) => void;
}) {
  const [memory, dispatch] = useReducer(explorerReducer, undefined, () => initialState());
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const uploads = useUploads();
  const queryClient = useQueryClient();
  /** The toolbar's `upload` button clicks this; nothing else touches it. */
  const filePicker = useRef<HTMLInputElement>(null);
  /** Set once a host has been bound automatically, so it happens per pane once. */
  const [seeded, setSeeded] = useState<[boolean, boolean]>([false, false]);
  /**
   * The paste that is being decided, if any (TRE-71 §4).
   *
   * It opens the modal TRE-24 already built rather than one of its own, so the
   * conflict list, the blanket strategy and the free-space refusal are the ones
   * F5 already meets — a second conflict UI is the thing this ticket is most
   * able to invent and least able to justify.
   */
  const [paste, setPaste] = useState<PasteInFlight | null>(null);
  /**
   * A row of the comparison, on its way to the transfer modal (TRE-28 §3).
   *
   * Its own slot rather than `transferMode`'s, because that one is built from
   * the active pane's selection and this one is built from a row somebody
   * clicked in a list — the source may be the *right* pane, which `copyTo` can
   * never mean.
   */
  const [compareCopy, setCompareCopy] = useState<CompareCopy | null>(null);
  /**
   * The open context menu, or null (TRE-70 §5).
   *
   * One for both panes, holding which pane opened it, where the pointer was and
   * which row was under it — `null` for the empty area, `..`, the path row and
   * the tab strip, all of which mean the directory. Everything else the menu
   * shows is derived from those three, so there is no second copy of the
   * selection to keep in step.
   */
  const [menu, setMenu] = useState<{ pane: PaneIndex; point: Point; name: string | null } | null>(null);
  const signedLink = useSignedLink();
  const hashJob = useHashJob();

  const views: [PaneView, PaneView] = [
    { ...memory.panes[0], hostId: panes[0].host, path: panes[0].path, sort: panes[0].sort, dir: panes[0].dir },
    { ...memory.panes[1], hostId: panes[1].host, path: panes[1].path, sort: panes[1].sort, dir: panes[1].dir },
  ];

  /** What `⌘X` or `⌘C` is holding (TRE-71 §1), or null for nothing. */
  const clip = memory.clip;

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
  const volumes = [useVolumeWarning(views[0]), useVolumeWarning(views[1])] as const;

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
  const inspecting =
    inspector ||
    permissionsOpen ||
    renameMode !== null ||
    deleteOpen ||
    downloadRequested ||
    duplicateRequested ||
    transferMode !== null
      ? new Set(activePane.sel)
      : null;
  const inspected = inspecting ? activeView.rows.filter((row) => inspecting.has(row.name)) : [];
  const cursorRow = activeView.rows.find((row) => row.name === activePane.cur) ?? null;
  const cursorPath = cursorRow ? joinPath(activePane.path, cursorRow.name) : null;

  /**
   * Whether anything is up over the panes.
   *
   * The clipboard's four keys stand down for all of it. `⌘V` behind the
   * transfer modal would stack a second one over the first, and `⎋` closes
   * whatever is open long before it gets to mean "never mind" to a pane —
   * `Overlay` listens on this same window, so a clipboard emptied on the way
   * out of a dialog would be two things happening on one keypress.
   */
  const overlayOpen =
    manageHostsFor !== null ||
    permissionsOpen ||
    renameMode !== null ||
    createMode !== null ||
    deleteOpen ||
    transferMode !== null ||
    paste !== null ||
    compareOpen ||
    menu !== null;

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
   * What the delete modal is aimed at (TRE-25).
   *
   * The same rule as the rename above, and deliberately so: the selection, or
   * the row under the cursor. It never falls back to the directory the pane is
   * standing in — that is the one target where a mistake takes the pane's own
   * ground with it.
   */
  const deleteEntries = inspected.length > 0 ? inspected : cursorRow ? [cursorRow] : [];
  const deleteTarget: DeleteTargetSelection | null =
    !deleteOpen || activePane.hostId === null || deleteEntries.length === 0
      ? null
      : { hostId: activePane.hostId, directory: activePane.path, entries: deleteEntries };

  const deleteEmpty =
    deleteOpen &&
    !hostsPending &&
    !activeView.listing.isPending &&
    (activePane.hostId === null || deleteTarget === null);
  useEffect(() => {
    if (!deleteEmpty) return;
    onDeleteOpenChange(false);
    push({ tone: "info", message: "Nothing to delete", detail: "Select an entry, or put the cursor on one" });
  }, [deleteEmpty, onDeleteOpenChange, push]);

  /**
   * What a create is aimed at (TRE-69 §3).
   *
   * The directory the active pane is showing, and never the selection: a new
   * entry goes *into* a place, and the only place a pane names unambiguously is
   * the one it is standing in. It is the same rule the upload follows, for the
   * same reason.
   *
   * The names come from the listing rather than from the rows on screen, so a
   * glob hiding `report.txt` cannot make the modal report that name as free.
   */
  const createTarget: CreateTarget | null =
    createMode === null || activePane.hostId === null
      ? null
      : {
          hostId: activePane.hostId,
          directory: activePane.path,
          existing: (activeView.listing.data?.entries ?? []).map((entry) => entry.name),
        };

  const createEmpty = createMode !== null && !hostsPending && activePane.hostId === null;
  useEffect(() => {
    if (!createEmpty) return;
    onCreateMode(null);
    push({ tone: "info", message: "No host on this pane", detail: "Bind one from the sidebar first" });
  }, [createEmpty, onCreateMode, push]);

  /**
   * What a transfer is aimed at (TRE-24 §1).
   *
   * The active pane's selection is the source and the *other* pane's directory
   * is the destination, which is what F5 and F6 have meant in two-pane file
   * managers for thirty years and what makes the second pane worth having. The
   * selection follows the same rule as the rename and the delete: what is
   * selected, else the row under the cursor.
   *
   * Never the directory the pane is standing in, for a reason those two share
   * and this one sharpens: a transfer aimed at the current directory would copy
   * a pane onto its own neighbour on a keypress meant for one file.
   */
  const otherPane = views[active === 0 ? 1 : 0];
  const transferEntries = inspected.length > 0 ? inspected : cursorRow ? [cursorRow] : [];
  const transferTarget: TransferTarget | null =
    transferMode === null || activePane.hostId === null || otherPane.hostId === null || transferEntries.length === 0
      ? null
      : {
          operation: transferMode,
          srcHostId: activePane.hostId,
          srcPaths: transferEntries.map((entry) => joinPath(activePane.path, entry.name)),
          dstHostId: otherPane.hostId,
          dstPath: otherPane.path,
        };

  /**
   * What a comparison is aimed at (TRE-28 §3).
   *
   * Both panes' own directories, always. Never the selection: "compare these
   * three files with the other pane" is a different question, and one nothing
   * in the mockup or the ticket asks. The two labels are the host names, so the
   * modal's header says which machine is on which side rather than leaving two
   * absolute paths to be told apart by eye.
   */
  const compareTarget: CompareTarget | null =
    !compareOpen || activePane.hostId === null || otherPane.hostId === null
      ? null
      : {
          a: {
            hostId: activePane.hostId,
            path: activePane.path,
            label: hosts.find((host) => host.id === activePane.hostId)?.label ?? "left",
          },
          b: {
            hostId: otherPane.hostId,
            path: otherPane.path,
            label: hosts.find((host) => host.id === otherPane.hostId)?.label ?? "right",
          },
        };

  const compareEmpty = compareOpen && !hostsPending && compareTarget === null;
  useEffect(() => {
    if (!compareEmpty) return;
    onCompareOpenChange(false);
    push({ tone: "info", message: "Nothing to compare", detail: "Both panes need a host" });
  }, [compareEmpty, onCompareOpenChange, push]);

  /**
   * A row of the comparison, opened in both panes.
   *
   * Both panes go to the directory that holds it and put the cursor on the
   * name — the pane that does not have the entry simply shows nothing
   * selected, which is the honest drawing of "only on the other side". The
   * roots come from the *result* rather than from the panes: they are the
   * resolved paths the server actually walked, and a pane that had been given a
   * symlinked path would otherwise be sent somewhere the comparison never
   * looked.
   */
  const revealCompared = (entry: CompareEntry, result: CompareResult) => {
    const relative = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    const sides = [
      { index: active, root: result.a.path, hostId: result.a.hostId },
      { index: active === 0 ? 1 : 0, root: result.b.path, hostId: result.b.hostId },
    ] as const;

    for (const side of sides) {
      const directory = relative === "" ? side.root : `${side.root}/${relative}`;
      dispatch({ type: "navigate", pane: side.index, path: directory });
      onPaneChange(side.index, { host: side.hostId, path: directory });
      dispatch({ type: "reveal", pane: side.index, name });
    }
  };

  // Answered once the pane knows its own contents, and not while it is still
  // loading them — the same shape the rename and delete use, and for the same
  // reason: the toolbar button is up in the shell and cannot see any of this.
  const transferEmpty =
    transferMode !== null && !hostsPending && !activeView.listing.isPending && transferTarget === null;
  useEffect(() => {
    if (!transferEmpty) return;
    onTransferMode(null);
    push(
      otherPane.hostId === null
        ? { tone: "info", message: "No host on the other pane", detail: "A transfer needs somewhere to go" }
        : { tone: "info", message: "Nothing to transfer", detail: "Select an entry, or put the cursor on one" },
    );
  }, [transferEmpty, otherPane.hostId, onTransferMode, push]);

  /**
   * Taking a selection (TRE-71 §1, §2).
   *
   * The same rule every other operation here follows — what is selected, else
   * the row under the cursor — and names rather than rows, because names are
   * what the store holds and what a fresh listing is checked against. The rows
   * on screen are from whenever this pane last loaded, which is precisely what
   * a paste is not allowed to trust.
   *
   * The cursor is read through `cursorRow` rather than raw, because it can be
   * standing on `..` (TRE-77) — and that is a directory to walk into, not a
   * name to hand a transfer.
   */
  const heldNames = activePane.sel.length > 0 ? activePane.sel : cursorRow ? [cursorRow.name] : [];
  const take = (mode: ClipboardMode) => {
    if (activePane.hostId === null || heldNames.length === 0) {
      push({
        tone: "info",
        message: mode === "cut" ? "Nothing to cut" : "Nothing to copy",
        detail: "Select an entry, or put the cursor on one",
      });
      return;
    }
    dispatch({ type: "hold", mode, hostId: activePane.hostId, directory: activePane.path, names: heldNames });
  };

  /**
   * Putting it down (TRE-71 §4).
   *
   * `POST /transfers`, copy or move by the held mode, aimed at the directory
   * the active pane is showing. Another host is the same call and not a special
   * case, which is the whole reason a clipboard was cheap to add: TRE-23
   * already moves bytes between two machines and answers for the conflicts.
   *
   * What happens before that call is the interesting half. The held names were
   * true when they were taken, and a paste that trusts them hands the server a
   * source path that may no longer resolve — over which it refuses the whole
   * job rather than the one entry. So the source directory is listed again
   * first, and whatever has gone is dropped and named.
   */
  const putDown = async () => {
    // Read before any await: the pane the key was pressed in is the
    // destination, and listing another machine is a round trip during which
    // somebody can point that pane somewhere else.
    const destination = { hostId: activePane.hostId, path: activePane.path };
    const decision = resolvePaste(clip, destination);

    if (decision.kind === "empty") {
      // Silently. Nothing is held, nothing was promised, and the menu's
      // disabled `paste` entry is where that gets explained (TRE-70).
      return;
    }
    if (decision.kind === "unbound") {
      push({ tone: "info", message: "No host on this pane", detail: "Bind one from the sidebar first" });
      return;
    }
    if (decision.kind === "sameDirectory") {
      // A no-op, not an error: a move onto its own directory has nothing to do
      // and nothing to report, and a modal about zero items would be a worse
      // way to say so than one line.
      push({ tone: "info", message: "Already here", detail: "These were cut from this directory" });
      return;
    }

    const { source, operation } = decision;

    let entries: readonly string[];
    try {
      const listing = await queryClient.fetchQuery({
        queryKey: [QUERY_KEYS.DIRECTORY, source.hostId, source.directory],
        queryFn: () => fetchListing(source.hostId, source.directory),
        // Asked again, never served from the cache: the point of this call is
        // to find out what changed since the cut, and a cached answer is from
        // before it.
        staleTime: 0,
      });
      entries = listing.entries.map((entry) => entry.name);
    } catch (error) {
      push({
        tone: "warning",
        message: "Could not read where these came from",
        detail: error instanceof ApiError ? error.message : source.directory,
      });
      return;
    }

    const { present, missing } = splitHeld(source.names, entries);

    if (present.length === 0) {
      // Nothing held still exists, so there is no job to start and nothing left
      // worth holding — the argument §1 makes against a clipboard that outlives
      // a reload, arriving a few minutes earlier.
      dispatch({ type: "release" });
      push({ tone: "info", message: "Nothing left to paste", detail: `${nameList(missing)} no longer there` });
      return;
    }
    if (missing.length > 0) {
      push({
        tone: "info",
        message: "Some of these are gone",
        detail: `${nameList(missing)} — the rest still ${operation}`,
      });
    }

    setPaste({
      source,
      target: {
        operation,
        srcHostId: source.hostId,
        srcPaths: present.map((name) => joinPath(source.directory, name)),
        // Not null: `resolvePaste` answers `unbound` for a pane without a host.
        dstHostId: destination.hostId as string,
        dstPath: destination.path,
      },
    });
  };

  /**
   * What the status bar says while something is held, and its click (TRE-71 §3).
   *
   * The sentence goes up rather than the store, so the bar needs to know
   * nothing about hosts and modes; the click comes back as a request, the way
   * the toolbar's download does, because the button is up in the shell and the
   * store is down here.
   */
  const heldLabel =
    clip === null ? null : describeClipboard(clip, hosts.find((host) => host.id === clip.hostId)?.label ?? null);
  useEffect(() => {
    onClipboardChange(heldLabel);
  }, [heldLabel, onClipboardChange]);

  useEffect(() => {
    if (!clearClipboardRequested) return;
    onClearClipboardRequestedChange(false);
    dispatch({ type: "release" });
  }, [clearClipboardRequested, onClearClipboardRequestedChange]);

  /**
   * The same, for the toolbar's row (TRE-70 §4).
   *
   * Its target is the rule every one of its buttons already follows: what is
   * selected, else the row under the cursor. Reported on a signature rather than
   * on the object, because the object is new on every render and this effect
   * would otherwise be an infinite loop rather than an update.
   */
  const toolbarSelected = new Set(activePane.sel);
  const toolbarEntries =
    activePane.sel.length > 0
      ? activeView.rows.filter((row) => toolbarSelected.has(row.name))
      : cursorRow
        ? [cursorRow]
        : [];
  const toolbarKinds = toolbarEntries.map((row) => row.type);
  const toolbarContext: ActionContext = {
    kind: "entries",
    entries: toolbarKinds,
    hostId: activePane.hostId,
    otherHostId: otherPane.hostId,
    holding: clip !== null,
  };
  const toolbarKey = `${activePane.hostId}|${otherPane.hostId}|${clip !== null}|${toolbarKinds.join(",")}`;
  useEffect(() => {
    onActionContextChange(toolbarContext);
    // `toolbarContext` is rebuilt every render and `toolbarKey` is what actually
    // changed about it.
  }, [toolbarKey, onActionContextChange]);

  /**
   * What the open menu is about (TRE-70 §2).
   *
   * The target decides which entries **exist**; the context decides which are
   * **enabled**. Both are derived here rather than stored, because the pane's
   * selection is the answer to "what would this act on" for every other surface
   * in the app and a menu with its own copy of it is a menu that can disagree
   * with the status bar.
   *
   * The selection was already put right when the menu opened: a row outside it
   * became it, a row inside it left it alone. So by the time this runs, `sel` is
   * what was right-clicked — except in the one case a pane can have no
   * selection at all, where the clicked name stands in for it.
   */
  const menuView = menu ? views[menu.pane] : null;
  const menuKind: TargetKind = menu === null || menu.name === null ? "directory" : "entries";
  const menuNames =
    menuKind === "entries" && menuView ? (menuView.sel.length > 0 ? menuView.sel : menu?.name ? [menu.name] : []) : [];
  // Indexed rather than searched, like everywhere else that asks the selection a
  // question once per row (TRE-19 §2).
  const menuWanted = new Set(menuNames);
  const menuEntries = menu ? rendered[menu.pane].rows.filter((row) => menuWanted.has(row.name)) : [];

  const menuContext: ActionContext = {
    kind: menuKind,
    entries: menuEntries.map((row) => row.type),
    hostId: menuView?.hostId ?? null,
    otherHostId: menu ? views[menu.pane === 0 ? 1 : 0].hostId : null,
    holding: clip !== null,
  };

  /** The header, which is also the menu's accessible name. */
  const menuLabel =
    menu === null
      ? ""
      : menuKind === "directory"
        ? (menuView?.path ?? "/")
        : menuEntries.length === 1
          ? menuEntries[0].name
          : `${menuEntries.length} entries`;

  /** The clipboard, for the two entries that talk to the operating system's. */
  const toClipboard = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      push({ tone: "success", message, detail: text });
    } catch {
      // Refused on an insecure origin and in some configurations. Say what
      // happened rather than reporting a failure of the thing being copied.
      push({ tone: "warning", message: "Could not copy", detail: "This browser refused clipboard access." });
    }
  };

  const addFavourite = (hostId: string, path: string) => {
    const label = path === "/" ? "/" : (path.split("/").filter(Boolean).pop() ?? "/");
    void createBookmark({ hostId, path, label }, csrfToken).then(
      () => {
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.BOOKMARKS] });
        push({ tone: "success", message: "Added to favourites", detail: path });
      },
      (error: unknown) => {
        push({
          tone: "warning",
          message: "Could not add that favourite",
          detail: error instanceof ApiError ? error.message : path,
        });
      },
    );
  };

  /**
   * What choosing an entry does (TRE-70 §4).
   *
   * Every one of these is the thing the toolbar button or the shortcut already
   * does — the same setter, opening the same modal, against the same target.
   * None of them is a second path to a dialogue, which is what keeps the menu
   * from developing its own opinions about what `rm` means.
   */
  const chooseAction = (id: string) => {
    const opened = menu;
    setMenu(null);
    if (opened === null) return;

    const index = opened.pane;
    const view = views[index];
    const hostId = view.hostId;
    const first = menuEntries[0] ?? null;

    switch (id as ActionId) {
      case "newDir":
        onCreateMode("dir");
        return;
      case "newFile":
        onCreateMode("file");
        return;
      case "open":
        if (first) open(index, first);
        return;
      case "openOther": {
        if (!first || hostId === null) return;
        const other = index === 0 ? 1 : 0;
        // A link is followed to where it points, exactly as `open` follows it —
        // the other pane should land where double-clicking would have.
        const path =
          first.type === "link" && first.linkTarget
            ? resolveTarget(view.path, first.linkTarget)
            : joinPath(view.path, first.name);
        // Both writes, as `go` issues them — and the host too, because the pane
        // over there may be on another machine or on none.
        dispatch({ type: "navigate", pane: other, path });
        onPaneChange(other, { host: hostId, path });
        return;
      }
      case "cut":
        take("cut");
        return;
      case "copy":
        take("copy");
        return;
      case "paste":
        void putDown();
        return;
      case "duplicate":
        onDuplicateRequestedChange(true);
        return;
      case "copyTo":
        onTransferMode("copy");
        return;
      case "moveTo":
        onTransferMode("move");
        return;
      case "refresh":
        // Its own row because a listing can go stale from another machine
        // entirely, and F5 is spent on copy.
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, hostId, view.path] });
        return;
      case "rename":
        // One entry opens on the name and a selection on the pattern, which is
        // the rule F2 already follows.
        onRenameMode(menuEntries.length === 1 ? "name" : "pattern");
        return;
      case "chmod":
        onPermissionsOpenChange(true);
        return;
      case "download":
        onDownloadRequestedChange(true);
        return;
      case "tail":
        // The context menu is the second of the strip's three mechanisms and
        // the only one that works outside a log-looking directory (TRE-34 §3):
        // a log lives wherever somebody's deploy put it, and the heuristic is
        // an offer rather than a rule about where logs may be.
        if (first && hostId !== null) onPaneChange(index, { tail: joinPath(view.path, first.name) });
        return;
      case "upload":
        onUploadRequestedChange(true);
        return;
      case "link":
        if (first && hostId !== null) signedLink.mutate({ hostId, path: joinPath(view.path, first.name) });
        return;
      case "compare":
        onCompareOpenChange(true);
        return;
      case "hash":
        // Every selected entry, not just the first: a directory among them is
        // expanded server-side into the files under it, so "hash this folder"
        // and "hash these four files" are one request.
        if (hostId !== null && menuEntries.length > 0) {
          hashJob.mutate({ hostId, paths: menuEntries.map((entry) => joinPath(view.path, entry.name)) });
        }
        return;
      case "copyPath":
        void toClipboard(first ? joinPath(view.path, first.name) : view.path, "Path copied");
        return;
      case "copyName":
        if (first) void toClipboard(first.name, "Name copied");
        return;
      case "favourite":
        if (hostId !== null) addFavourite(hostId, first ? joinPath(view.path, first.name) : view.path);
        return;
      case "rm":
        onDeleteOpenChange(true);
        return;
      default:
        return;
    }
  };

  /**
   * What a download is aimed at (TRE-26).
   *
   * The selection, or the row under the cursor — the same rule the rename and
   * the delete follow. One entry, though, where they take many: the route takes
   * one path, because a file streams as itself and a directory streams as a zip
   * and there is no third shape that is several of either. Several selected
   * entries are answered with the way to get them, which is to download the
   * directory holding them.
   *
   * It runs from an effect because the button is in the toolbar and the
   * selection is here — the inversion the modals resolve the same way. The flag
   * is cleared first so this cannot fire twice for one press.
   */
  const downloadEntries = inspected.length > 0 ? inspected : cursorRow ? [cursorRow] : [];
  useEffect(() => {
    if (!downloadRequested) return;
    onDownloadRequestedChange(false);

    if (activePane.hostId === null || downloadEntries.length === 0) {
      push({ tone: "info", message: "Nothing to download", detail: "Select an entry, or put the cursor on one" });
      return;
    }
    if (downloadEntries.length > 1) {
      push({
        tone: "info",
        message: "One at a time",
        detail: "A download takes one entry. Download the directory to get several as a zip.",
      });
      return;
    }

    // No success toast. The browser has a downloads list, a progress indicator
    // and a Save-As of its own, and a toast saying "started" over the top of
    // them is a second, worse copy of what the user is already looking at.
    startDownload(activePane.hostId, joinPath(activePane.path, downloadEntries[0].name));
  }, [downloadRequested, onDownloadRequestedChange, activePane, downloadEntries, push]);

  /**
   * Duplicating where it stands (TRE-69 §2).
   *
   * A copy of the selection into the directory it is already in, which is the
   * one transfer whose destination is not the other pane — so it takes the same
   * `srcPaths`, aims them at `activePane.path`, and asks the server to land
   * them under free names. `report.txt` becomes `report (2).txt`, from the
   * server's `numberedName`; nothing here computes that.
   *
   * There is no modal, and no conflict list, because there are no conflicts to
   * answer: every name is free by construction. What it becomes is a job in the
   * queue, which is right rather than convenient — duplicating a 40 GB
   * directory is a transfer whatever the button was called, and it belongs in
   * the same widget with the same cancel.
   */
  const duplicateEntries = inspected.length > 0 ? inspected : cursorRow ? [cursorRow] : [];
  useEffect(() => {
    if (!duplicateRequested) return;
    onDuplicateRequestedChange(false);

    if (activePane.hostId === null || duplicateEntries.length === 0) {
      push({ tone: "info", message: "Nothing to duplicate", detail: "Select an entry, or put the cursor on one" });
      return;
    }

    const names = duplicateEntries.map((entry) => entry.name);
    void startTransfer(
      {
        srcHostId: activePane.hostId,
        srcPaths: names.map((name) => joinPath(activePane.path, name)),
        dstHostId: activePane.hostId,
        dstPath: activePane.path,
        operation: "copy",
        // Answers the per-item conflicts inside a duplicated directory, which
        // are the only ones there can be — the top-level names are free.
        strategy: "keepBoth",
        duplicate: true,
      },
      csrfToken,
    ).then(
      () => {
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.TRANSFERS] });
        // No success toast: the queue widget is about to show the job with a
        // progress bar, and the panes are refreshed when it finishes.
      },
      (error: unknown) => {
        push({
          tone: "warning",
          message: names.length === 1 ? `Could not duplicate ${names[0]}` : "Could not duplicate",
          detail: error instanceof ApiError ? error.message : "The host refused.",
        });
      },
    );
  }, [duplicateRequested, onDuplicateRequestedChange, activePane, duplicateEntries, csrfToken, queryClient, push]);

  /**
   * Uploading into a pane (TRE-65).
   *
   * Two ways in and one implementation. The toolbar's button opens the file
   * picker below, and a drop on a pane arrives with its files already chosen —
   * both end here, aimed at the directory that pane is showing.
   *
   * Not at the selection: an upload goes *into* a place, and the only place a
   * pane unambiguously names is the directory it is standing in. Dropping onto
   * a highlighted folder row would be a nicer gesture and a worse promise —
   * there is no way to show, mid-drag, which of the two it decided on.
   */
  const uploadInto = (pane: PaneIndex, files: readonly File[]) => {
    const view = views[pane];
    if (view.hostId === null) {
      push({ tone: "info", message: "No host on that pane", detail: "Bind one from the sidebar first" });
      return;
    }
    if (files.length === 0) return;

    void uploads.start(view.hostId, view.path, files).then(() => {
      // Once, at the end of the batch. Per file would re-list the directory
      // fifty times for fifty files, and the intermediate listings are of a
      // directory that is still being written into.
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, view.hostId] });
    });
  };

  useEffect(() => {
    if (!uploadRequested) return;
    onUploadRequestedChange(false);

    if (activePane.hostId === null) {
      push({ tone: "info", message: "No host on this pane", detail: "Bind one from the sidebar first" });
      return;
    }
    // The picker is a hidden input rather than `showOpenFilePicker`, which
    // exists in one browser engine. Clicking it from here keeps the user
    // gesture alive, which is what a file dialogue needs.
    filePicker.current?.click();
  }, [uploadRequested, onUploadRequestedChange, activePane, push]);

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
    // The manager is a modal: ↓ over it belongs to nothing behind it. So is an
    // open menu — `↓` over one belongs to the menu (TRE-70 §6).
    enabled: manageHostsFor === null && menu === null,
    onKey: (event) => {
      const index = active;
      const up = upTarget(views[index].path);
      // The rows the cursor can stand on: the listing, plus the `..` the pane
      // draws above it when there is one (TRE-77). ⌘A below, and the rename,
      // delete and download targets, keep asking `rows` alone — a same-looking
      // expression over a different set, and deliberately so. `..` is a place
      // to put the cursor and never a thing to operate on, which is why the
      // reducer refuses it a place in the selection.
      const rowNames = rendered[index].rows.map((row) => row.name);
      const names = up ? [PARENT_NAME, ...rowNames] : rowNames;

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
          // `..` is answered ahead of the lookup, because `rows` does not carry
          // it: ⏎ on the cursor's row means what a double-click on that row
          // means, and on this one that is up.
          if (views[index].cur === PARENT_NAME) {
            if (up) go(index, up);
            return true;
          }
          const row = rendered[index].rows.find((candidate) => candidate.name === views[index].cur);
          if (row) open(index, row);
          return true;
        }
        case "Backspace": {
          // Still one keypress, and still the cheap route: making `..` a row
          // took the single click away from it and nothing else (TRE-77).
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
        case "F3":
          // F3 is "view" in the two-pane managers this app is shaped after, and
          // there is nothing to view yet. Download is the nearest true thing —
          // getting the file somewhere you can open it — and the toolbar button
          // carries the same hint, so the two teach each other.
          onActiveChange(index);
          onDownloadRequestedChange(true);
          return true;
        case "F7":
          // `mkdir` in the two-pane managers this app takes its other F-keys
          // from, and not the ⇧⌘N the design spec drew: Chrome and Firefox both
          // take that chord for a private window before the page sees it, so a
          // shortcut advertised as ⇧⌘N would be a shortcut that never fires.
          onActiveChange(index);
          onCreateMode("dir");
          return true;
        case "F5":
        case "F6":
          // The pane the key was pressed in becomes the source, and the other
          // one is the destination — which is why the active pane is named
          // before the modal opens, exactly as F2 does.
          onActiveChange(index);
          onTransferMode(event.key === "F5" ? "copy" : "move");
          return true;
        case "Delete":
          // `⌦`, not `⌫` — that one goes up a directory, three lines above.
          // Forward delete is `fn`+`⌫` on a Mac keyboard, which is exactly the
          // amount of deliberate a destructive default should cost (TRE-67).
          //
          // Nothing else is needed here: `deleteEntries` resolves the target on
          // the same rule the rename does, and the `deleteEmpty` effect answers
          // an empty pane where the toolbar's button lands too, rather than
          // twice in two voices.
          onActiveChange(index);
          onDeleteOpenChange(true);
          return true;
        case "ContextMenu":
        case "F10": {
          // ⇧F10 and the Menu key, because without them the whole feature needs
          // a mouse and the rest of this app does not (TRE-70 §6). Plain F10 is
          // the browser's, and stays the browser's.
          if (event.key === "F10" && !event.shiftKey) return false;
          // `..` is a row the cursor can stand on and never one the menu is
          // about (TRE-77): what it offers there is the directory's shape, the
          // same as a right-click on it or on the empty area below the rows.
          // But it is a row *on screen*, with an outline round it, so the menu
          // still has to open under it rather than at the fallback below.
          const onParent = views[index].cur === PARENT_NAME;
          const row = onParent
            ? undefined
            : rendered[index].rows.find((candidate) => candidate.name === views[index].cur);
          // Anchored to the cursor row by asking the DOM where it landed, which
          // is the only thing that knows: the listing is virtualised and a row's
          // position is a scroll offset, not an index (TRE-19).
          const selector = onParent ? "[data-parent-row]" : row ? `[data-row="${CSS.escape(row.name)}"]` : null;
          const element = selector ? document.querySelector<HTMLElement>(`[data-pane="${index}"] ${selector}`) : null;
          const rect = element?.getBoundingClientRect() ?? null;
          setMenu({
            pane: index,
            // Its bottom-left corner, so the menu opens under the row rather
            // than over it. The fallback is for a pane with no cursor at all, or
            // one whose cursor row has been scrolled out of the window and so is
            // not in the DOM to be measured.
            point: rect ? { x: rect.left, y: rect.bottom } : { x: window.innerWidth / 4, y: window.innerHeight / 3 },
            name: row?.name ?? null,
          });
          return true;
        }
        case "Escape":
          // The one key that reliably means "never mind", and with nothing else
          // open there is nothing else to press. Ours only while something is
          // held and nothing is over the panes — every dialog in this app
          // listens for `⎋` on this same window, and clearing the clipboard on
          // the way out of one would be two things happening on one keypress.
          if (overlayOpen || clip === null) return false;
          dispatch({ type: "release" });
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

  // ⌘D duplicates the selection (TRE-69 §2). Out of the fields, like ⌘A: the
  // browser's own ⌘D is "bookmark this page", which nobody wants from a file
  // manager, but inside a text field the chord is not ours to take.
  useShortcut({
    enabled: manageHostsFor === null,
    key: "d",
    inFields: false,
    onPress: () => onDuplicateRequestedChange(true),
  });

  // ⌘X, ⌘C and ⌘V (TRE-71 §2). Out of the fields, like ⌘A and ⌘D: inside the
  // glob input these three mean what they mean in every text field, and a file
  // manager that takes them there has broken the one control it has.
  //
  // No menu need be open. The one TRE-70 draws is a second way to reach these,
  // not the way.
  useShortcut({ enabled: !overlayOpen, key: "x", inFields: false, onPress: () => take("cut") });
  useShortcut({ enabled: !overlayOpen, key: "c", inFields: false, onPress: () => take("copy") });
  useShortcut({ enabled: !overlayOpen, key: "v", inFields: false, onPress: () => void putDown() });

  const callbacksFor = (index: PaneIndex): PaneCallbacks => {
    /**
     * The rows a click can land on, `..` included (TRE-77).
     *
     * A function rather than a value because this runs on every render for both
     * panes and the array is only wanted when somebody clicks — walking ten
     * thousand rows twice a paint to answer nothing is the shape TRE-19 spent
     * its time removing.
     *
     * `..` is in it so a ⇧-click that runs off the top of the listing still
     * extends to the first real row rather than falling back to a plain click.
     * The reducer keeps it out of the selection the range produces.
     */
    const clickNames = () => {
      const rowNames = rendered[index].rows.map((row) => row.name);
      return upTarget(views[index].path) ? [PARENT_NAME, ...rowNames] : rowNames;
    };

    return {
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
          names: clickNames(),
          extend: modifiers.extend,
          toggle: modifiers.toggle,
        }),
      onHostMenu: () => onManageHosts(index),
      onClearGlob: () => onGlobChange(""),
      onTail: (path) => onPaneChange(index, { tail: path }),
      onFilesDropped: (files) => uploadInto(index, files),
      onContextMenu: (point, name) => {
        // The inactive pane is activated first, or the menu, the status bar and
        // the toolbar would describe three different things (§2).
        onActiveChange(index);

        // A row **outside** the selection becomes the selection and takes the
        // cursor: a menu acting on entries the operator cannot see is merely
        // confusing for most of these and unforgivable for `rm`. A row **inside**
        // it leaves the selection alone, which is the only way to act on a
        // multi-selection without destroying it on the way to the menu.
        if (name !== null && !views[index].sel.includes(name)) {
          dispatch({
            type: "click",
            pane: index,
            name,
            names: clickNames(),
            extend: false,
            toggle: false,
          });
        }

        // Assigned rather than toggled: a right-click while one is already open
        // moves it, rather than stacking a second or dismissing the first (§5).
        setMenu({ pane: index, point, name });
      },
    };
  };

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
                // Named so ⇧F10 can find the cursor row inside *this* pane: two
                // panes can be showing the same directory, and the same name.
                data-pane={index}
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
                  volume={volumes[index]}
                  // The names this pane should draw dimmed, which is only ever
                  // a cut and only ever where it was taken from (TRE-71 §3).
                  cut={cutNamesIn(clip, pane.hostId, pane.path)}
                  // From the URL rather than from `views`, which carries what
                  // the reducer remembers: a tail is a link's business, not a
                  // session's, and it is read back from the query string on a
                  // cold open (TRE-34 §3).
                  tail={panes[index].tail}
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

      {createTarget && createMode && (
        <CreateModal
          target={createTarget}
          initialMode={createMode}
          onClose={() => onCreateMode(null)}
          onCreated={(entry) => {
            void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, createTarget.hostId] });
            // Created and then found, which is one gesture rather than two. The
            // name means nothing until the refetch lands and everything the
            // moment it does — the reducer holds names, not indices.
            dispatch({ type: "reveal", pane: active, name: entry.name });
          }}
        />
      )}

      {deleteTarget && (
        <DeleteModal
          target={deleteTarget}
          onClose={() => onDeleteOpenChange(false)}
          onApplied={() => {
            void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, deleteTarget.hostId] });
            void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.ENTRY, deleteTarget.hostId] });
            // The selection names entries that no longer exist. Leaving it would
            // hand the next action a list of ghosts — and the next action might
            // be this one again.
            dispatch({ type: "selectNone", pane: active });
          }}
        />
      )}

      {transferTarget && (
        <TransferModal
          target={transferTarget}
          hosts={hosts}
          onClose={() => onTransferMode(null)}
          onStarted={() => {
            // The panes are refreshed when the job *finishes*, not now — that
            // is `TransferProvider`'s doing, because the transfer outlives this
            // component. What is cleared here is the selection: a move is about
            // to take those names away, and handing the next action a list of
            // ghosts is the mistake the delete modal already avoids this way.
            dispatch({ type: "selectNone", pane: active });
          }}
        />
      )}

      {paste && (
        <TransferModal
          target={paste.target}
          hosts={hosts}
          onClose={() => setPaste(null)}
          onStarted={() => {
            // A copy is kept, because pasting the same files into three
            // directories is exactly what a copy is for (§4).
            if (paste.source.mode !== "cut") return;

            // A cut is spent the moment the job is accepted: the bytes are on
            // their way and the rows it dimmed are about to stop existing.
            dispatch({ type: "release" });
            // And any pane standing where they were stops naming them. The
            // transfer modal clears the pane it was started from for this
            // reason; a paste has to look for that pane instead, because the
            // one it was started from is the destination.
            for (const index of [0, 1] as const) {
              if (views[index].hostId === paste.source.hostId && views[index].path === paste.source.directory) {
                dispatch({ type: "selectNone", pane: index });
              }
            }
          }}
        />
      )}

      {compareTarget && (
        <CompareModal
          target={compareTarget}
          onClose={() => onCompareOpenChange(false)}
          onReveal={revealCompared}
          onCopy={(copy) => {
            // The comparison closes rather than stacking a second dialog over
            // itself: `Overlay` listens for ⎋ on the window, so two open at
            // once would both answer one keypress. The tree is about to change
            // underneath the list anyway, which is the other reason not to
            // return to it.
            onCompareOpenChange(false);
            setCompareCopy(copy);
          }}
        />
      )}

      {compareCopy && (
        <TransferModal
          target={{
            operation: "copy",
            srcHostId: compareCopy.srcHostId,
            srcPaths: [compareCopy.srcPath],
            dstHostId: compareCopy.dstHostId,
            dstPath: compareCopy.dstPath,
          }}
          hosts={hosts}
          onClose={() => setCompareCopy(null)}
          onStarted={() => setCompareCopy(null)}
        />
      )}

      {menu && (
        <ContextMenu
          point={menu.point}
          label={menuLabel}
          rows={resolveActions(menuContext, "menu")}
          onChoose={chooseAction}
          onClose={() => setMenu(null)}
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

      {/* The toolbar's upload button, which is a file dialogue wearing a
          button's clothes. Hidden rather than absent: `.click()` on an input
          that is not in the document opens nothing. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          uploadInto(active, [...(event.target.files ?? [])]);
          // Cleared so choosing the same file twice fires `change` twice. An
          // input keeps its value, and the second attempt would be silent.
          event.target.value = "";
        }}
      />
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

/**
 * The filesystem this pane is standing on, and only when it is worth saying
 * (TRE-33 §1).
 *
 * Null unless the volume is over the threshold, so the pane header carries a
 * warning rather than a reading: a badge that always says how full the disk is
 * would be four words of furniture, and the one time it matters is the one time
 * nobody would notice it had changed.
 *
 * Keyed on the host alone, so the two panes and the sidebar's volumes panel are
 * one `df` between them however many of them are pointed at the same machine.
 */
function useVolumeWarning(pane: PaneView): DiskMount | null {
  const { data: disks } = useQuery({
    queryKey: [QUERY_KEYS.HOST_DISKS, pane.hostId],
    queryFn: () => fetchDisks(pane.hostId as string),
    enabled: pane.hostId !== null,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
    throwOnError: false,
  });

  const volume = disks ? volumeFor(pane.path, disks) : null;
  return volume?.warn ? volume : null;
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
