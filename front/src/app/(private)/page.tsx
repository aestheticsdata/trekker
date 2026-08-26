"use client";

import { Explorer } from "@components/explorer/explorer";
import { SudoBadge } from "@components/hosts/sudo-badge";
import { AccountMenu } from "@components/shell/account-menu";
import { isRule, resolveActions } from "@components/shell/actions";
import { AppShell } from "@components/shell/app-shell";
import { DiskUsage } from "@components/shell/disk-usage";
import { Sidebar } from "@components/sidebar/sidebar";
import { ViewForm } from "@components/views/view-form";
import { ViewList } from "@components/views/view-list";
import { ViewMenu } from "@components/views/view-menu";
import { ViewRebind } from "@components/views/view-rebind";
import { ViewStrip } from "@components/views/view-strip";
import { formatInstant, formatSize } from "@helpers/listing";
import { brokenPanes, isDirty, layoutOf } from "@helpers/views";
import { fetchHostMetrics, fetchHostSummary, fetchHosts } from "@lib/api/hosts";
import { fetchViews } from "@lib/api/views";
import { QUERY_KEYS } from "@lib/query/keys";
import { explorerParams, LEFT_KEYS, paneParams, RIGHT_KEYS } from "@lib/url/explorer-params";
import { useSessionLayout } from "@lib/url/use-session-layout";
import { useQuery } from "@tanstack/react-query";
import { useQueryStates } from "nuqs";
import { useState } from "react";

import type { CreateMode } from "@components/explorer/create-modal";
import type { PaneUrl } from "@components/explorer/explorer";
import type { PaneIndex } from "@components/explorer/pane-state";
import type { RenameMode } from "@components/explorer/rename-modal";
import type { ActionContext, ActionId } from "@components/shell/actions";
import type { SelectionSummary } from "@components/shell/status-bar";
import type { Point } from "@helpers/menu";
import type { FileRow } from "@lib/api/fs";
import type { HostView } from "@lib/api/hosts";
import type { SavedView, StoredLayout, ViewLayout } from "@schemas/layout";

/**
 * The explorer, in the chrome (TRE-16, TRE-18).
 *
 * This page owns the layout, and the layout lives in the URL. Copy the address
 * into another tab and both panes come back on their own hosts, at their own
 * paths, sorted the way they were, with the same split, heat map and glob — a
 * saved view is a link, which is the whole reason TRE-18 did this before there
 * were more components to rewrite.
 *
 * The selection and the cursor are deliberately not here. They change on every
 * arrow key and mean nothing to whoever opens the link.
 */

export default function HomePage() {
  const [shared, setShared] = useQueryStates(explorerParams);
  const [left, setLeft] = useQueryStates(paneParams, { urlKeys: LEFT_KEYS });
  const [right, setRight] = useQueryStates(paneParams, { urlKeys: RIGHT_KEYS });

  // Neither is worth a URL: one is a render detail, the other changes with the
  // keyboard cursor.
  const [globMatches, setGlobMatches] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ row: FileRow; path: string } | null>(null);
  const [manageHostsFor, setManageHostsFor] = useState<PaneIndex | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [renameMode, setRenameMode] = useState<RenameMode | null>(null);
  /**
   * Which create form is open, or null for none (TRE-69). A mode rather than a
   * boolean for the reason `renameMode` is one: the modal serves a directory
   * and a file, and whichever the caller asked for is the one it opens on.
   */
  const [createMode, setCreateMode] = useState<CreateMode | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  /**
   * Whether the terminal is showing (TRE-35 §3).
   *
   * Local rather than URL-backed, which is where the inspector and the strip
   * keep the same kind of flag. The difference is what a reload should do: a
   * link that reopens somebody's split and their two directories is the point
   * of the URL, and a link that also reopens a terminal is a link that types
   * into somebody else's session. `⌥↩` brings it back with its history intact —
   * that part *is* persisted, per tab, which is what the ticket asks for.
   */
  const [terminalOpen, setTerminalOpen] = useState(false);
  /**
   * Whether the ⌘K palette is showing (TRE-36).
   *
   * Local, like the terminal and for the same reason: a link that restores
   * somebody's split and their two directories is what the URL is for, and a
   * link that also arrives with a command palette open is a link that types
   * into somebody else's session.
   */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * What the palette opens with. Only ever set by the views strip's `+n`
   * overflow, which opens it on the word `view` rather than growing a menu.
   */
  const [paletteQuery, setPaletteQuery] = useState("");
  /**
   * The saved view currently on screen, or null when the layout belongs to
   * nobody in particular (TRE-37 §3).
   *
   * Local, and deliberately not in the URL. A link is already a layout — that
   * is what TRE-18 built — and carrying a view id in it would mean a recipient
   * seeing a name for something that is not theirs, or worse, a chip lit for a
   * view of their own that happens to share an id. What travels is the
   * arrangement; the name for it is this session's.
   *
   * Cleared by nothing except restoring another one. Moving a pane makes the
   * view *dirty*, not absent: the dot exists precisely to say "this is `deploy`,
   * changed", and dropping the name at the first arrow key would delete the
   * only thing that sentence needs.
   */
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  /** Which view's menu is open and where, or null for none. */
  const [viewMenu, setViewMenu] = useState<{ id: string; point: Point } | null>(null);
  /**
   * Whether the account menu is showing (TRE-90).
   *
   * Held here rather than inside the chip because the explorer's keyboard layer
   * is what has to know: `overlayOpen` gates every shortcut, the terminal chord
   * and the view chords, and a floating panel that did not stand them down
   * would take ⌫ and ⌘X while it was the thing on screen.
   */
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  /**
   * The save form: null when closed, `{ id: null }` when saving what is on
   * screen, `{ id }` when editing one that exists. A shape rather than two
   * booleans, for the reason `renameMode` is one.
   */
  const [viewForm, setViewForm] = useState<{ id: string | null } | null>(null);
  /** The view whose host has gone, waiting for somewhere to put that pane. */
  const [viewRebindId, setViewRebindId] = useState<string | null>(null);
  /**
   * A request, not a state (TRE-26).
   *
   * The other three flags open a modal that stays open. This one asks the
   * explorer to start a download and is turned off again the moment it has,
   * because the explorer is where the selection lives and the toolbar button is
   * up here — the same inversion the modals already resolve this way, for an
   * action that has no dialogue of its own.
   */
  const [downloadRequested, setDownloadRequested] = useState(false);
  /** The same shape, for the toolbar's `upload` button (TRE-65). */
  const [uploadRequested, setUploadRequested] = useState(false);
  /**
   * The same shape again, for `duplicate` (TRE-69 §2), which opens nothing:
   * it queues a transfer from the selection and reports through the queue
   * widget, so there is no modal for the flag to be the state of.
   */
  const [duplicateRequested, setDuplicateRequested] = useState(false);
  /**
   * Which transfer modal is open, or null for none (TRE-24).
   *
   * An operation rather than a boolean, for the reason `renameMode` is one: the
   * two buttons promise different things and the modal has to know which. F5
   * and the `copy` button mean copy; F6 and `move` mean move.
   */
  const [transferMode, setTransferMode] = useState<"copy" | "move" | null>(null);
  /**
   * What the explorer's clipboard is holding, in the sentence the status bar
   * shows (TRE-71 §3), and the click that empties it.
   *
   * The store itself is down in the explorer, beside the pane state — this is
   * the same inversion `selection` already resolves: the bar is up here, and
   * what it describes is down there. The clear is a request for the reason the
   * download is one, since there is no dialogue for it to be the state of.
   */
  const [clipboard, setClipboard] = useState<string | null>(null);
  const [clearClipboardRequested, setClearClipboardRequested] = useState(false);
  /**
   * What the toolbar's row is aimed at (TRE-70 §4) — reported up by the
   * explorer, which is where the selection lives.
   *
   * Null until the explorer's first render, which is one paint with an action
   * row that has nothing to say. That is honest: it has nothing to say yet.
   */
  const [actionContext, setActionContext] = useState<ActionContext | null>(null);

  /**
   * Whether the layout has been moved by hand yet (TRE-62 §4).
   *
   * Panes open and collapse by animating their width, and that motion belongs
   * to somebody pressing something. A cold open arrives at a layout it was
   * given — from the URL, or from the restore a moment after first paint — and
   * playing that back would have the explorer assemble itself on screen every
   * time it is loaded. So the transition is armed by the first change that
   * comes through a control, and stays armed from then on.
   */
  const [moved, setMoved] = useState(false);
  const changeLayout = (patch: Partial<typeof shared>) => {
    setMoved(true);
    void setShared(patch);
  };

  /**
   * The toolbar's action row (TRE-70 §4).
   *
   * What exists and what each entry needs is `resolveActions`, run against the
   * context the explorer reports up. This page attaches the handlers and
   * nothing else — it used to also decide availability, by replacing an
   * action's `unavailableReason` with a handler, which meant the row and the
   * menu could disagree about the same selection and nobody would find out
   * until someone tried the other route.
   */
  const OPENERS: Partial<Record<ActionId, () => void>> = {
    // The button says `new`, so it opens on the directory — which is what the
    // key it advertises means everywhere else. The file is one click away
    // inside the modal.
    newDir: () => setCreateMode("dir"),
    copyTo: () => setTransferMode("copy"),
    moveTo: () => setTransferMode("move"),
    duplicate: () => setDuplicateRequested(true),
    chmod: () => setPermissionsOpen(true),
    // The toolbar button opens the pattern whatever is selected — it is the
    // only way to reach it. F2 is the one that opens a single name.
    rename: () => setRenameMode("pattern"),
    download: () => setDownloadRequested(true),
    upload: () => setUploadRequested(true),
    compare: () => setCompareOpen(true),
    rm: () => setDeleteOpen(true),
  };
  // The toolbar's shape carries no rules, so this drops nothing — it is how the
  // row's type narrows from "action or rule" to "action".
  const actions = (actionContext ? resolveActions(actionContext, "toolbar") : []).flatMap((row) =>
    isRule(row) ? [] : [{ ...row, onSelect: OPENERS[row.id] }],
  );

  const { data: hosts, isPending: hostsPending } = useQuery({
    queryKey: [QUERY_KEYS.HOSTS],
    queryFn: fetchHosts,
    staleTime: 60_000,
    throwOnError: false,
  });

  const active = shared.active as PaneIndex;
  const panes: readonly [PaneUrl, PaneUrl] = [left, right];
  const setPane = (pane: PaneIndex, patch: Partial<PaneUrl>) => {
    // A live tail follows a file on *this pane's* host (TRE-34). Moving the
    // pane to another machine leaves that path pointing at a file which is very
    // likely not there, so the mark goes with the host rather than surviving it
    // as a stream that 404s. One rule here rather than at the nine call sites
    // that can rebind a pane, where the tenth would forget.
    //
    // A *change* of host, not merely a patch that mentions one: several of
    // those call sites write the host and the path together while staying on
    // the same machine, and a tail dropped because the other pane was pointed
    // at a directory it was already on would be a bug with no visible cause.
    // Skipped outright when the caller is setting both in one breath.
    const moved = patch.host !== undefined && patch.host !== panes[pane].host;
    const next = moved && patch.tail === undefined ? { ...patch, tail: null } : patch;
    void (pane === 0 ? setLeft(next) : setRight(next));
  };

  /** The whole layout, in one value: what a view is cut from and compared to. */
  const liveLayout: StoredLayout = { ...shared, a: left, b: right };

  /**
   * A bare URL reopens where this account left off (TRE-51). A URL carrying
   * any parameter is a link and is left alone — the hook decides that on its
   * first render, before nuqs has had a chance to write anything.
   *
   * Applied as a replace: the cold open is where the history starts, so the
   * back button must not walk back to an explorer the user never saw.
   */
  useSessionLayout({
    current: liveLayout,
    applyLayout: (layout) => {
      const { a, b, ...rest } = layout;
      void setShared(rest, { history: "replace" });
      void setLeft(a, { history: "replace" });
      void setRight(b, { history: "replace" });
    },
    knownHostIds: hosts?.map((host) => host.id),
  });

  // ---- saved views (TRE-37) ------------------------------------------------

  const { data: viewData } = useQuery({
    queryKey: [QUERY_KEYS.VIEWS],
    queryFn: fetchViews,
    staleTime: 60_000,
    throwOnError: false,
  });
  const savedViews = viewData?.views ?? [];

  const labelOf = (hostId: string | null) => hosts?.find((host) => host.id === hostId)?.label ?? null;

  /** What a view would be cut from right now, and what the dot compares against. */
  const currentViewLayout: ViewLayout = layoutOf(liveLayout);
  const activeView = savedViews.find((view) => view.id === activeViewId) ?? null;
  const viewDirty = activeView !== null && isDirty(activeView.layout, currentViewLayout);

  /**
   * Restoring is a navigation, which is the whole reason TRE-18 put the layout
   * in the URL: the back button undoes it for free, and the address that
   * results is the view, shareable as a link.
   *
   * Both panes lose their tail. A tail follows a file on the pane's own host
   * (TRE-34), a view moves the pane — possibly to another machine — and a mark
   * carried across is a stream pointed at a file that is very likely not there.
   */
  const applyViewLayout = (layout: ViewLayout) => {
    setMoved(true);
    void setShared({ split: layout.split, insp: layout.insp, heat: layout.heat, glob: layout.glob });
    void setLeft({ ...layout.a, tail: null });
    void setRight({ ...layout.b, tail: null });
  };

  /**
   * Restore one, or say why it cannot be restored as saved.
   *
   * The check is against the hosts this account actually has. A view naming a
   * deleted host is not degraded quietly the way a cold open is — pressing `⌥3`
   * is a request for a specific arrangement, and answering it with a different
   * one without saying so is the app being wrong confidently.
   */
  const restoreView = (id: string) => {
    const view = savedViews.find((candidate) => candidate.id === id);
    if (!view) return;
    // Nothing to check against yet. `⌥3` in the half-second before the hosts
    // arrive would otherwise find every bound pane broken and open the rebind
    // dialogue with an empty list of machines to choose from.
    if (hosts === undefined) return;

    if (
      brokenPanes(
        view.layout,
        view.hostLabels,
        hosts.map((host) => host.id),
      ).length > 0
    ) {
      setViewRebindId(view.id);
      return;
    }

    applyViewLayout(view.layout);
    setActiveViewId(view.id);
  };

  const openViewMenu = (id: string, point: Point) => setViewMenu({ id, point });
  const openPalette = (query = "") => {
    setPaletteQuery(query);
    setPaletteOpen(true);
  };

  const menuView = savedViews.find((view) => view.id === viewMenu?.id) ?? null;
  const formView = savedViews.find((view) => view.id === viewForm?.id) ?? null;
  const rebindView = savedViews.find((view) => view.id === viewRebindId) ?? null;

  // The chrome describes the active pane's host, which is now a real answer
  // rather than "the first one" — the sidebar can point each pane anywhere.
  const activeHost = hosts?.find((host) => host.id === panes[active].host) ?? null;

  // Its stats come from the host, not from the API process. The top bar used to
  // show the NestJS uptime and a literal 1ms ping, which described the wrong
  // machine entirely.
  const { data: summary } = useQuery({
    queryKey: [QUERY_KEYS.HOST_SUMMARY, activeHost?.id],
    queryFn: () => fetchHostSummary(activeHost?.id as string),
    enabled: Boolean(activeHost),
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
    throwOnError: false,
  });

  /**
   * The live numbers, on their own query (TRE-73).
   *
   * Polled faster than the summary and never for more than one host: each answer
   * costs the server two readings a second apart, and the sparkline only grows
   * a bar when one is taken. Twenty bars at this interval is five minutes of
   * load behind the number.
   */
  const { data: metrics } = useQuery({
    queryKey: [QUERY_KEYS.HOST_METRICS, activeHost?.id],
    queryFn: () => fetchHostMetrics(activeHost?.id as string),
    enabled: Boolean(activeHost),
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: false,
    throwOnError: false,
  });

  return (
    <AppShell
      host={
        activeHost
          ? {
              label: activeHost.label,
              colour: activeHost.colour,
              transport: activeHost.transport === "LOCAL" ? "local" : "ssh",
              pingMs: summary?.pingMs ?? null,
            }
          : null
      }
      stats={{
        uptime: summary?.uptimeSeconds != null ? formatUptime(summary.uptimeSeconds) : null,
        cpu: metrics?.cpuPercent != null ? `${metrics.cpuPercent}%` : null,
        ram: metrics?.memory ? formatMemory(metrics.memory) : null,
        io: metrics?.io ? formatThroughput(metrics.io.bytesPerSec) : null,
        load: metrics?.history ?? [],
      }}
      views={
        <ViewStrip
          views={savedViews}
          activeId={activeViewId}
          dirty={viewDirty}
          labelOf={labelOf}
          onRestore={restoreView}
          onMenu={openViewMenu}
          onSave={() => setViewForm({ id: null })}
          // The overflow is the palette, on the word that finds every view —
          // rather than a second list nobody would find twice (TRE-37 §4).
          onOverflow={() => openPalette("view")}
        />
      }
      // Only ever for the host the chip names — the window is per host, and a
      // badge that followed anything else would be reporting on a machine the
      // reader is not looking at (TRE-29).
      sudo={activeHost ? <SudoBadge host={activeHost} /> : null}
      // Unconditional, unlike the two slots above it: the host chip and its
      // sudo badge describe a machine a pane may not be bound to, and this
      // describes the session, which always exists in here (TRE-90).
      account={<AccountMenu onOpenChange={setAccountMenuOpen} />}
      selection={selection ? summarise(selection) : null}
      clipboard={clipboard}
      onClearClipboard={() => setClearClipboardRequested(true)}
      viewMode={shared.view}
      onViewModeChange={(view) => void setShared({ view })}
      splitMode={shared.split}
      onSplitModeChange={(split) => changeLayout({ split })}
      glob={shared.glob}
      onGlobChange={(glob) => void setShared({ glob })}
      globMatches={globMatches}
      heat={shared.heat}
      onHeatChange={(heat) => void setShared({ heat })}
      inspector={shared.insp}
      onInspectorChange={(insp) => changeLayout({ insp })}
      actions={actions}
      onOpenPalette={() => openPalette()}
      sidebar={
        <Sidebar
          hosts={hosts ?? []}
          paneHostIds={[panes[0].host, panes[1].host]}
          activePane={active}
          views={
            <ViewList
              views={savedViews}
              unreadable={viewData?.unreadable ?? 0}
              activeId={activeViewId}
              dirty={viewDirty}
              labelOf={labelOf}
              onRestore={restoreView}
              onMenu={openViewMenu}
              onSave={() => setViewForm({ id: null })}
            />
          }
          onBindHost={(pane, host) => bind(pane, host)}
          onNavigate={(host, path) => bind(active, host, path)}
        />
      }
      strip={
        // The terminal takes the strip's place while it is open, as the mockup
        // has it. They are the same kind of object — a fixed-height panel
        // docked under the panes — and stacking both would spend a third of the
        // window on furniture. Null rather than hidden, which is what the slot
        // asks for: the strip holds an SSE connection.
        shared.du &&
        !terminalOpen && (
          <DiskUsage
            host={activeHost}
            // Pinned once something has been scanned, and following the active
            // pane until then — see the strip's own note on why the pin exists.
            root={shared.duRoot ?? panes[active].path}
            panePath={panes[active].path}
            onPin={(duRoot) => void setShared({ duRoot })}
            onNavigate={(path) => setPane(active, { path })}
            onHide={() => changeLayout({ du: false })}
          />
        )
      }
      onShowStrip={shared.du || terminalOpen ? null : () => changeLayout({ du: true })}
    >
      <Explorer
        hosts={hosts ?? []}
        hostsPending={hostsPending}
        panes={panes}
        onPaneChange={setPane}
        active={active}
        onActiveChange={(pane) => void setShared({ active: pane })}
        glob={shared.glob}
        onGlobChange={(glob) => void setShared({ glob })}
        onMatchesChange={setGlobMatches}
        splitMode={shared.split}
        // The palette reaches the split and the heat map as well as the
        // toolbar does (TRE-36 §1), so both setters come down here now.
        onSplitModeChange={(split) => changeLayout({ split })}
        heat={shared.heat}
        onHeatChange={(heat) => void setShared({ heat })}
        inspector={shared.insp}
        onInspectorChange={(insp) => changeLayout({ insp })}
        animate={moved}
        onSelectionChange={setSelection}
        manageHostsFor={manageHostsFor}
        onManageHosts={setManageHostsFor}
        permissionsOpen={permissionsOpen}
        onPermissionsOpenChange={setPermissionsOpen}
        renameMode={renameMode}
        onRenameMode={setRenameMode}
        createMode={createMode}
        onCreateMode={setCreateMode}
        duplicateRequested={duplicateRequested}
        onDuplicateRequestedChange={setDuplicateRequested}
        deleteOpen={deleteOpen}
        onDeleteOpenChange={setDeleteOpen}
        downloadRequested={downloadRequested}
        onDownloadRequestedChange={setDownloadRequested}
        uploadRequested={uploadRequested}
        onUploadRequestedChange={setUploadRequested}
        transferMode={transferMode}
        onTransferMode={setTransferMode}
        compareOpen={compareOpen}
        onCompareOpenChange={setCompareOpen}
        terminalOpen={terminalOpen}
        onTerminalOpenChange={setTerminalOpen}
        paletteOpen={paletteOpen}
        onPaletteOpenChange={setPaletteOpen}
        paletteQuery={paletteQuery}
        savedViews={savedViews}
        viewOverlayOpen={viewForm !== null || viewRebindId !== null || viewMenu !== null || accountMenuOpen}
        onRestoreView={restoreView}
        onSaveView={() => setViewForm({ id: null })}
        onClipboardChange={setClipboard}
        clearClipboardRequested={clearClipboardRequested}
        onClearClipboardRequestedChange={setClearClipboardRequested}
        onActionContextChange={setActionContext}
      />

      {/* Inside the shell rather than beside it: all three need the toasts, and
          `ToastProvider` is `AppShell`'s. They sit here with the explorer for
          the same reason its own modals do. */}
      {menuView && viewMenu && (
        <ViewMenu
          view={menuView}
          views={savedViews}
          point={viewMenu.point}
          current={currentViewLayout}
          onRestore={() => restoreView(menuView.id)}
          onRename={() => setViewForm({ id: menuView.id })}
          onAdopt={() => setActiveViewId(menuView.id)}
          onClose={() => setViewMenu(null)}
        />
      )}

      {viewForm && (
        <ViewForm
          view={formView}
          views={savedViews}
          current={currentViewLayout}
          hosts={hosts ?? []}
          onClose={() => setViewForm(null)}
          // A view just *saved* is the view you are standing in, so the strip
          // lights it and the dot has something to be about. A view merely
          // renamed is not: renaming `log triage` while standing in `deploy`
          // must not move the chip, and the dot would then be comparing against
          // a layout nobody restored.
          onSaved={(saved: SavedView) => {
            if (viewForm.id === null) setActiveViewId(saved.id);
          }}
        />
      )}

      {rebindView && (
        <ViewRebind
          view={rebindView}
          broken={brokenPanes(rebindView.layout, rebindView.hostLabels, hosts?.map((host) => host.id) ?? [])}
          hosts={hosts ?? []}
          onClose={() => setViewRebindId(null)}
          onRestore={(layout) => {
            applyViewLayout(layout);
            // Still the active view, and now deliberately dirty: what is on
            // screen is not what is stored, which is exactly what the dot says
            // and what "Update from current" is for.
            setActiveViewId(rebindView.id);
          }}
        />
      )}
    </AppShell>
  );

  /**
   * Point a pane at a host (TRE-18 §2). Binding resets the pane to that host's
   * home unless a favourite named somewhere else, and the pane's own effect
   * clears the selection and shows the skeleton because the path changed.
   */
  function bind(pane: PaneIndex, host: HostView, path?: string) {
    setPane(pane, { host: host.id, path: path ?? host.homePath });
  }
}

function summarise({ row, path }: { row: FileRow; path: string }): SelectionSummary {
  return {
    path,
    size: formatSize(row.size, row.type),
    mode: `${row.mode} ${row.modeText}`,
    owner: `${row.owner}:${row.group}`,
    modified: formatInstant(row.mtime),
  };
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * "9.4/32" — what is in use over what the machine has, in GiB, written as mockup
 * 2a writes it. No unit on either half: the pair is the unit, and the second
 * number is what makes the first mean anything.
 */
function formatMemory({ totalKb, availableKb }: { totalKb: number; availableKb: number }): string {
  if (totalKb <= 0) return "—";
  const total = totalKb / 1_048_576;
  const used = (totalKb - availableKb) / 1_048_576;
  // A decimal on the total only where rounding would take it away: a 512 MiB
  // container reading "0.3/0.5" is honest, "0.3/1" is generous and "0.3/0" is
  // neither.
  return `${used.toFixed(1)}/${total >= 10 ? Math.round(total) : total.toFixed(1)}`;
}

/** The file table's own ladder (`formatSize`), per second. */
function formatThroughput(bytesPerSec: number): string {
  if (bytesPerSec >= 1_073_741_824) return `${(bytesPerSec / 1_073_741_824).toFixed(1)} GB/s`;
  if (bytesPerSec >= 1_048_576) return `${Math.round(bytesPerSec / 1_048_576)} MB/s`;
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} kB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}
