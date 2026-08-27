"use client";

import { AddButton } from "@components/ui/add-button";
import { Tooltip } from "@components/ui/tooltip";
import { writeViewSlot } from "@helpers/keys";
import { DIRTY_DOT, describeHosts, ROW_INK, ROW_KEY_INK, ROW_ON_INK } from "@helpers/views";

import type { LabelOf } from "@helpers/views";
import type { SavedView } from "@schemas/layout";

/**
 * The saved views in the sidebar (TRE-37 §4).
 *
 * The same views as the strip in the top bar, drawn the way the sidebar draws
 * everything else: a full-width row, an accent edge on the current one, and the
 * chord pushed right. The strip is for the four you use; this is the list.
 *
 * Both entry points reach the same menu, because a view is renamed and deleted
 * from wherever it is being looked at. `⋯` opens it with a click and a
 * right-click opens it in place, which is the pair every other row in this app
 * already offers.
 */
export function ViewList({
  views,
  unreadable,
  activeId,
  dirty,
  labelOf,
  onRestore,
  onMenu,
  onSave,
}: {
  views: readonly SavedView[];
  /** Rows this build could not parse. Named rather than quietly dropped. */
  unreadable: number;
  activeId: string | null;
  dirty: boolean;
  labelOf: LabelOf;
  onRestore: (id: string) => void;
  onMenu: (id: string, point: { x: number; y: number }) => void;
  onSave: () => void;
}) {
  return (
    <>
      {views.length === 0 && (
        <p className="text-ink-dim px-2.5 py-1 font-mono text-2xs">None yet. Arrange both panes, then save.</p>
      )}

      {views.map((view) => {
        const on = view.id === activeId;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: the row's own control is the button inside it; this element only carries the right-click
          <div
            key={view.id}
            onContextMenu={(event) => {
              event.preventDefault();
              const box = event.currentTarget.getBoundingClientRect();
              onMenu(view.id, { x: box.right - 20, y: box.bottom + 3 });
            }}
            className={`hover:bg-raised group flex h-5.75 items-center gap-1.75 border-l-2 pr-1.75 pl-2 ${
              on ? "bg-raised border-accent" : "border-transparent"
            }`}
          >
            {/* 2a's small square, which is the only thing distinguishing a view
                row from a server row at a glance — a server's mark is round. */}
            <span
              aria-hidden
              className={`border-line-strong size-1.5 flex-none rounded-xs border ${on ? "bg-accent" : ""}`}
            />

            <Tooltip content={describeHosts(view.layout, labelOf)}>
              <button
                type="button"
                onClick={() => onRestore(view.id)}
                aria-current={on ? "true" : undefined}
                className={`min-w-0 flex-1 truncate text-left font-mono text-xs ${
                  on ? `${ROW_ON_INK} font-medium` : ROW_INK
                }`}
              >
                {view.name}
              </button>
            </Tooltip>

            {on && dirty && (
              <span
                role="img"
                aria-label="unsaved changes"
                className={`size-1 flex-none rounded-full ${DIRTY_DOT}`}
              />
            )}

            {view.slot !== null && (
              <span className={`flex-none font-mono text-caps ${ROW_KEY_INK}`}>{writeViewSlot(view.slot)}</span>
            )}

            <Tooltip content="More">
              <button
                type="button"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  onMenu(view.id, { x: box.right + 4, y: box.top });
                }}
                aria-label={`More for ${view.name}`}
                className="text-ink-dim hover:text-ink flex size-3.5 flex-none items-center justify-center font-mono text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              >
                ⋯
              </button>
            </Tooltip>
          </div>
        );
      })}

      {/* A view that fails to parse is kept out of the list and said out loud.
          Dropping it silently would be indistinguishable from having deleted
          it, which is the one thing a named, saved thing must never look like. */}
      {unreadable > 0 && (
        <p className="text-warning px-2.5 py-1 font-mono text-2xs">
          {unreadable === 1 ? "1 view was" : `${unreadable} views were`} saved by a different version and cannot be
          read.
        </p>
      )}

      <AddButton
        label="＋ save current view…"
        onClick={onSave}
      />
    </>
  );
}
