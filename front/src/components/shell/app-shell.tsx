"use client";

import { StatusBar } from "@components/shell/status-bar";
import { Toolbar } from "@components/shell/toolbar";
import { TopBar } from "@components/shell/top-bar";
import { ToastProvider } from "@components/ui/toast";
import { TransferProvider } from "@components/ui/transfers";
import { UploadProvider } from "@components/ui/uploads";

import type { SelectionSummary } from "@components/shell/status-bar";
import type { SplitMode, ToolbarAction, ViewMode } from "@components/shell/toolbar";
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
  inspector,
  onInspectorChange,
  actions,
  sidebar,
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
  /** The inspector's toolbar switch. The panel itself is the explorer's, since
   * everything it describes — selection, rows, sort — belongs to a pane. */
  inspector?: boolean;
  onInspectorChange?: (open: boolean) => void;
  /** The action row, with whatever M2 has actually built wired up (TRE-21). */
  actions?: readonly ToolbarAction[];
  /** The 176px left rail (TRE-18). Rendered beside the panes, inside the bars. */
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ToastProvider>
      {/* Inside the toasts, because an upload that hits the rate limit says so
          with one (TRE-65). Outside everything else, because an upload outlives
          the pane it was dropped on. */}
      <UploadProvider>
        {/* Inside the uploads for one reason: both need the toasts, and a
            finished transfer raises one. Outside the shell because a transfer
            outlives every pane, modal and navigation below it — it is server
            state, and this provider is only the window onto it (TRE-24 §3). */}
        <TransferProvider>
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
              inspector={inspector}
              onInspectorChange={onInspectorChange}
              actions={actions}
            />

            {/* min-h-0 or a tall child stretches the flex item instead of scrolling.
            The sidebar sits inside this row rather than beside the whole app:
            it belongs between the toolbar and the status bar, as the mockup
            draws it, and it goes with the panes below the `panes:` breakpoint. */}
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <div className="hidden panes:flex">{sidebar}</div>
              <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</main>
            </div>

            <StatusBar selection={selection} />
          </div>
        </TransferProvider>
      </UploadProvider>
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
