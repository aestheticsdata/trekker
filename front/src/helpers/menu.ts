/**
 * Where a context menu goes (TRE-70 §5).
 *
 * This is arithmetic pretending to be a layout, and its failure mode is not a
 * crash: it is a menu with three rows below the fold, at one window height, at
 * one pointer position, which nobody finds by right-clicking around for a
 * minute. So it is pure, it is here rather than inside the component, and
 * `scripts/verify-menu.ts` sweeps it.
 *
 * The rules, in the order they are applied:
 *
 *   - top-left at the pointer, which is down-and-right, because that is where
 *     every desktop menu opens and where the hand already is;
 *   - flipped to the other side of the pointer, per axis, when that side does
 *     not fit;
 *   - clamped to the viewport when neither side fits, scrolling inside itself
 *     rather than overflowing — a menu taller than the window is ordinary on a
 *     short one, and a menu drawn past the bottom edge is unreachable;
 *   - never covering the point it opened at, so the row being acted on is still
 *     on screen while the menu about it is read.
 *
 * Fractional sizes are the normal case, not the exception: `--ui-base` (TRE-44)
 * scales every length in the app through a percentage, so a menu is 197.6px
 * wide as often as it is 208.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface MenuBox {
  left: number;
  top: number;
  width: number;
  /**
   * What the menu may draw in. Equal to its natural height whenever that fits,
   * and less when it has to scroll inside itself.
   */
  maxHeight: number;
}

/** How close to the edge a menu may sit. Small: this is a dense app. */
const MARGIN = 4;

export function placeMenu(point: Point, size: Size, viewport: Size, margin = MARGIN): MenuBox {
  // A viewport too small to hold a margin on both sides is not a case to solve,
  // only one not to divide by: the menu takes what there is.
  const room = { width: Math.max(0, viewport.width - margin * 2), height: Math.max(0, viewport.height - margin * 2) };

  const width = Math.min(size.width, room.width);
  const left = alongX(point.x, width, viewport.width, margin);
  const { top, maxHeight } = alongY(point.y, Math.min(size.height, room.height), viewport.height, margin);

  return { left, top, width, maxHeight };
}

/**
 * The horizontal half, which never shortens the menu — a menu narrowed to fit
 * would wrap its labels, and these are commands whose length is the point.
 */
function alongX(x: number, width: number, viewport: number, margin: number): number {
  if (x + width <= viewport - margin) return x;
  const flipped = x - width;
  if (flipped >= margin) return flipped;
  // Neither side holds it, so it is pinned to whichever edge leaves it most on
  // screen. The pointer ends up inside the box horizontally, which is why the
  // vertical half below always leaves it on a boundary.
  return Math.max(margin, Math.min(x, viewport - margin - width));
}

/**
 * The vertical half, which does shorten it, because the alternative is rows
 * that cannot be reached at all.
 */
function alongY(y: number, height: number, viewport: number, margin: number): { top: number; maxHeight: number } {
  const below = Math.max(0, viewport - margin - y);
  const above = Math.max(0, y - margin);

  if (height <= below) return { top: y, maxHeight: height };
  if (height <= above) return { top: y - height, maxHeight: height };

  // Neither side holds it whole. The roomier side takes it and it scrolls, and
  // either way the pointer stays on an edge of the box rather than under it.
  return below >= above ? { top: y, maxHeight: below } : { top: margin, maxHeight: above };
}

/**
 * Whether a box hides the point it opened at.
 *
 * Strictly inside, not on the boundary: a menu whose corner sits exactly on the
 * pointer is what every desktop menu does, and the row under that corner is
 * still legible. What this rules out is the pointer ending up in the middle of
 * the menu, which is what happens when a naive clamp runs on both axes at once.
 */
export function covers(box: MenuBox, point: Point): boolean {
  return box.left < point.x && point.x < box.left + box.width && box.top < point.y && point.y < box.top + box.maxHeight;
}
