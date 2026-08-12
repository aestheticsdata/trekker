"use client";

import { Explorer } from "@components/explorer/explorer";
import { AppShell } from "@components/shell/app-shell";
import { Sidebar } from "@components/sidebar/sidebar";
import { formatInstant, formatSize } from "@helpers/listing";
import { fetchHealth } from "@lib/api/health";
import { fetchHostSummary, fetchHosts } from "@lib/api/hosts";
import { QUERY_KEYS } from "@lib/query/keys";
import { explorerParams, LEFT_KEYS, paneParams, RIGHT_KEYS } from "@lib/url/explorer-params";
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
      onSplitModeChange={(split) => void setShared({ split })}
      glob={shared.glob}
      onGlobChange={(glob) => void setShared({ glob })}
      globMatches={globMatches}
      heat={shared.heat}
      onHeatChange={(heat) => void setShared({ heat })}
      inspector={shared.insp}
      onInspectorChange={(insp) => void setShared({ insp })}
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
        onInspectorChange={(insp) => void setShared({ insp })}
        onSelectionChange={setSelection}
        manageHostsFor={manageHostsFor}
        onManageHosts={setManageHostsFor}
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
