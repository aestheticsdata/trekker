"use client";

import { isRule } from "@components/shell/actions";
import { placeMenu } from "@helpers/menu";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { MenuEntry, MenuRow } from "@components/shell/actions";
import type { Point } from "@helpers/menu";

/**
 * The listing's context menu (TRE-70 §5, §6, §7).
 *
 * Presentational, like `Overlay` and `Tooltip` beside it: a point, a list of
 * rows and a way to close. It decides nothing about what the rows mean — which
 * exist and which are live is `resolveActions`, and what pressing one does is
 * the explorer's.
 *
 * It takes `MenuRow` rather than `ActionRow`, which is a shape wide enough for
 * a menu that is not about a selection at all: TRE-37's views menu is five
 * rows about a saved layout and belongs to no action registry, and it wants
 * this panel, this keyboard and this disabled treatment rather than a second
 * menu written beside it.
 *
 * Ported from mockup 2a's own menu rather than approximated from tokens: 206px
 * wide, a 23px row, `11px/1` mono labels with a `9.5px` hint pushed right, a
 * header naming what was clicked, and `tkIn` on the way in. The hexes it was
 * drawn in are this DS's `strip`, `line`, `line-strong`, `ink-soft` and
 * `danger-soft`; the pixels are `rem` off `--ui-base` (TRE-44), so the whole
 * menu follows the size knob like everything else.
 */

/** 2a's own width. */
const WIDTH = "w-51.5";

/** How long a letter keeps counting as part of the same type-ahead. */
const TYPEAHEAD_MS = 600;

/**
 * Room kept for the reason strip, in `rem`, whenever the menu holds an entry
 * that could show one.
 *
 * It is measured *into* the placement rather than added afterwards. The strip
 * appears on hover, long after the menu has been placed, and a menu that grows
 * past its own `maxHeight` at that moment does not move — it becomes scrollable,
 * with the sentence somebody was trying to read below the fold.
 *
 * Two lines plus the rule above them: every reason in the registry fits in two
 * at this width, and over-reserving costs nothing but an earlier flip.
 */
const REASON_REM = 2.5;

export interface ContextMenuProps {
  /** Viewport coordinates, as a pointer event reports them. */
  point: Point;
  /** What was right-clicked — the header, and the menu's accessible name. */
  label: string;
  rows: readonly MenuRow[];
  /** An entry was chosen. The id is the caller's to dispatch. */
  onChoose: (id: string) => void;
  onClose: () => void;
}

export function ContextMenu({ point, label, rows, onChoose, onClose }: ContextMenuProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  /**
   * The row the keyboard or the pointer is on, as an index into `rows`.
   *
   * A disabled row can be active — that is how its reason reaches the strip at
   * the bottom — and simply cannot be chosen. Only the keyboard's own movement
   * skips them, because arrowing onto a row that does nothing is a dead step.
   */
  const [active, setActive] = useState<number | null>(null);
  const typed = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const id = useId();

  /** Whether any entry here could ever put a sentence in the strip below. */
  const canExplain = rows.some((row) => !isRule(row) && row.unavailableReason !== undefined);

  /** Only these can be moved to by the keyboard, chosen, or typed at. */
  const live = rows
    .map((row, index) => (!isRule(row) && row.unavailableReason === undefined ? index : -1))
    .filter((index) => index >= 0);

  /**
   * Measure, then place, before paint.
   *
   * The width is 2a's and fixed, but the height is not: it is however many rows
   * this target has, at whatever `--ui-base` is set to. Placing from a guess and
   * correcting afterwards is a visible jump at the bottom of the window, which
   * is exactly where the correction matters.
   */
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const natural = element.getBoundingClientRect();
    // `rem` read off the root, so the reserve follows `--ui-base` like the rest
    // of the menu rather than being a pixel count that is right at one setting.
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    setBox(
      placeMenu(
        point,
        { width: natural.width, height: element.scrollHeight + (canExplain ? REASON_REM * rem : 0) },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [point, canExplain]);

  /** Focus lands on the panel, so `↓` belongs to the menu from the first key. */
  useEffect(() => {
    panel.current?.focus();
  }, []);

  /**
   * Everything that dismisses it (§5).
   *
   * A right-click somewhere else is deliberately **not** here: it reaches the
   * pane, which reports a new point, and the menu moves. Closing on it here
   * would make the second right-click a dismissal and the third an open.
   */
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    // Capture, because a listing that scrolls does not bubble its scroll to the
    // window — and a menu left hanging over rows that have moved is pointing at
    // the wrong one.
    const scrolled = () => onClose();

    window.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const step = (delta: number) => {
    if (live.length === 0) return;
    const at = active === null ? -1 : live.indexOf(active);
    const next = at < 0 ? (delta > 0 ? 0 : live.length - 1) : (at + delta + live.length) % live.length;
    setActive(live[next]);
  };

  /** Why the active entry cannot run, or null when it can — or when none is. */
  const activeRow = active === null ? null : rows[active];
  const reason = activeRow && !isRule(activeRow) ? (activeRow.unavailableReason ?? null) : null;

  const choose = (index: number) => {
    const row = rows[index];
    if (isRule(row) || row.unavailableReason !== undefined) return;
    onChoose(row.id);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      case "ArrowDown":
        event.preventDefault();
        step(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        step(-1);
        return;
      case "Home":
        event.preventDefault();
        if (live.length > 0) setActive(live[0]);
        return;
      case "End":
        event.preventDefault();
        if (live.length > 0) setActive(live[live.length - 1]);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (active !== null) choose(active);
        return;
      case "Tab":
        // A menu is a mode, not a stop on the way to something else.
        event.preventDefault();
        onClose();
        return;
      default:
        break;
    }

    // Type-ahead. One letter jumps to the next entry starting with it, and a
    // second letter within the window extends the search rather than starting a
    // new one — so `co` reaches `copy path` past `copy`.
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const now = event.timeStamp;
    const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + event.key.toLowerCase();
    typed.current = { text, at: now };

    const from = active === null ? 0 : live.indexOf(active) + (text.length === 1 ? 1 : 0);
    for (let offset = 0; offset < live.length; offset += 1) {
      const index = live[(from + offset + live.length) % live.length];
      const row = rows[index];
      if (!isRule(row) && row.label.toLowerCase().startsWith(text)) {
        event.preventDefault();
        setActive(index);
        return;
      }
    }
  };

  return createPortal(
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      // Focus stays on the panel and the active row is named rather than
      // focused — the roving pattern a menu wants, and what lets one `keydown`
      // handler serve every entry instead of one per row.
      aria-activedescendant={active === null ? undefined : `${id}-${active}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // Hidden rather than absent until placed: it has to be in the document to
      // be measured, and on screen at 0,0 for one frame is a flash in the corner.
      style={
        box ? { left: box.left, top: box.top, maxHeight: box.maxHeight } : { left: 0, top: 0, visibility: "hidden" }
      }
      className={`bg-strip border-line-strong animate-panel-in fixed z-70 overflow-y-auto border py-1 shadow-xl outline-none ${WIDTH}`}
    >
      {/* What the menu is about, which is also what it is called. Truncated
          rather than wrapped: a menu that changes height with the length of a
          filename would be placed against the wrong one. */}
      <div className="text-ink-faint border-line truncate border-b px-2.75 pt-1.25 pb-1.5 font-mono text-caption/none">
        {label}
      </div>

      {rows.map((row, index) =>
        isRule(row) ? (
          // The toolbar's `Rule`, turned horizontal — the same line, in the
          // same colour, doing the same job between blocks.
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a rule has no identity beyond where it falls
            key={`rule-${index}`}
            aria-hidden
            className="bg-line my-1 h-px"
          />
        ) : (
          <Item
            key={row.id}
            id={`${id}-${index}`}
            row={row}
            active={active === index}
            onHover={() => setActive(index)}
            onChoose={() => choose(index)}
          />
        ),
      )}

      {/* The sentence, for whichever dead entry is under the pointer or the
          cursor (§3). It goes here rather than on the row because the row is
          2a's 23px with a hint pushed right, and none of these sentences fit
          in what is left of 206px — and rather than in a tooltip because this
          is already a floating layer, and a bubble over a menu is a second one
          over the first (TRE-76). */}
      {reason !== null && (
        <div className="text-ink-faint border-line mt-1 border-t px-2.75 pt-1.5 pb-0.5 font-mono text-caption">
          {reason}
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * One entry.
 *
 * `aria-disabled`, never `disabled`: the reason an operation cannot run is the
 * most useful thing on the row, and a control disabled by the attribute is not
 * reachable, not readable and not announced. Inert either way — `choose`
 * returns before the handler.
 */
function Item({
  id,
  row,
  active,
  onHover,
  onChoose,
}: {
  id: string;
  row: MenuEntry;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  const disabled = row.unavailableReason !== undefined;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard is the panel's, as a menu's is — one handler and `aria-activedescendant`, not a listener per row
    <div
      id={id}
      role="menuitem"
      aria-disabled={disabled}
      // The reason travels as the accessible description rather than a tooltip:
      // this row is already inside a floating layer, and a bubble over a menu is
      // a second one over the first (TRE-76).
      aria-label={disabled ? `${row.label} — ${row.unavailableReason}` : undefined}
      tabIndex={-1}
      onMouseEnter={onHover}
      onClick={disabled ? undefined : onChoose}
      className={[
        "flex h-5.75 items-center gap-2.25 px-2.75 font-mono text-xs/none",
        // Danger keeps its colour while disabled: `rm` should never look
        // routine, and a greyed-out `rm` is a routine-looking `rm`.
        row.danger ? "text-danger-soft" : disabled ? "text-ink-faint" : "text-ink-soft",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        active ? "bg-line" : "",
      ].join(" ")}
    >
      <span className="truncate">{row.label}</span>
      <div className="flex-1" />
      {row.hint && <span className="text-ink-faint flex-none font-mono text-caption/none">{row.hint}</span>}
    </div>
  );
}
