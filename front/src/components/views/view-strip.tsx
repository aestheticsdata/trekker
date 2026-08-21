"use client";

import { Tooltip } from "@components/ui/tooltip";
import { writeViewSlot } from "@helpers/keys";
import { CHIP_INK, CHIP_KEY_INK, CHIP_ON_INK, CHIP_ON_KEY_INK, DIRTY_DOT, describeHosts } from "@helpers/views";

import type { LabelOf } from "@helpers/views";
import type { SavedView } from "@schemas/layout";

/**
 * The saved views in the top bar (TRE-37 §4).
 *
 * The first few, then `+n`, then a way to save the current layout — 2a's own
 * arrangement. The overflow is not a second menu: it opens the palette on the
 * word `view`, which already lists every one of them with its chord beside it,
 * and which is where somebody with nine views is going to look anyway.
 *
 * How many fit is a fixed count rather than a measurement. The mockup measures
 * the viewport and pops the last chip that would overflow, which is right and
 * costs a `ResizeObserver` in the one bar that is on screen at all times; a
 * fixed four is honest at every width this app declares itself usable at, and
 * everything past it is one keystroke away rather than hidden.
 */

/** How many chips are drawn before the rest collapse into `+n`. */
const VISIBLE = 4;

export function ViewStrip({
  views,
  activeId,
  dirty,
  labelOf,
  onRestore,
  onMenu,
  onSave,
  onOverflow,
}: {
  views: readonly SavedView[];
  activeId: string | null;
  /** Whether the active view no longer matches what is on screen. */
  dirty: boolean;
  labelOf: LabelOf;
  onRestore: (id: string) => void;
  onMenu: (id: string, point: { x: number; y: number }) => void;
  onSave: () => void;
  onOverflow: () => void;
}) {
  const shown = views.slice(0, VISIBLE);
  const hidden = views.length - shown.length;

  return (
    <nav
      aria-label="Saved views"
      className="flex min-w-0 items-center gap-1.25"
    >
      <span className="text-accent-soft flex-none font-sans text-3xs font-semibold tracking-[0.16em]">VIEWS</span>

      {shown.map((view) => {
        const on = view.id === activeId;
        return (
          <Tooltip
            key={view.id}
            content={`${describeHosts(view.layout, labelOf)}${on && dirty ? " · unsaved changes" : ""}`}
          >
            <button
              type="button"
              onClick={() => onRestore(view.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                const box = event.currentTarget.getBoundingClientRect();
                onMenu(view.id, { x: box.left, y: box.bottom + 3 });
              }}
              aria-current={on ? "true" : undefined}
              className={`flex h-5 max-w-32 flex-none items-center gap-1.25 rounded-sm border px-2 font-mono text-cmd ${
                on
                  ? `bg-line border-accent ${CHIP_ON_INK} font-medium`
                  : `border-line-strong ${CHIP_INK} hover:bg-raised`
              }`}
            >
              <span className="truncate">{view.name}</span>
              {view.slot !== null && (
                <span className={`flex-none font-mono text-caps ${on ? CHIP_ON_KEY_INK : CHIP_KEY_INK}`}>
                  {writeViewSlot(view.slot)}
                </span>
              )}
              {/* Only ever on the view that is actually restored: a dot beside
                  a view nobody is standing in would be claiming a comparison
                  that was never made. */}
              {on && dirty && (
                <span
                  role="img"
                  aria-label="unsaved changes"
                  className={`size-1 flex-none rounded-full ${DIRTY_DOT}`}
                />
              )}
            </button>
          </Tooltip>
        );
      })}

      {hidden > 0 && (
        <Tooltip content={`${hidden} more — opens the palette`}>
          <button
            type="button"
            onClick={onOverflow}
            className="border-line-strong text-ink-muted hover:bg-raised flex h-5 flex-none items-center rounded-sm border px-1.75 font-mono text-2xs"
          >
            +{hidden}
          </button>
        </Tooltip>
      )}

      <Tooltip content="Save both panes and this layout as a view">
        <button
          type="button"
          onClick={onSave}
          className="border-line-strong text-ink-muted hover:bg-raised flex h-5 flex-none items-center gap-1 rounded-sm border px-2 font-mono text-cmd"
        >
          ＋ save view
        </button>
      </Tooltip>
    </nav>
  );
}
