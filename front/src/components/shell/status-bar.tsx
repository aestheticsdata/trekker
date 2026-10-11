import { UiScale } from "@components/shell/ui-scale";
import useTranslations from "@i18n/useTranslations";

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

export function StatusBar({
  selection,
  hint,
  clipboard = null,
  onClearClipboard,
  onShowStrip,
}: {
  selection: SelectionSummary | null;
  hint?: string;
  /**
   * What the clipboard is holding, in one sentence (TRE-71 §3), or null while
   * it holds nothing.
   *
   * The bar is where it belongs: a clipboard is a thing the app is holding
   * rather than a thing on screen, and this is the only line that is about the
   * session rather than about the row under the cursor.
   */
  clipboard?: string | null;
  /** Clicking that line clears it — the plainest way out, and the one `⎋` also is. */
  onClearClipboard?: () => void;
  /**
   * Present only while the disk-usage strip is collapsed (TRE-33 §2). The bar
   * is where the mockup puts the way back: a strip that hides itself and leaves
   * nothing behind is a feature somebody turns off once and never finds again.
   */
  onShowStrip?: (() => void) | null;
}) {
  const t = useTranslations("shell").statusBar;

  return (
    <footer
      className="bg-chrome border-line flex h-statusbar shrink-0 items-center gap-3 border-t px-2 font-mono text-2xs"
      data-testid="status-bar"
    >
      {selection ? (
        <>
          {/* The path gets whatever room is left; the fixed-width facts do not
              move as it grows, so the eye can stay on one of them. */}
          <span
            className="text-ink-soft min-w-0 flex-1 truncate"
            data-testid="status-path"
          >
            {selection.path}
          </span>
          <Fact
            fact="size"
            label={t.facts.size}
            value={selection.size}
          />
          <Fact
            fact="mode"
            label={t.facts.mode}
            value={selection.mode}
          />
          <Fact
            fact="owner"
            label={t.facts.owner}
            value={selection.owner}
          />
          <Fact
            fact="modified"
            label={t.facts.modified}
            value={selection.modified}
          />
        </>
      ) : (
        <span
          className="text-ink-faint min-w-0 flex-1 truncate"
          data-testid="status-hint"
        >
          {hint ?? t.noSelection}
        </span>
      )}

      {clipboard && (
        <button
          type="button"
          onClick={onClearClipboard}
          // Its text is the clipboard sentence, which names whatever is held.
          data-testid="clipboard-clear"
          className="text-brand hover:text-ink max-w-64 flex-none truncate"
        >
          {clipboard} ✕
        </button>
      )}

      {onShowStrip && (
        <button
          type="button"
          onClick={onShowStrip}
          data-testid="du-show"
          className="text-ink-dim hover:text-ink flex-none whitespace-nowrap"
        >
          {t.showDiskUsage}
        </button>
      )}

      <UiScale />
    </footer>
  );
}

/** `fact` is the stable key `data-fact` carries; `label` is the word on screen. */
function Fact({ fact, label, value }: { fact: string; label: string; value: string }) {
  return (
    <span
      className="hidden items-center gap-1 whitespace-nowrap inspector:flex"
      data-testid="status-fact"
      data-fact={fact}
    >
      <span className="text-ink-faint">{label}</span>
      <span className="text-ink-muted">{value}</span>
    </span>
  );
}
