"use client";

import { useEffect } from "react";

import type { RefObject } from "react";

/**
 * The composited scrollbar, shared out of the terminal (TRE-113 → TRE-117).
 *
 * Styling `::-webkit-scrollbar` takes the thumb off the compositor: content
 * keeps scrolling on the compositor thread while the thumb waits for a
 * main-thread paint that Chrome defers during scrolls — so the thumb trails
 * the very thing it describes. The cure is to stop asking the native thumb to
 * be 4.5px and draw our own: a 0×0 sticky rail pinned to the scrollport,
 * holding two absolutely-positioned thumbs whose travel is a scroll-driven
 * transform animation (`animation-timeline: scroll()`), run by the compositor
 * on the same thread as the scrolling itself. The CSS lives in `globals.css`
 * behind `@supports (animation-timeline: scroll())`; where that fails, the
 * rail is `display: none` and the native bar takes over.
 *
 * Three moves, one contract: the scroller wears `scroll-composited`, renders
 * `<ScrollThumbRail />` as its first child, and calls `useScrollThumbs` with
 * something that changes whenever its content does.
 *
 * It used to carry a fourth, unwritten condition — the class also set
 * `container-type: size`, which means `contain: size`, so a box taking its
 * height from its children collapsed to nothing. That is what kept the ⌘K
 * list and the `max-h` menus on the native bar, and so on the trailing thumb
 * this file exists to remove (TRE-120). The containment was only holding up
 * the `cqh`/`cqw` the travel was spanned in, and the scrollport is already
 * measured below — so it is written out instead, and the condition is gone.
 * Any scroller can wear this now, whatever decides its height.
 */
export function ScrollThumbRail() {
  return (
    <div
      aria-hidden
      className="scroll-thumb-rail"
    >
      <span className="scroll-thumb-y" />
      <span className="scroll-thumb-x" />
    </div>
  );
}

/**
 * The four numbers the CSS cannot derive itself: the two thumb lengths
 * (client²/scroll per axis) as `--sb-vh`/`--sb-hw`, and the scrollport as
 * `--sb-ch`/`--sb-cw`, which is how far a thumb travels. Written when the box
 * or the content changes and never per scroll frame: while the wheel turns,
 * the thumb is a compositor animation and the main thread is not consulted,
 * which is the entire point of TRE-113.
 *
 * The scrollport is measured as the **content** box — `clientHeight` less the
 * padding — because that is the box `100cqh` used to resolve against, so the
 * scrollers converted before TRE-120 keep the geometry they were tuned with.
 * It matters wherever padding rides the scroller itself: the two boxes differ
 * there, and the sidebar carries a note about the 7px it costs.
 *
 * `content` is the caller saying what its scrollable size is a function of —
 * the terminal passes its lines, the pane passes the virtualiser's spacer
 * height. The `ResizeObserver` answers the box's half of the question. For a
 * scroller whose content grows inside children it cannot see — the sidebar's
 * sections own their queries — `inner` names one in-flow wrapper to observe
 * instead, whose height *is* the content height.
 *
 * An axis that clips rather than scrolls gets 0, so no thumb ever floats over
 * content that cannot move that way. Pixels rather than rem because these are
 * measurements of live boxes that already follow `--ui-base`; the floor keeps
 * a five-hundred-row buffer's thumb graspable.
 */
export function useScrollThumbs<T extends HTMLElement>(
  ref: RefObject<T | null>,
  content: unknown,
  inner?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const floor = 1.5 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const { overflowX, overflowY } = style;
      const scrollsY = overflowY === "auto" || overflowY === "scroll";
      const scrollsX = overflowX === "auto" || overflowX === "scroll";
      const vertical =
        scrollsY && el.scrollHeight > el.clientHeight
          ? Math.max(floor, (el.clientHeight * el.clientHeight) / el.scrollHeight)
          : 0;
      const horizontal =
        scrollsX && el.scrollWidth > el.clientWidth
          ? Math.max(floor, (el.clientWidth * el.clientWidth) / el.scrollWidth)
          : 0;
      const pad = (side: string) => Number.parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
      el.style.setProperty("--sb-vh", `${vertical}px`);
      el.style.setProperty("--sb-hw", `${horizontal}px`);
      el.style.setProperty("--sb-ch", `${el.clientHeight - pad("top") - pad("bottom")}px`);
      el.style.setProperty("--sb-cw", `${el.clientWidth - pad("left") - pad("right")}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (inner?.current) observer.observe(inner.current);
    return () => observer.disconnect();
  }, [ref, content, inner]);
}
