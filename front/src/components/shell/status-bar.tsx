import { UiScale } from "@components/shell/ui-scale";

/**
 * The 24px status bar (TRE-14 §4): everything about the selected row that the
 * table does not have room to show.
 *
 * Mono throughout — these are all data, and a path that shifts by a pixel as
 * the selection moves reads as flicker.
 *
 * The size stepper (TRE-44) rides in the right corner: it is the one control
 * that is about the app rather than about a file, and the status bar is the
 * only bar with room to spare at every width.
 */

export interface SelectionSummary {
  path: string;
  size: string;
  mode: string;
  owner: string;
  modified: string;
}

export function StatusBar({ selection, hint }: { selection: SelectionSummary | null; hint?: string }) {
  return (
    <footer className="bg-chrome border-line flex h-statusbar shrink-0 items-center gap-3 border-t px-2 font-mono text-2xs">
      {selection ? (
        <>
          {/* The path gets whatever room is left; the fixed-width facts do not
              move as it grows, so the eye can stay on one of them. */}
          <span className="text-ink-soft min-w-0 flex-1 truncate">{selection.path}</span>
          <Fact
            label="size"
            value={selection.size}
          />
          <Fact
            label="mode"
            value={selection.mode}
          />
          <Fact
            label="owner"
            value={selection.owner}
          />
          <Fact
            label="modified"
            value={selection.modified}
          />
        </>
      ) : (
        <span className="text-ink-faint min-w-0 flex-1 truncate">{hint ?? "No selection"}</span>
      )}

      <UiScale />
    </footer>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <span className="hidden items-center gap-1 whitespace-nowrap inspector:flex">
      <span className="text-ink-faint">{label}</span>
      <span className="text-ink-muted">{value}</span>
    </span>
  );
}
