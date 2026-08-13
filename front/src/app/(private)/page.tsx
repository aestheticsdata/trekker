"use client";

import { Explorer } from "@components/explorer/explorer";
import { AppShell } from "@components/shell/app-shell";
import { M2_ACTIONS } from "@components/shell/toolbar";
import { Sidebar } from "@components/sidebar/sidebar";
import { formatInstant, formatSize } from "@helpers/listing";
import { fetchHealth } from "@lib/api/health";
import { fetchHostSummary, fetchHosts } from "@lib/api/hosts";
import { QUERY_KEYS } from "@lib/query/keys";
import { explorerParams, LEFT_KEYS, paneParams, RIGHT_KEYS } from "@lib/url/explorer-params";
import { useSessionLayout } from "@lib/url/use-session-layout";
import { useQuery } from "@tanstack/react-query";
import { useQueryStates } from "nuqs";
import { useState } from "react";

import type { PaneUrl } from "@components/explorer/explorer";
import type { PaneIndex } from "@components/explorer/pane-state";
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
  const [renameOpen, setRenameOpen] = useState(false);

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
    chmod: () => setPermissionsOpen(true),
    rename: () => setRenameOpen(true),
  };
  const actions = M2_ACTIONS.map((action) =>
    action.id in OPENERS ? { ...action, unavailableReason: undefined, onSelect: OPENERS[action.id] } : action,
  );

  const { data: health } = useQuery({
    queryKey: [QUERY_KEYS.HEALTH],
    queryFn: fetchHealth,
    refetchInterval: 5000,
    throwOnError: false,
  });

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
        cpu: null,
        ram: summary?.memory ? formatMemory(summary.memory) : null,
        io: health ? "ok" : null,
        load: summary?.load ? [summary.load.fifteen, summary.load.five, summary.load.one] : [],
      }}
      views={[]}
      selection={selection ? summarise(selection) : null}
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
        renameOpen={renameOpen}
        onRenameOpenChange={setRenameOpen}
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

/** How much is in use, which is the question the bar answers. */
function formatMemory({ totalKb, availableKb }: { totalKb: number; availableKb: number }): string {
  if (totalKb <= 0) return "—";
  return `${Math.round(((totalKb - availableKb) / totalKb) * 100)}%`;
}
