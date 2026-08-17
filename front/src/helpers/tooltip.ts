/**
 * The tooltip's surface and the inks allowed on it (TRE-76).
 *
 * Here rather than in the component for one reason: `scripts/verify-contrast.ts`
 * measures these, and Node runs that script directly — it can strip types, but
 * not JSX. Importing them from the `.tsx` would end the check, and a check with
 * its own copy of the palette is a check of the copy.
 *
 * `raised` is this DS's token for anything floating above the app surface, which
 * is what the toast already wears. Opaque, unlike the bubble a sibling app draws
 * over its charts: nothing else here is translucent, an opaque fill is a colour
 * that can be measured rather than composited, and this one is drawn over the
 * light panes as well as the dark chrome, where a 90% one would be neither.
 *
 * `ink-faint` — the app's ordinary colour for a second line, and therefore the
 * one that would arrive here out of habit — measures 2.9:1 on `raised`. It is
 * refused, and the check prints that number so the refusal stays a fact rather
 * than a preference.
 */

export const TOOLTIP_SURFACE = "bg-raised";
/** Body text and the values in a block. */
export const TOOLTIP_INK = "text-ink-soft";
/** The subject line of a block — the one thing in the bubble read first. */
export const TOOLTIP_SUBJECT_INK = "text-ink";
/** Row labels, and the note under them. */
export const TOOLTIP_LABEL_INK = "text-ink-muted";
