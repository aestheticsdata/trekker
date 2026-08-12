"use client";

import { rowWindow } from "@helpers/virtual";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { RowWindow } from "@helpers/virtual";

/**
 * The scroll container's half of virtualisation (TRE-19): measuring, listening,
 * remembering where each directory was left, and keeping the cursor in view.
 *
 * `rowWindow` decides *what* to render; this decides *when* to ask it again.
 * The two live apart because only one of them can be checked without a browser.
 *
 * Three things are measured rather than assumed. The viewport, because a pane
 * changes height with the split mode and the window. The row height, because
 * `--ui-base` (TRE-44) rescales it and no number written here would survive
 * that. And the scroll position, because it is the only input the window has.
 *
 * Scrolling is entirely this module's business — nothing is handed back for the
 * pane to call. That is deliberate: an exported `scrollToIndex` would end up in
 * an effect's dependency array, and a function identity is the last thing that
 * should decide whether a listing jumps back to the top.
 */

export interface RowWindowApi extends RowWindow {
  /** Put on the element that scrolls. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Put on a zero-width element sized `h-row`; its height is the row height. */
  probeRef: React.RefObject<HTMLElement | null>;
  /** Measured, so `0` until the first layout pass. */
  rowHeight: number;
}

/**
 * `useLayoutEffect` is the right hook here — a measurement the first paint
 * depends on — and React logs a warning for it on the server, where it cannot
 * run. Both are true, so the effect is picked per environment rather than the
 * warning being suppressed.
 */
const useMeasureEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Bring a row into view, and no further than that.
 *
 * At module scope so it has one identity for the life of the page. A row
 * already on screen is left exactly where it is, so holding `↓` walks the list
 * a row at a time instead of jumping by a viewport.
 */
function bringIntoView(element: HTMLElement, index: number, rowHeight: number): boolean {
  const top = index * rowHeight;
  if (top < element.scrollTop) element.scrollTop = top;
  else if (top + rowHeight > element.scrollTop + element.clientHeight) {
    element.scrollTop = top + rowHeight - element.clientHeight;
  } else return false;
  return true;
}

export function useRowWindow({
  count,
  memoryKey,
  ready,
  cursor,
}: {
  count: number;
  /**
   * What a remembered scroll position belongs to — the pane's path. Changing it
   * restores that directory's offset, which is what makes Back land where it
   * was left rather than at the top (TRE-19 §2).
   */
  memoryKey: string;
  /** False while the listing is still in flight: an offset cannot be restored
   * onto a container with nothing in it yet. */
  ready: boolean;
  /**
   * The row to keep visible, or -1 for none. An index rather than a name,
   * because the row it refers to is usually not in the DOM to be scrolled to —
   * which is the whole difficulty virtualisation introduces here.
   */
  cursor: number;
}): RowWindowApi {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLElement | null>(null);

  const [rowHeight, setRowHeight] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  // The scroll listener reads these rather than closing over the state, so it
  // is attached once and never re-attached — a listener removed and added on
  // every render is a listener that misses events mid-flick.
  const rowHeightRef = useRef(0);
  const scrollTopRef = useRef(0);

  /** Offsets by path, for as long as this pane is mounted. */
  const remembered = useRef(new Map<string, number>());
  /** Which path the container's current offset belongs to, once restored. */
  const restored = useRef<string | null>(null);
  /** The last path this pane was pointed at, restored or not. */
  const shown = useRef<string | null>(null);
  /** The path the cursor was last chased in — a new one means we just arrived. */
  const chasing = useRef<string | null>(null);

  /**
   * Take a reading. Called by the scroll listener and by every programmatic
   * scroll, so state never lags the element it describes.
   *
   * Two positions inside the same row produce the same window, so those are
   * dropped: at 22px rows that is most scroll events, and each one it drops is
   * a render of forty rows that would have painted identically.
   *
   * Recorded against `restored`, not against the current path: until a
   * directory's offset has been put back, whatever the container is showing
   * belongs to the one we just left.
   */
  const sync = () => {
    const element = scrollRef.current;
    if (!element) return;

    const next = element.scrollTop;
    if (restored.current !== null) remembered.current.set(restored.current, next);

    const height = rowHeightRef.current;
    if (height <= 0) return;
    if (Math.floor(next / height) === Math.floor(scrollTopRef.current / height)) return;

    scrollTopRef.current = next;
    setScrollTop(next);
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const handler = () => sync();
    element.addEventListener("scroll", handler, { passive: true });
    return () => element.removeEventListener("scroll", handler);
    // `sync` reads everything it needs through refs, so this subscribes once.
  }, []);

  // The probe is measured directly on mount — a ResizeObserver's first callback
  // arrives too late for the first paint — and observed afterwards, which is
  // how the size stepper reaches this without knowing the listing exists.
  useMeasureEffect(() => {
    const probe = probeRef.current;
    if (!probe) return;

    const read = (height: number) => {
      if (height <= 0) return;
      rowHeightRef.current = height;
      setRowHeight(height);
    };

    read(probe.getBoundingClientRect().height);
    const observer = new ResizeObserver(([entry]) => read(entry.contentRect.height));
    observer.observe(probe);
    return () => observer.disconnect();
  }, []);

  useMeasureEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    setViewport(element.clientHeight);
    const observer = new ResizeObserver(([entry]) => setViewport(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * Give a directory its offset back.
   *
   * Guarded by `ready` because a container showing a skeleton has no room to
   * scroll, and an offset written into it is clamped to zero and lost.
   *
   * The debt is cleared on every path change rather than on a successful
   * restore, so a directory that refused to list — where nothing was ever
   * restored, and the container was clamped to zero behind the error state —
   * does not leave the pane believing it is already showing the right offset.
   */
  useMeasureEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    if (shown.current !== memoryKey) {
      shown.current = memoryKey;
      restored.current = null;
    }
    if (!ready || restored.current !== null) return;

    element.scrollTop = remembered.current.get(memoryKey) ?? 0;
    restored.current = memoryKey;
    scrollTopRef.current = element.scrollTop;
    setScrollTop(element.scrollTop);
  }, [memoryKey, ready, count]);

  /**
   * Follow the cursor.
   *
   * Skipped on the render a directory arrives in: its first row becomes the
   * cursor, and following that would scroll to the top, undoing the offset the
   * effect above has just restored.
   *
   * The dependencies are the cursor and the path and nothing else — in
   * particular not `sync` or `bringIntoView`, which are only ever called here
   * and would otherwise re-run this on every scroll, dragging the listing back
   * to the cursor and making the pane impossible to scroll away from.
   */
  useEffect(() => {
    const arriving = chasing.current !== memoryKey;
    chasing.current = memoryKey;

    const element = scrollRef.current;
    if (arriving || cursor < 0 || !element || rowHeightRef.current <= 0) return;
    if (bringIntoView(element, cursor, rowHeightRef.current)) sync();
  }, [memoryKey, cursor]);

  return { ...rowWindow(count, rowHeight, scrollTop, viewport), scrollRef, probeRef, rowHeight };
}
