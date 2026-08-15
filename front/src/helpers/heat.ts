/**
 * The age heat map (TRE-33 §3): seven buckets, and what each one paints.
 *
 * One table, because three things index into it and they must agree. The
 * listing paints a share bar and an age chip from it, and `verify-contrast.ts`
 * reads it to check that every chip it can produce is legible — a check that is
 * worth nothing if the script is looking at a second copy of the ramp.
 *
 * The buckets are **absolute**, never relative to what a directory happens to
 * contain. A relative scale would recolour the same file differently depending
 * on its neighbours, so a directory of uniformly ancient files would look as
 * fresh as one touched this morning — which is the exact question the map is
 * there to answer at a glance.
 *
 * Written out as literal class names rather than composed as `bg-age-${bucket}`:
 * Tailwind reads the source for literal class names, and a token no utility
 * mentions is pruned from the stylesheet — a computed `var(--color-age-3)` then
 * resolves to nothing and the chip silently disappears.
 */

/**
 * Where each bucket ends, in days, and what to call it.
 *
 * Months are thirty days here, as `formatAge` already counts them, so "2 months"
 * in this table and `2mo` in the column mean the same span. The last bucket has
 * no end.
 */
export const AGE_BUCKETS: ReadonlyArray<{ label: string; untilDays: number }> = [
  { label: "under an hour", untilDays: 1 / 24 },
  { label: "under 12 hours", untilDays: 0.5 },
  { label: "under 3 days", untilDays: 3 },
  { label: "under 2 weeks", untilDays: 14 },
  { label: "under 2 months", untilDays: 60 },
  { label: "under 7 months", untilDays: 210 },
  { label: "older", untilDays: Number.POSITIVE_INFINITY },
];

export interface HeatPaint {
  /** The share bar's fill. Every bucket has one. */
  bar: string;
  /**
   * The age chip's fill, or null for the buckets that stay plain text.
   *
   * Only the four fresh buckets get a chip: past a fortnight the exact age
   * stops being what anyone is scanning for, and seven filled chips down a
   * listing is a column of blocks rather than a signal.
   */
  chip: string | null;
  /**
   * The age text: on `chip` where there is one, on the pane where there is not.
   *
   * The flip from near-white to near-black at bucket 3 is the whole reason this
   * is a table. The ramp runs dark to light, and `#f2f8fb` on `--color-age-3`
   * measures 3.4:1 — under AA — where `--color-on-accent` on the same fill
   * measures 4.6:1. Every pair here is checked by `pnpm verify:contrast`.
   */
  ink: string;
}

export const HEAT: readonly HeatPaint[] = [
  { bar: "bg-age-0", chip: "bg-age-0", ink: "text-on-pane-bright" },
  { bar: "bg-age-1", chip: "bg-age-1", ink: "text-on-pane-bright" },
  { bar: "bg-age-2", chip: "bg-age-2", ink: "text-on-pane-bright" },
  { bar: "bg-age-3", chip: "bg-age-3", ink: "text-on-accent" },
  { bar: "bg-age-4", chip: null, ink: "text-on-pane-dim" },
  { bar: "bg-age-5", chip: null, ink: "text-on-pane-dim" },
  { bar: "bg-age-6", chip: null, ink: "text-on-pane-dim" },
];

/** The share bar with the heat map off: present, but saying nothing. */
export const HEAT_OFF_BAR = "bg-share-idle";

/** And the age column with it off — the same plain text the old buckets use. */
export const HEAT_OFF_INK = "text-on-pane-dim";

/**
 * Every background an unchipped age can land on, worst case first.
 *
 * A row is one of five colours depending on whether it is selected, hovered, and
 * whether its pane has the keyboard. The contrast check has to hold on all of
 * them, so they are listed here rather than left implicit in the pane's class
 * strings.
 */
export const PANE_SURFACES: readonly string[] = [
  "bg-pane",
  "bg-pane-active",
  "bg-pane-hover",
  "bg-pane-sel",
  "bg-pane-sel-idle",
];

/** Which bucket an age falls in. A future mtime is "now", not "ancient". */
export function ageIndex(days: number): number {
  const found = AGE_BUCKETS.findIndex((bucket) => days < bucket.untilDays);
  return found === -1 ? AGE_BUCKETS.length - 1 : found;
}
