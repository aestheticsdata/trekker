import type { DiskMount } from "@lib/api/disks";

/**
 * What the volumes panel and the pane headers compute from a mount (TRE-33 §1).
 *
 * Here rather than in either component because both need the same two answers
 * and they must not differ: the sidebar row says a volume is amber, and the
 * header of a pane sitting on that volume has to say the same thing about the
 * same filesystem.
 */

/** Cells in the segmented bar the mockup draws for each mount. */
export const DISK_CELLS = 10;

/**
 * The filled chip that marks a warning in the chrome — a stale scan today.
 *
 * A solid fill rather than a tint. `bg-warning/15` reads as the gentler thing
 * to do, and it composited to `#273339` over `--color-strip`, on which
 * `--color-warning` measured 4.44:1 — under AA by a margin nobody would ever
 * catch by looking. TRE-81's lift puts that same composite at 4.67:1, so the
 * ratio no longer decides it and the second reason does, as it always did. A
 * translucent fill cannot be checked by
 * `verify-contrast.ts`, which reads token hexes and has no way to composite,
 * so the tint would have been the one warning in the app that quietly opted out
 * of the check the rest of it passes. Here rather than in the component so the
 * script can read the pair.
 */
export const WARN_CHIP_FILL = "bg-warning";
export const WARN_CHIP_INK = "text-on-accent";

/**
 * Every ink the docked strip puts on its own ground (TRE-80).
 *
 * The strip is drawn on `--color-strip`, which is a fourth depth nothing else
 * in the dark half uses except the ⌘K palette — so an ink that clears AA on the
 * chrome does not automatically clear here, and until this ticket two of these
 * did not. The mockup writes the heading in `#3e8fae` (4.34:1) and a dozen
 * quiet lines in `#4d7f99` (3.64:1), both inline, where `verify-contrast.ts`
 * could not see them.
 *
 * Declared here rather than in the component for the reason `press.ts` and
 * `tail.ts` exist: a pair the check can read is a pair the check can hold, and
 * the strip's ground is a fact about the strip rather than about one `<p>`.
 * `verify:contrast` now also sweeps the components, so an inline pair no longer
 * escapes it either — but a surface with a named ground is still the clearer
 * way to say what a box is drawn on.
 */
export const STRIP_SURFACE = "bg-strip";
/** `DISK USAGE ·` and the mount it is reading. */
export const STRIP_LABEL_INK = "text-ink-label";
/** The scan state, "never scanned", the facts row, the empty states. */
export const STRIP_QUIET_INK = "text-ink-faint";
/** A figure the row is actually about — a size, a count, a phase. */
export const STRIP_VALUE_INK = "text-ink-soft";
/** The rescan control, which is the one thing here that answers a pointer. */
export const STRIP_ACTION_INK = "text-ink-dim";
/** A scan that failed, and the amber that says one is stale. */
export const STRIP_ALARM_INK = "text-danger-soft";

/**
 * How many of the ten cells are filled.
 *
 * Rounded, not floored: the gauge is a tenth-of-the-disk reading, and a volume
 * at 46% is nearer five cells than four. The consequence at the bottom of the
 * range is deliberate — under 5% lights nothing, which is what an empty disk
 * should look like, and the percentage is printed beside it for anyone who
 * wants the real number.
 */
export function filledCells(percent: number): number {
  return Math.min(DISK_CELLS, Math.max(0, Math.round(percent / (100 / DISK_CELLS))));
}

/**
 * The filesystem a path is actually on.
 *
 * The longest mount point that contains the path, which is the rule the kernel
 * itself uses: `/var/log` on its own volume must win over `/`, or every pane
 * would report the root filesystem's fullness whatever it was looking at.
 *
 * The boundary is a segment, never a string prefix. `/var/logs` is not under
 * `/var/log`, and `startsWith` alone says it is.
 */
export function volumeFor(path: string, disks: readonly DiskMount[]): DiskMount | null {
  let best: DiskMount | null = null;

  for (const disk of disks) {
    const mount = disk.mountPoint;
    const contains = mount === "/" ? path.startsWith("/") : path === mount || path.startsWith(`${mount}/`);
    if (!contains) continue;
    if (best === null || mount.length > best.mountPoint.length) best = disk;
  }

  return best;
}
