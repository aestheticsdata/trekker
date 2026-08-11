"use client";

import { Explorer } from "@components/explorer/explorer";
import { AppShell } from "@components/shell/app-shell";
import { formatSize } from "@helpers/listing";
import { fetchHealth } from "@lib/api/health";
import { fetchHosts } from "@lib/api/hosts";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SelectionSummary } from "@components/shell/status-bar";
import type { SplitMode, ViewMode } from "@components/shell/toolbar";
import type { FileRow } from "@lib/api/fs";

/**
 * The explorer, in the chrome (TRE-16).
 *
 * This page owns what the bars and the panes share — the glob, the split mode,
 * the heat toggle and whatever is selected — because the toolbar draws some of
 * it and the panes act on it. TRE-18 moves all of it into the URL through
 * nuqs, at which point this becomes a much shorter file.
 */

export default function HomePage() {
  const [viewMode, setViewMode] = useState<ViewMode>("detail");
  const [splitMode, setSplitMode] = useState<SplitMode>("split");
  const [glob, setGlob] = useState("");
  const [globMatches, setGlobMatches] = useState<number | null>(null);
  const [heat, setHeat] = useState(false);
  const [selection, setSelection] = useState<{ row: FileRow; path: string } | null>(null);

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

  // Until the sidebar owns which host is active (TRE-18), the chip describes
  // the one the panes opened on.
  const host = hosts?.find((candidate) => candidate.transport === "LOCAL") ?? hosts?.[0] ?? null;

  return (
    <AppShell
      host={
        host
          ? {
              label: host.label,
              colour: host.colour,
              transport: host.transport === "LOCAL" ? "local" : "ssh",
              pingMs: health ? 1 : null,
            }
          : null
      }
      stats={{
        uptime: health ? formatUptime(health.uptimeSeconds) : null,
        cpu: null,
        ram: null,
        io: null,
        load: [],
      }}
      views={[]}
      selection={selection ? summarise(selection) : null}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      splitMode={splitMode}
      onSplitModeChange={setSplitMode}
      glob={glob}
      onGlobChange={setGlob}
      globMatches={globMatches}
      heat={heat}
      onHeatChange={setHeat}
    >
      <Explorer
        hosts={hosts ?? []}
        hostsPending={hostsPending}
        glob={glob}
        onGlobChange={setGlob}
        onMatchesChange={setGlobMatches}
        splitMode={splitMode}
        heat={heat}
        onSelectionChange={setSelection}
      />
    </AppShell>
  );
}

function summarise({ row, path }: { row: FileRow; path: string }): SelectionSummary {
  return {
    path,
    size: formatSize(row.size, row.type),
    mode: `${row.mode} ${row.modeText}`,
    owner: `${row.owner}:${row.group}`,
    modified: row.mtime.replace("T", " ").replace("Z", ""),
  };
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
