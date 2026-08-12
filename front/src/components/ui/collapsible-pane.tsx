"use client";

import { useEffect, useState } from "react";

import type { CSSProperties, ReactNode } from "react";

/**
 * A pane that opens and collapses by taking its space rather than by appearing
 * in it (TRE-62).
 *
 * The counterpart to `Overlay`, and the difference between the two is the whole
 * reason there are two. A dialog floats above the layout, so fading it in is
 * honest: nothing else moves. A pane *is* layout — it takes its width from the
 * panes beside it — so fading one in would have it materialise while they jump
 * sideways regardless. What actually changes is the space, so the space is what
 * moves, from zero to full size and back, with the opacity never touched.
 *
 * It does share `Overlay`'s asymmetry: entering is free, leaving is not. React
 * unmounts the moment the state flips, so this wrapper rather than the caller's
 * condition decides when the child comes down, and it comes down when the
 * transition ends rather than when a timer says it should have.
 */

/**
 * The one thing a timer is still needed for. Below its breakpoint the inspector
 * is `display: none`, so nothing animates and no `transitionend` ever arrives —
 * and a pane whose exit never ends would stay mounted, invisible and at zero
 * width, for the rest of the session. Long enough to outlast either direction.
 */
const NEVER_ANIMATED_MS = 400;

export function CollapsiblePane({
  open,
  size,
  fills = false,
  axis = "width",
  animate = true,
  className = "",
  children,
}: {
  open: boolean;
  /**
   * How big the pane is along `axis` when open, as a CSS length: a token for a
   * panel of a fixed width, `50cqw` for one that halves a row. Whatever it is,
   * it must not be relative to this element — the child is held at this size
   * for the whole transition, and a percentage would resolve against the very
   * box that is moving.
   */
  size: string;
  /**
   * Whether an open pane takes whatever room is left rather than the size it
   * animated to. True for a pane that halves a row: once it has arrived it must
   * follow its neighbours exactly — the other one collapsing, the inspector
   * taking its 218px — and a width of its own would trail a frame behind every
   * one of those and leave a gap. `size` still describes both ends of the
   * transition, and is still what the box is worth on the way in and out.
   */
  fills?: boolean;
  /** Which way it opens. `height` is the same mechanism; TRE-34 is its first caller. */
  axis?: "width" | "height";
  /**
   * False for a layout nobody just asked for: a link that already said open, or
   * TRE-51's session restore landing a moment after first paint. The pane
   * arrives at its size, and a cold open never replays itself.
   */
  animate?: boolean;
  /** The wrapper's own box — a breakpoint, mostly. */
  className?: string;
  children: ReactNode;
}) {
  const [wasOpen, setWasOpen] = useState(open);
  const [moving, setMoving] = useState(false);
  /**
   * The child and the size as they were while the pane was open, which is not
   * the same as what the caller is passing by the time it is closing: the
   * explorer stops indexing the selection the moment the inspector shuts, and
   * in a two-pane row the width a pane leaves from is the one it had before the
   * split changed. What leaves is the last frame of what was there, not a panel
   * redrawn for a layout it is no longer part of.
   *
   * Adjusted during render rather than in an effect, because a pane that
   * reflowed for one frame before being held would defeat the point of holding
   * it. It settles immediately: the re-render sees the same props.
   */
  const [held, setHeld] = useState({ children, size });

  if (wasOpen !== open) {
    setWasOpen(open);
    setMoving(animate);
  }
  if (open && (held.children !== children || held.size !== size)) {
    setHeld({ children, size });
  }

  /**
   * The end of a move, from either direction, and the point at which a pane
   * that has left lets go of what it was showing — a directory of ten thousand
   * rows is not worth keeping alive for as long as its pane stays closed.
   */
  const settle = () => {
    setMoving(false);
    if (!open) setHeld((last) => ({ ...last, children: null }));
  };

  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(settle, NEVER_ANIMATED_MS);
    return () => clearTimeout(timer);
    // `open` as well as `moving`: a pane toggled twice inside one transition
    // never restarts this otherwise, and the fallback would then settle against
    // an answer that has changed underneath it.
  }, [moving, open]);

  return (
    <div
      // `flex-1` only once it has settled: the width stays declared underneath
      // it, inert while the row is dividing the space, so the next collapse has
      // a length to leave from. A transition out of `auto` does not animate at
      // all — it jumps, which is the thing this component exists to prevent.
      className={`pane-collapse ${fills && open && !moving ? "flex-1" : ""} ${className}`}
      data-open={open}
      data-axis={axis}
      data-animate={animate}
      style={{ [axis]: open ? size : 0 } as CSSProperties}
      onTransitionEnd={(event) => {
        // Guarded on both, like `Overlay`: a pane holds a shimmering skeleton
        // and a few dozen controls with their own 100ms hover transitions, any
        // of which would otherwise end the collapse on somebody's behalf.
        if (event.target !== event.currentTarget || event.propertyName !== axis) return;
        settle();
      }}
    >
      {(open || moving) && (
        // The box moves, its contents do not. Held at the size the pane has
        // when open, so a listing slides out of view rather than reflowing
        // sixty times on the way out — `pane.tsx` answers container queries at
        // 25rem and 32.5rem, and a pane that reflows as it shrinks pops its
        // breadcrumb and its type badge out mid-collapse. Fluid again once it
        // settles, so a pane that is merely resized still follows its edge.
        <div
          // `flex-none`, or the wrapper closing around it shrinks it on the way
          // and holding its size achieves nothing.
          className="flex size-full min-h-0 min-w-0 flex-none"
          style={moving ? ({ [axis]: held.size } as CSSProperties) : undefined}
        >
          {held.children}
        </div>
      )}
    </div>
  );
}
