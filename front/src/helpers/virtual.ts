/**
 * The arithmetic behind the virtualised listing (TRE-19 §1).
 *
 * Kept pure, and kept away from React, because this is the half of
 * virtualisation that has a checkable answer: given a scroll position and a row
 * height, exactly which indices have to be in the DOM. `scripts/verify-virtual.ts`
 * asks the same question by brute force and the two have to agree.
 *
 * The row height is a parameter rather than a constant on purpose. `--ui-base`
 * (TRE-44) rescales every length in the app at runtime, so a listing's rows are
 * 22px at the default and 28 at the top of the range — a literal here would be
 * wrong for most of that range, and wrong in the way that leaves a band of
 * blank pane below the last rendered row.
 */

export interface RowWindow {
  /** First index to render, inclusive. */
  start: number;
  /** One past the last index to render. */
  end: number;
  /** Height of everything above `start` — where the window is translated to. */
  offset: number;
  /** The whole list's height, which is all the scrollbar knows about it. */
  total: number;
}

/**
 * How many rows to keep mounted above and below the viewport.
 *
 * Eight is about 180px at the default scale: enough that a trackpad flick lands
 * on rendered rows rather than on a blank band waiting for the next paint, and
 * far short of the point where the overscan is itself the cost. It also means a
 * pane never mounts fewer than seventeen rows, so `⇞`/`⇟` — which move by a
 * viewport — always land inside something already rendered.
 */
export const OVERSCAN = 8;

/**
 * Which slice of a fixed-height list is worth rendering.
 *
 * Everything is derived from `Math.floor(scrollTop / rowHeight)` and nothing
 * else reads `scrollTop` directly, which is what lets the caller ignore scroll
 * events that do not cross a row boundary: two positions inside the same row
 * produce byte-identical windows, so re-rendering for them would be work with
 * no visible result.
 *
 * A zero row height means the probe has not measured yet — one layout pass on
 * first mount, and whatever the browser does mid-resize. Rendering nothing for
 * that pass is right: the alternative is guessing a height and painting the
 * list at the wrong offset before correcting it.
 */
export function rowWindow(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewport: number,
  overscan: number = OVERSCAN,
): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, offset: 0, total: Math.max(0, count) * rowHeight };

  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  // `+ 1` because a viewport rarely starts on a row boundary: 100px of pane
  // over 22px rows shows five rows aligned and six the rest of the time.
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;

  const start = Math.max(0, Math.min(count - 1, first - overscan));
  const end = Math.max(start, Math.min(count, first + visible + overscan));

  return { start, end, offset: start * rowHeight, total: count * rowHeight };
}
