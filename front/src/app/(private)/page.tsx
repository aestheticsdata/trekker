"use client";

import { AppShell } from "@components/shell/app-shell";
import { fetchHealth } from "@lib/api/health";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { SplitMode, ViewMode } from "@components/shell/toolbar";

/**
 * The chrome, with the explorer still to come (TRE-16).
 *
 * The bars are driven from local state here so the whole shell can be seen and
 * judged at once. Every one of these values has a real source waiting: the host
 * chip and its ping from TRE-12's summary, the views strip from TRE-37, the
 * selection from whichever pane has focus. Wiring them is TRE-18's job, when
 * the sidebar owns which host is active.
 */
/**
 * A host's accent is data, not styling: it lives in the `Hosts.colour` column
 * and the user picks it per host. This is the schema's default, standing in
 * until the sidebar supplies a real row.
 */
const PLACEHOLDER_HOST_COLOUR = "#7fa8c9";

export default function HomePage() {
  const [viewMode, setViewMode] = useState<ViewMode>("detail");
  const [splitMode, setSplitMode] = useState<SplitMode>("split");
  const [glob, setGlob] = useState("");
  const [heat, setHeat] = useState(false);

  const { data: health } = useQuery({
    queryKey: [QUERY_KEYS.HEALTH],
    queryFn: fetchHealth,
    refetchInterval: 5000,
    throwOnError: false,
  });

  return (
    <AppShell
      host={{ label: "local", colour: PLACEHOLDER_HOST_COLOUR, transport: "local", pingMs: health ? 1 : null }}
      stats={{
        uptime: health ? formatUptime(health.uptimeSeconds) : null,
        cpu: null,
        ram: null,
        io: null,
        load: [],
      }}
      views={[]}
      selection={null}
      viewMode={viewMode}
      onViewModeChange={setViewMode}
      splitMode={splitMode}
      onSplitModeChange={setSplitMode}
      glob={glob}
      onGlobChange={setGlob}
      globMatches={glob ? 0 : null}
      heat={heat}
      onHeatChange={setHeat}
    >
      <div className="flex h-full items-center justify-center">
        <p className="text-ink-faint text-xs">
          {health ? "API reachable — the explorer lands in TRE-16." : "Waiting for the API…"}
        </p>
      </div>
    </AppShell>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
