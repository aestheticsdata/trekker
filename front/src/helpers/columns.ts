import type { SortKey } from "@helpers/listing";

/**
 * Which of a pane's listing columns are showing (TRE-124).
 *
 * The toolbar used to draw this list, as a label with no handler and a tooltip
 * apologising for itself — and it drew it wrong, naming `share`, which is a bar
 * rather than a column anybody sorts by, and omitting `size`, which is a real
 * one. That readout is gone. The columns are now named where they are drawn,
 * by the header, and turned on and off from a menu on it, the way every table
 * on this desktop has worked for twenty years.
 *
 * Per pane, and that follows from where the control is. A menu opened on pane
 * B's header changes pane B; one that reached across and re-laid-out pane A
 * would be the app answering a question nobody asked. It is also the honest
 * shape — two panes are routinely two machines, and wanting `owner` on the
 * remote one and not on the local one is an ordinary thing to want — and it
 * costs nothing new, because `sort` and `dir` are already stored exactly here.
 *
 * Arithmetic only, and every import is `import type`, for the reason
 * `views.ts` and `press.ts` give: the verify scripts run under node, which
 * strips types but cannot evaluate JSX, and a rule that lives in a component
 * is a rule no script can check.
 *
 * What is stored is the set that is *off*, not the set that is on. Every
 * column showing is the default and is therefore the empty string, which keeps
 * both keys out of the query string entirely on the overwhelming majority of
 * URLs — the same shape `duRoot: null` uses for "nothing pinned".
 */

// ------------------------------------------------------------- the vocabulary

/**
 * The columns somebody can turn off, in the order the pane draws them.
 *
 * The mark and the name are structural and never go: a listing with no names
 * is not a narrower listing, it is a different thing. TRE-38's cell is not
 * here either — it is reserved rather than filled, and a column nothing has
 * ever drawn into is not one anybody can mean.
 */
export const HIDEABLE = ["share", "size", "mode", "owner", "age"] as const;

export type Column = (typeof HIDEABLE)[number];

export function isColumn(value: string): value is Column {
  return (HIDEABLE as readonly string[]).includes(value);
}

// -------------------------------------------------------------- the geometry

/**
 * The px 2a drew each column at, in the rem the listing actually uses so the
 * whole thing follows `--ui-base` (TRE-44). The px is in the comment, as it
 * was when this was one static class string.
 */
const TRACK: Readonly<Record<Column, number>> = {
  // 26     62      30      88     38
  share: 1.625,
  size: 3.875,
  mode: 1.875,
  owner: 5.5,
  age: 2.375,
};

/** The mark, the name, and TRE-38's reserved cell — 14, 104 and 13. */
const FIXED = ["0.875rem", "minmax(6.5rem,1fr)", "0.8125rem"] as const;

/** `gap-1.25`, which is 5px, which is Tailwind's 4px unit and a quarter. */
const GAP = 0.3125;

/**
 * The floor the pane has had since it was drawn — `min-w-101`, 404px.
 *
 * Kept as the *full* figure and reduced from, rather than recomputed from the
 * visible tracks. The two are not the same number: the tracks and their gaps
 * come to more than this, so the floor was never their sum but a chosen one,
 * and deriving it afresh would change what a pane does today in a ticket about
 * what it does when a column is turned off.
 */
const FULL_MIN = 25.25;

/**
 * The grid, for the header, the rows and the skeleton.
 *
 * A style rather than a class because the set is now a runtime value and
 * Tailwind's scanner reads source text — a computed `grid-cols-[...]` is a
 * class that never reaches the stylesheet. What stays in the class list is
 * everything that does not vary: `gap-1.25 px-2.25`.
 *
 * The floor shrinks with the set, and it has to. A pane that frees no
 * horizontal room when a column is hidden has spent an interaction on nothing,
 * on exactly the narrow window where somebody would have reached for it.
 */
export function gridOf(hidden: ReadonlySet<Column>): { gridTemplateColumns: string; minWidth: string } {
  const shown = HIDEABLE.filter((column) => !hidden.has(column));
  const gone = HIDEABLE.filter((column) => hidden.has(column));

  return {
    gridTemplateColumns: [...FIXED, ...shown.map((column) => `${TRACK[column]}rem`)].join(" "),
    // Each column takes its own track and the gap that separated it.
    minWidth: `${FULL_MIN - gone.reduce((total, column) => total + TRACK[column] + GAP, 0)}rem`,
  };
}

/** The same floor, for the one row that is not built on the grid: `..` (TRE-77). */
export function minWidthOf(hidden: ReadonlySet<Column>): string {
  return gridOf(hidden).minWidth;
}

// ----------------------------------------------------------------- the string

/** Long enough for all five names and their commas, and no longer. */
export const MAX_HIDE = 64;

/**
 * What is turned off, read out of a query string or a stored layout.
 *
 * Unknown names are dropped rather than refused, which is this app's rule for
 * everything that arrives in a URL (`explorer-params.ts`): a value nobody can
 * parse becomes the default rather than a value nothing downstream expects.
 * Here the default is a column showing, which is the safe direction to fail —
 * an unreadable parameter costs you a column you did not want, never a column
 * you cannot find.
 */
export function parseHidden(value: string): ReadonlySet<Column> {
  return new Set(value.split(",").filter(isColumn));
}

/**
 * And back, in `HIDEABLE`'s order rather than the caller's.
 *
 * Canonical because the string is compared, not just read: the dirty dot and
 * the session restore both decide whether to write by comparing two serialised
 * layouts, and `age,size` meaning the same thing as `size,age` while spelling
 * it differently is how a layout stops comparing equal with itself.
 */
export function writeHidden(hidden: ReadonlySet<Column>): string {
  return HIDEABLE.filter((column) => hidden.has(column)).join(",");
}

/** One column turned on or off, as the string the layout stores. */
export function toggled(value: string, column: Column): string {
  const hidden = new Set(parseHidden(value));
  if (!hidden.delete(column)) hidden.add(column);
  return writeHidden(hidden);
}

// ------------------------------------------------------------------ the sort

/**
 * Whether hiding this set takes away the column this pane is sorted by.
 *
 * It has a consequence, and the consequence is decided rather than emergent:
 * the pane falls back to sorting by name. Hiding the sorted column takes its
 * header, and the header is the only thing on screen that says what the order
 * is — an invisible sort leaves a listing in a sequence nothing accounts for,
 * which reads as a rendering fault rather than a state. The fall back is
 * visible in the same frame: the rows reorder, and the arrow lands on NAME.
 *
 * It reaches one pane, which is the other half of why the set is per pane. The
 * same rule under one shared set would have a menu on pane B silently re-sort
 * pane A, and re-sorting a listing somebody is not looking at is the kind of
 * thing that gets noticed ten minutes later and blamed on the app.
 */
export function hidesSort(hidden: ReadonlySet<Column>, sort: SortKey): boolean {
  return sort !== "name" && hidden.has(sort);
}
