"use client";

import { Explorer } from "@components/explorer/explorer";
import { SudoBadge } from "@components/hosts/sudo-badge";
import { AppShell } from "@components/shell/app-shell";
import { DiskUsage } from "@components/shell/disk-usage";
import { M2_ACTIONS } from "@components/shell/toolbar";
import { Sidebar } from "@components/sidebar/sidebar";
import { formatInstant, formatSize } from "@helpers/listing";
import { fetchHostMetrics, fetchHostSummary, fetchHosts } from "@lib/api/hosts";
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
import type { SelectionSummary } from "@components/shell/status-bar";
import type { FileRow } from "@lib/api/fs";
import type { HostView } from "@lib/api/hosts";

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
   * The toolbar's action row, with the ones M2 has built wired up (TRE-21,
   * TRE-22).
   *
   * The row is declared in the toolbar so the palette can share it, and each
   * action stays disabled until its ticket lands — which is also the honest
   * signal for the four that are still inert. Replacing the entry rather than
   * mutating the shared list keeps the default list a description of what
   * exists rather than of what this page happens to enable.
   */
  const OPENERS: Record<string, () => void> = {
    // The button says `new`, so it opens on the directory — which is what the
    // key it advertises means everywhere else. The file is one click away
    // inside the modal.
    new: () => setCreateMode("dir"),
    copy: () => setTransferMode("copy"),
    move: () => setTransferMode("move"),
    duplicate: () => setDuplicateRequested(true),
    chmod: () => setPermissionsOpen(true),
    // The toolbar button opens the pattern whatever is selected — it is the
    // only way to reach it. F2 is the one that opens a single name.
    rename: () => setRenameMode("pattern"),
    download: () => setDownloadRequested(true),
    upload: () => setUploadRequested(true),
    rm: () => setDeleteOpen(true),
  };
  const actions = M2_ACTIONS.map((action) =>
    action.id in OPENERS ? { ...action, unavailableReason: undefined, onSelect: OPENERS[action.id] } : action,
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
    void (pane === 0 ? setLeft(patch) : setRight(patch));
  };

  /**
   * A bare URL reopens where this account left off (TRE-51). A URL carrying
   * any parameter is a link and is left alone — the hook decides that on its
   * first render, before nuqs has had a chance to write anything.
   *
   * Applied as a replace: the cold open is where the history starts, so the
   * back button must not walk back to an explorer the user never saw.
   */
  useSessionLayout({
    current: { ...shared, a: left, b: right },
    applyLayout: (layout) => {
      const { a, b, ...rest } = layout;
      void setShared(rest, { history: "replace" });
      void setLeft(a, { history: "replace" });
      void setRight(b, { history: "replace" });
    },
    knownHostIds: hosts?.map((host) => host.id),
  });

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
      views={[]}
      // Only ever for the host the chip names — the window is per host, and a
      // badge that followed anything else would be reporting on a machine the
      // reader is not looking at (TRE-29).
      sudo={activeHost ? <SudoBadge host={activeHost} /> : null}
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
      sidebar={
        <Sidebar
          hosts={hosts ?? []}
          paneHostIds={[panes[0].host, panes[1].host]}
          activePane={active}
          onBindHost={(pane, host) => bind(pane, host)}
          onNavigate={(host, path) => bind(active, host, path)}
        />
      }
      strip={
        shared.du && (
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
      onShowStrip={shared.du ? null : () => changeLayout({ du: true })}
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
        heat={shared.heat}
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
        onClipboardChange={setClipboard}
        clearClipboardRequested={clearClipboardRequested}
        onClearClipboardRequestedChange={setClearClipboardRequested}
      />
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
