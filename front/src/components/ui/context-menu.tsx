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

  /**
   * Whatever held focus when the menu opened, so it can be handed back on the
   * way out (TRE-70 §6).
   *
   * Read in a layout effect on mount, which is before the panel takes focus
   * below — that one waits for the placement and lands a commit later.
   *
   * `body` is stored as nothing rather than as itself: it is what
   * `document.activeElement` reports when nothing is focused at all, which in a
   * listing is the usual case, and `body.focus()` would be a blur dressed up as
   * a restoration.
   */
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const held = document.activeElement;
    returnTo.current = held instanceof HTMLElement && held !== document.body ? held : null;
    const node = panel.current;

    return () => {
      const back = returnTo.current;
      // Still in the document: the menu's own `rm` can delete the row that
      // opened it, and a logout takes the whole tree with it.
      if (!back?.isConnected) return;
      // And only if the menu still had the focus it is handing back. An outside
      // click is one of the ways this menu closes, and if that click landed in
      // the glob field or the terminal's input, the browser has already focused
      // it — restoring here would yank the caret out of a field somebody just
      // aimed at. `body` is nobody, and counts as still ours.
      const now = document.activeElement;
      if (now !== null && now !== document.body && !node?.contains(now)) return;
      back.focus();
    };
  }, []);

  /**
   * Focus lands on the panel, so `↓` belongs to the menu from the first key —
   * but only once it has been placed (TRE-109).
   *
   * On the first commit the panel is `visibility: hidden` to be measured, and a
   * hidden element cannot be focused: the call is not deferred there, it is
   * dropped. That is what it did from TRE-70 until this ticket — mounted,
   * focused nothing, and left `aria-activedescendant` below pointing at a row
   * no screen reader was following, since that attribute is only ever read off
   * the focused element.
   */
  useLayoutEffect(() => {
    if (box === null) return;
    panel.current?.focus();
  }, [box]);

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

  /**
   * The menu's keyboard, on the window (TRE-109).
   *
   * It was on the panel, where it could only ever fire while the panel held
   * focus — and the panel took none, for the reason written above the placement
   * effect. So `⎋` did nothing, and neither did any other key here, on a menu
   * the explorer had already stood down for: the keyboard was dead for as long
   * as the menu was up, and `⇧F10` opened one that the keyboard which opened it
   * could not walk or dismiss.
   *
   * The window is where this app's other two layers listen, for the reason
   * `useKeyboard` states in `explorer.tsx`: nothing underneath them holds a
   * focus to hang a handler off. Focus is still taken, and still matters — it
   * is what makes `aria-activedescendant` mean anything — but no key depends on
   * it any more.
   *
   * Capture, and propagation stopped on every key the menu takes, because a
   * menu is a mode: a letter typed at it must not also reach whatever had focus
   * when it opened. The terminal's input and the glob field are both plausible
   * holders, and a type-ahead landing in one of them is worse than the dead key
   * it replaces. Anything the menu has no use for is left alone and travels on
   * — `⌘X` over an open menu is still the clipboard's.
   *
   * Subscribed on every render on purpose, with no dependency list. The handler
   * closes over the active row, the rows themselves and both callbacks; a pair
   * of `addEventListener` calls is cheaper than a rule about which of those
   * identities is stable, and nothing here should rest on the compiler holding
   * one still.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      /** This key is the menu's: nothing behind it hears about it. */
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      switch (event.key) {
        case "Escape":
          take();
          onClose();
          return;
        case "ArrowDown":
          take();
          step(1);
          return;
        case "ArrowUp":
          take();
          step(-1);
          return;
        case "Home":
          take();
          if (live.length > 0) setActive(live[0]);
          return;
        case "End":
          take();
          if (live.length > 0) setActive(live[live.length - 1]);
          return;
        case "Enter":
        case " ":
          take();
          if (active !== null) choose(active);
          return;
        case "Tab":
          // A menu is a mode, not a stop on the way to something else.
          take();
          onClose();
          return;
        default:
          break;
      }

      // Type-ahead. One letter jumps to the next entry starting with it, and a
      // second letter within the window extends the search rather than starting
      // a new one — so `co` reaches `copy path` past `copy`.
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      const now = event.timeStamp;
      const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + event.key.toLowerCase();
      typed.current = { text, at: now };

      const from = active === null ? 0 : live.indexOf(active) + (text.length === 1 ? 1 : 0);
      for (let offset = 0; offset < live.length; offset += 1) {
        const index = live[(from + offset + live.length) % live.length];
        const row = rows[index];
        if (!isRule(row) && row.label.toLowerCase().startsWith(text)) {
          take();
          setActive(index);
          return;
        }
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

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
      // Hidden rather than absent until placed: it has to be in the document to
      // be measured, and on screen at 0,0 for one frame is a flash in the corner.
      style={
        box ? { left: box.left, top: box.top, maxHeight: box.maxHeight } : { left: 0, top: 0, visibility: "hidden" }
      }
      className={`bg-strip border-line-strong animate-panel-in fixed z-70 overflow-y-auto border py-1 shadow-xl ${WIDTH}`}
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
        row.danger ? "text-danger-soft" : disabled ? "text-ink-dim" : "text-ink-soft",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
        active ? "bg-line" : "",
      ].join(" ")}
    >
      <span className="truncate">{row.label}</span>
      <div className="flex-1" />
      {row.hint && (
        // The row fills with `line` under the cursor, and the quiet step is the one
        // ink on this panel that does not survive that fill (3.62:1). It steps up
        // with the row, as the palette's second line already does (TRE-36 §4).
        <span className={`flex-none font-mono text-caption/none ${active ? "text-ink-dim" : "text-ink-faint"}`}>
          {row.hint}
        </span>
      )}
    </div>
  );
}
