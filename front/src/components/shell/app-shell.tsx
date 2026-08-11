"use client";

import { StatusBar } from "@components/shell/status-bar";
import { Toolbar } from "@components/shell/toolbar";
import { TopBar } from "@components/shell/top-bar";
import { ToastProvider } from "@components/ui/toast";

import type { SelectionSummary } from "@components/shell/status-bar";
import type { SplitMode, ViewMode } from "@components/shell/toolbar";
import type { HostChip, MachineStats, SavedView } from "@components/shell/top-bar";
import type { ReactNode } from "react";

/**
 * The three bars around whatever the app is showing (TRE-14).
 *
 * It owns the viewport: the bars are fixed height and the middle is the only
 * thing that scrolls, so a ten-thousand-row listing never pushes the status bar
 * off screen. Panes, sidebar and inspector fill `children` from TRE-16 onward.
 */
export function AppShell({
  host = null,
  stats = null,
  views = [],
  selection = null,
  viewMode,
  onViewModeChange,
  splitMode,
  onSplitModeChange,
  glob,
  onGlobChange,
  globMatches,
  heat,
  onHeatChange,
  children,
}: {
  host?: HostChip | null;
  stats?: MachineStats | null;
  views?: readonly SavedView[];
  selection?: SelectionSummary | null;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  splitMode?: SplitMode;
  onSplitModeChange?: (mode: SplitMode) => void;
  glob?: string;
  onGlobChange?: (glob: string) => void;
  globMatches?: number | null;
  heat?: boolean;
  onHeatChange?: (heat: boolean) => void;
  children: ReactNode;
}) {
  return (
    <ToastProvider>
      <TooNarrowNotice />

      <div className="flex h-screen flex-col max-usable:hidden">
        <TopBar
          host={host}
          stats={stats}
          views={views}
        />
        <Toolbar
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          splitMode={splitMode}
          onSplitModeChange={onSplitModeChange}
          glob={glob}
          onGlobChange={onGlobChange}
          globMatches={globMatches ?? null}
          heat={heat}
          onHeatChange={onHeatChange}
        />

        {/* min-h-0 or a tall child stretches the flex item instead of scrolling. */}
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>

        <StatusBar selection={selection} />
      </div>
    </ToastProvider>
  );
}

/**
 * Below tablet the app says so rather than degrading into something unusable
 * (TRE-14 §5). Two panes of a filesystem on a phone is not a smaller version
 * of this app, it is a different one, and pretending otherwise wastes the
 * visitor's time.
 */
function TooNarrowNotice() {
  return (
    <div className="hidden h-screen flex-col items-center justify-center gap-2 px-8 text-center max-usable:flex">
      <p className="text-ink text-sm tracking-caps">TREKKER</p>
      <p className="text-ink-muted text-xs">This app needs a wider screen.</p>
      <p className="text-ink-faint text-2xs">
        Two directories side by side is the whole point, and it does not survive a phone.
      </p>
    </div>
  );
}
