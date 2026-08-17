"use client";

import { TOOLTIP_INK, TOOLTIP_LABEL_INK, TOOLTIP_SUBJECT_INK, TOOLTIP_SURFACE } from "@helpers/tooltip";
import { cloneElement, Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { FocusEvent, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from "react";

/**
 * The app's tooltip (TRE-76), ported from the one two sibling apps share and
 * rebuilt on this DS's tokens.
 *
 * It replaces the native `title`, which arrived after the browser's own delay,
 * wherever the OS chose to draw it, in a font and at a size nothing else in this
 * UI matches — and which no keyboard user could reach at all. Half the text in
 * this app truncates into a 176px sidebar or a 218px inspector, so a hint here
 * is not an enhancement of the row: it is the row's only readable form.
 *
 * It follows the pointer, and that is the point rather than a flourish. Hints
 * are read sequentially — the eye travels a column of them asking *this one?
 * this one?* — so the answer has to arrive where the eye already is.
 */

/** Measure-then-place has to run before paint, or the flip at the viewport edge
 *  is a visible jump. `useLayoutEffect` warns on the server, so it degrades. */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Kept in step with `duration-100` on the bubble — the unmount has to outlive
 *  the fade, or the bubble disappears mid-way through leaving. */
const FADE_MS = 100;

/**
 * The gap kept from the pointer, the gap kept from a focused trigger's box, and
 * the margin kept from the viewport.
 *
 * The only lengths in this app that are px rather than `rem`, and deliberately
 * so: everything else scales with `--ui-base` (TRE-44), while these two clear
 * the mouse cursor and the edge of the screen. Neither of those gets smaller
 * when the UI does.
 */
const CURSOR_GAP = 16;
const FOCUS_GAP = 6;
const VIEWPORT_EDGE = 12;

/**
 * The bubble's own box.
 *
 * ⚠️ `w-max`, not `w-fit`. Both draw the same box in open space, but
 * `fit-content` resolves against the room left between the bubble's own `left`
 * and the edge of the viewport — so a wide hint whose trigger is near the right
 * edge measures as a narrow column, the flip below uses that wrong width, and it
 * lands in the wrong place once it re-expands. `max-content` capped by
 * `max-w-72` is the same width wherever it is asked, which is what a
 * measure-then-move engine needs.
 *
 * ⚠️ `whitespace-pre-line`. A native `title` renders `\n` as a line break and
 * some of the strings this replaced rely on it; a `div` collapses it.
 *
 * `max-w-72` is the toast's width, so the two things in this app that float
 * above it agree about how wide that is.
 */
const SURFACE = `${TOOLTIP_SURFACE} ${TOOLTIP_INK} border-line-strong z-60 w-max max-w-72 rounded-sm border px-2.5 py-1.5 font-sans text-xs whitespace-pre-line shadow-lg`;

/** Viewport coordinates, as a pointer event reports them. */
interface Point {
  x: number;
  y: number;
}

/**
 * What the tooltip puts on its trigger — and what it chains onto when the
 * trigger already has one of its own.
 *
 * Typed against `HTMLElement` rather than per element: a JSX element's props are
 * `any` at the boundary, so a `<button>`, an `<li>` and a `<span>` all satisfy
 * this, while inside the component the handlers still read back as something
 * callable rather than as `unknown`.
 */
interface TriggerProps {
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseMove?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
}

/** Ours first, then whatever the trigger already had — never instead of it. */
function chain<E>(ours: (event: E) => void, theirs?: (event: E) => void) {
  return (event: E) => {
    ours(event);
    theirs?.(event);
  };
}

/**
 * The bubble: portals to `<body>`, places itself against a point, clamps inside
 * the viewport and fades at both ends.
 *
 * The point is a pointer position when the mouse is driving and the bottom-left
 * corner of the trigger's box when the keyboard is. Nothing here needs to know
 * which — a point and a gap is the whole interface, which is why keyboard
 * support costs a rectangle rather than a second engine.
 */
function Bubble({ point, gap, id, children }: { point: Point | null; gap: number; id: string; children: ReactNode }) {
  /** The last point, kept after `point` goes null so the bubble fades out where
   *  it was rather than vanishing between two frames. */
  const [shown, setShown] = useState<Point | null>(null);
  const [visible, setVisible] = useState(false);
  const [placed, setPlaced] = useState<Point | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  const open = point !== null;

  useEffect(() => {
    if (point) setShown(point);
  }, [point]);

  /**
   * Reveal on the frame after the bubble exists, so a fresh mount has an opacity
   * to transition from; on the way out, fade first and unmount once the fade
   * cannot still be running.
   *
   * ⚠️ The dependency is the boolean, not the point. A pointer moving faster
   * than the display — which a 120Hz screen or a high-poll mouse manages — would
   * otherwise cancel each animation frame before it ever ran, and the bubble
   * would sit at zero opacity for as long as the hand kept moving.
   */
  useEffect(() => {
    if (open) {
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }

    setVisible(false);
    const timer = setTimeout(() => setShown(null), FADE_MS + 40);
    return () => clearTimeout(timer);
  }, [open]);

  useIsomorphicLayoutEffect(() => {
    const element = bubble.current;
    if (!shown || !element) return;

    // Flipped to the other side of the point rather than slid along the edge: a
    // bubble pinned to the right margin while the pointer keeps moving reads as
    // stuck to it.
    const { width, height } = element.getBoundingClientRect();

    let left = shown.x + gap;
    if (left + width + VIEWPORT_EDGE > window.innerWidth) left = shown.x - gap - width;

    let top = shown.y + gap;
    if (top + height + VIEWPORT_EDGE > window.innerHeight) top = shown.y - gap - height;

    setPlaced({ x: Math.max(VIEWPORT_EDGE, left), y: Math.max(VIEWPORT_EDGE, top) });
  }, [shown, gap]);

  if (!shown) return null;

  return createPortal(
    <div
      // ⚠️ `pointer-events-none`. A bubble that took the pointer would end the
      // hover that summoned it, and then flicker at pointer rate.
      className={`${SURFACE} pointer-events-none fixed transition-opacity duration-100 ease-out ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      id={id}
      ref={bubble}
      role="tooltip"
      style={{ left: placed?.x ?? shown.x + gap, top: placed?.y ?? shown.y + gap }}
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * Wraps one element and describes it.
 *
 * ⚠️ **The hover state lives here, not in the caller.** A mousemove sets state
 * at pointer rate; in this wrapper that re-renders the wrapper and its portal
 * and nothing else, because `children` arrives as the same element object every
 * time and cloning it preserves that element's own `children` reference — so
 * React diffs the trigger's props and bails out of everything beneath it. The
 * same state lifted into a screen would re-render every row on it per move.
 *
 * ⚠️ **A `disabled` trigger fires no mouse event at all**, so a control disabled
 * by the attribute cannot be described — and the hints explaining *why*
 * something is unavailable are exactly the ones worth having. Those controls say
 * `aria-disabled` instead, with the click guarded in the handler: still not
 * activatable, still styled as unavailable, but hoverable and — for the first
 * time — reachable by keyboard. The base layer in `globals.css` already keys the
 * cursor off `[aria-disabled="true"]`.
 */
export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement<TriggerProps> }) {
  const [hover, setHover] = useState<Point | null>(null);
  const [focused, setFocused] = useState<Point | null>(null);
  const id = useId();

  // Nothing to say — hand the trigger back untouched. Not an empty bubble, and
  // not a live wrapper either: that would still bind handlers and still open on
  // focus, so a keyboard user would tab into a tooltip made of nothing. The
  // hooks above run either way, which is why they run first.
  if (content === null || content === undefined || content === "") return children;

  const point = hover ?? focused;
  const track = (event: MouseEvent<HTMLElement>) => setHover({ x: event.clientX, y: event.clientY });

  /**
   * ⚠️ `:focus-visible`, not focus. Clicking a button focuses it, and the
   * pointer is already driving the bubble — re-anchoring to the box mid-hover
   * would make it jump out from under the cursor.
   *
   * ⚠️ And the test is on the **target**, not on `currentTarget`. Focus bubbles,
   * and where the trigger wraps a control that never takes focus itself, asking
   * whether *it* is focus-visible answers no on precisely the hints that most
   * need the keyboard. The box still comes from the trigger, which is what the
   * bubble is describing.
   */
  const anchor = (event: FocusEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(":focus-visible")) return;

    const box = event.currentTarget.getBoundingClientRect();
    setFocused({ x: box.left, y: box.bottom });
  };

  // ⎋ closes it. The trigger holds focus for as long as this bubble is up, so
  // the key event passes through here on its way out and no listener on the
  // document is needed.
  const dismiss = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") setFocused(null);
  };

  return (
    <>
      {/* ⚠️ Both `onMouseMove` and `onMouseEnter`. Move alone loses the pointer
          that lands on a trigger and stops, and the trigger that appears under a
          pointer already at rest. */}
      {cloneElement(children, {
        "aria-describedby": point ? id : children.props["aria-describedby"],
        onBlur: chain(() => setFocused(null), children.props.onBlur),
        onFocus: chain(anchor, children.props.onFocus),
        onKeyDown: chain(dismiss, children.props.onKeyDown),
        onMouseEnter: chain(track, children.props.onMouseEnter),
        onMouseLeave: chain(() => setHover(null), children.props.onMouseLeave),
        onMouseMove: chain(track, children.props.onMouseMove),
      })}
      <Bubble
        gap={hover ? CURSOR_GAP : FOCUS_GAP}
        id={id}
        point={point}
      >
        {content}
      </Bubble>
    </>
  );
}

/** One measurement, in the block below. */
export interface TooltipRow {
  /**
   * The left column. Lowercase and unpunctuated — `size`, `share`, `when`. These
   * are table labels, read as a column, not sentences read one at a time.
   */
  label: string;
  value: ReactNode;
}

/**
 * The shape a hint takes when it carries more than a phrase: a subject, the
 * measurements under it, and a note.
 *
 * It exists because a `title` could only ever be one flat line, and several
 * sites were paying for that — the strip's `duplicates` fact read as one run-on
 * sentence about three different numbers. Values sit right-aligned in a column
 * of their own and in mono, so they line up on the digit and compare downward.
 *
 * One shape for every site that uses it, so they cannot drift into six layouts,
 * and deliberately not a framework: no variants, no `kind`. The moment this
 * grows a `variant` prop it has stopped being a shape. Which rows to render, and
 * whether there are any at all, is the caller's business.
 */
export function TooltipBlock({
  subject,
  rows = [],
  note,
}: {
  subject: ReactNode;
  rows?: readonly TooltipRow[];
  /** The reason, the caveat, or what clicking would do. Last, and quieter. */
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      {/* `break-all`, because most subjects here are paths and a path has no
          spaces to break at — left alone it sets the bubble's max width and
          then overflows it. */}
      <div className={`${TOOLTIP_SUBJECT_INK} font-medium break-all`}>{subject}</div>

      {rows.length > 0 && (
        // Padding on the label rather than `gap-x`, so the two columns keep
        // their spacing without the grid also reserving any at the right edge.
        <div className="mt-1 grid grid-cols-[auto_1fr] gap-y-0.5">
          {rows.map((row) => (
            <Fragment key={row.label}>
              <div className={`${TOOLTIP_LABEL_INK} pr-3`}>{row.label}</div>
              <div className={`${TOOLTIP_INK} text-right font-mono tabular-nums`}>{row.value}</div>
            </Fragment>
          ))}
        </div>
      )}

      {note && <div className={`${TOOLTIP_LABEL_INK} mt-1`}>{note}</div>}
    </div>
  );
}
