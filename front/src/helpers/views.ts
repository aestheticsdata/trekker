import type { ViewSlot } from "@helpers/keys";
import type { StoredLayout, ViewLayout, ViewPane } from "@schemas/layout";

/**
 * What a saved view is, arithmetic only (TRE-37).
 *
 * Here rather than in the components for the reason `palette.ts`, `press.ts`
 * and `terminal.ts` all give: `scripts/verify-views.ts` and
 * `scripts/verify-contrast.ts` run under node, which strips types but cannot
 * evaluate JSX — and a check with its own copy of the rules is a check of the
 * copy. Every import here is `import type`, which node erases entirely, so
 * nothing in this file drags zod, nuqs or React behind it.
 *
 * The load-bearing function is `serialise`. The dirty dot is a string
 * comparison of two layouts, and two layouts that mean the same thing have to
 * produce the same string whichever way they were built — one comes out of the
 * API, the other is assembled from the URL, and `JSON.stringify` keeps
 * insertion order. This is the same trap `serialiseLayout` was written for one
 * ticket over, and the same answer.
 */

// ------------------------------------------------------------------ the shape

/** Which pane a per-pane fact is about, in the letters the app already uses. */
export type PaneKey = "a" | "b";

export const PANE_KEYS: readonly PaneKey[] = ["a", "b"];

/**
 * One layout, one string, whatever order the keys arrived in.
 *
 * Every field is named explicitly rather than spread, and that is the point: a
 * field added to `ViewLayout` and forgotten here would be a field the dot
 * stops noticing, which is a saved view that quietly stops being dirty when it
 * is. TypeScript catches the reverse — a field removed — and `verify:views`
 * catches this one by asserting the key list.
 */
export function serialise(layout: ViewLayout): string {
  const pane = ({ host, path, sort, dir }: ViewPane) => ({ host, path, sort, dir });
  const { split, insp, heat, glob } = layout;
  return JSON.stringify({ a: pane(layout.a), b: pane(layout.b), split, insp, heat, glob });
}

/**
 * The fields a view remembers, taken off what is on screen.
 *
 * The one narrowing in the app: everything a view stores comes through here, so
 * "which fields does a view compare" is answered once rather than at the save,
 * the update and the dot separately.
 */
export function layoutOf(current: StoredLayout): ViewLayout {
  return {
    a: { host: current.a.host, path: current.a.path, sort: current.a.sort, dir: current.a.dir },
    b: { host: current.b.host, path: current.b.path, sort: current.b.sort, dir: current.b.dir },
    split: current.split,
    insp: current.insp,
    heat: current.heat,
    glob: current.glob,
  };
}

/** Whether what is on screen has moved away from what was saved. */
export function isDirty(saved: ViewLayout, current: ViewLayout): boolean {
  return serialise(saved) !== serialise(current);
}

// ------------------------------------------------------- what gets stored

/**
 * The defaults a field falls back to when the form says not to save it.
 *
 * These are the URL's own defaults (`lib/url/explorer-params.ts`), and they
 * have to be: a view that stores `sort: "name"` because the box was unticked
 * must restore a pane to exactly what an untouched pane looks like. Any other
 * value would make "do not save the sort order" mean "save this other sort
 * order instead", which is worse than either.
 */
export const NEUTRAL = {
  sort: "name",
  dir: 1,
  glob: "",
  split: "split",
  insp: true,
  heat: true,
} as const satisfies Partial<ViewLayout> & Pick<ViewPane, "sort" | "dir">;

/** What the save form's two checkboxes are. */
export interface Keeps {
  /** The sort of each pane, and the glob — the things that decide what a pane *shows*. */
  sorts: boolean;
  /** The split, the inspector and the heat map — the things that decide how it *looks*. */
  layout: boolean;
}

/**
 * The two checkboxes, applied.
 *
 * Unticking a box neutralises the field rather than omitting it, so a stored
 * layout is always complete. The alternative — a partial layout, restored by
 * leaving whatever was on screen alone — sounds tidier and is not: a view
 * called `log triage` would then restore differently depending on what the last
 * view left behind, which is the one thing a *saved* view must never do.
 */
export function narrow(layout: ViewLayout, keeps: Keeps): ViewLayout {
  const pane = (side: ViewPane): ViewPane => (keeps.sorts ? side : { ...side, sort: NEUTRAL.sort, dir: NEUTRAL.dir });

  return {
    a: pane(layout.a),
    b: pane(layout.b),
    glob: keeps.sorts ? layout.glob : NEUTRAL.glob,
    split: keeps.layout ? layout.split : NEUTRAL.split,
    insp: keeps.layout ? layout.insp : NEUTRAL.insp,
    heat: keeps.layout ? layout.heat : NEUTRAL.heat,
  };
}

// ------------------------------------------------------------ the shortcut

/**
 * The lowest chord nobody is holding, or null when all nine are taken.
 *
 * Suggested, never imposed: the picker opens on it and every other slot is one
 * click away, and choosing a taken one moves it rather than refusing (TRE-37
 * §1). Null is an honest answer — nine views with chords is nine, and the tenth
 * is saved without one rather than stealing.
 */
export function freeSlot(taken: ReadonlyArray<ViewSlot | null>, slots: readonly ViewSlot[]): ViewSlot | null {
  const held = new Set(taken.filter((slot): slot is ViewSlot => slot !== null));
  return slots.find((slot) => !held.has(slot)) ?? null;
}

// -------------------------------------------------------------- describing

/** The last segment of a path, or `/` for the root — what a person calls a directory. */
export function leafOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : segments[segments.length - 1];
}

/** How a host reads when it is named: its label, or a stand-in when it is gone. */
export type LabelOf = (hostId: string | null) => string | null;

/**
 * The name the save form opens with — 2a's own rule.
 *
 * Two panes on one machine are that machine and two directories; two panes on
 * two machines are the trip between them. Both are the sentence somebody would
 * have typed, which is the whole job of a suggestion: it should be right often
 * enough that accepting it is not a decision.
 */
export function suggestName(layout: ViewLayout, labelOf: LabelOf): string {
  const left = labelOf(layout.a.host);
  const right = labelOf(layout.b.host);
  if (left === null && right === null) return leafOf(layout.a.path);
  if (left !== null && left === right) return `${left} · ${leafOf(layout.a.path)} ↔ ${leafOf(layout.b.path)}`;
  return `${left ?? "—"} → ${right ?? "—"}`;
}

/** The quiet line under a view's name in the sidebar: the two machines. */
export function describeHosts(layout: ViewLayout, labelOf: LabelOf): string {
  return PANE_KEYS.map((key) => labelOf(layout[key].host) ?? "—").join(" ↔ ");
}

/** The palette's second line: both machines and both directories. */
export function describePanes(layout: ViewLayout, labelOf: LabelOf): string {
  return PANE_KEYS.map((key) => `${labelOf(layout[key].host) ?? "—"}:${layout[key].path}`).join("  ↔  ");
}

/** One pane, as the save form previews it: where it is, and how it is sorted. */
export function describePane(pane: ViewPane, labelOf: LabelOf): { where: string; sorted: string } {
  return {
    where: `${labelOf(pane.host) ?? "no host"}:${pane.path}`,
    sorted: `sorted by ${pane.sort} ${pane.dir > 0 ? "▲" : "▼"}`,
  };
}

/** And the arrangement, as the same form previews it. */
export function describeLayout(layout: ViewLayout): { how: string; filter: string } {
  const split = layout.split === "split" ? "both panes" : layout.split === "left" ? "pane A alone" : "pane B alone";
  return {
    how: `${split} · inspector ${layout.insp ? "on" : "off"} · heat ${layout.heat ? "on" : "off"}`,
    filter: layout.glob.trim() === "" ? "no filter" : `glob filter ${layout.glob}`,
  };
}

// ----------------------------------------------------------- what is broken

/** A pane a view cannot honour, and the machine it wanted. */
export interface BrokenPane {
  pane: PaneKey;
  /** The label the host had when the view was saved, or null if none was kept. */
  was: string | null;
}

/**
 * Which panes this view cannot restore, because the host they name is gone.
 *
 * Reported rather than degraded, which is the difference between a saved view
 * and the session restore one ticket over. A cold open nobody asked for should
 * quietly fall back; pressing `⌥3` is a request for a specific arrangement, and
 * silently landing on `/` — or worse, on whatever host happened to be there —
 * is the app answering a different question and not saying so.
 */
export function brokenPanes(
  layout: ViewLayout,
  hostLabels: Readonly<Record<string, string>>,
  knownHostIds: readonly string[],
): readonly BrokenPane[] {
  return PANE_KEYS.flatMap((pane) => {
    const host = layout[pane].host;
    if (host === null || knownHostIds.includes(host)) return [];
    return [{ pane, was: hostLabels[host] ?? null }];
  });
}

/** The view with its broken panes pointed somewhere the account actually has. */
export function rebind(layout: ViewLayout, to: Readonly<Partial<Record<PaneKey, string | null>>>): ViewLayout {
  const next = { ...layout };
  for (const pane of PANE_KEYS) {
    if (!(pane in to)) continue;
    const host = to[pane] ?? null;
    // The path goes with the host. A path only means something against the
    // machine it was read from, and carrying `/var/log/nginx` onto a different
    // box is how a view lands on an empty directory and looks broken instead of
    // rebound.
    next[pane] = { ...next[pane], host, path: host === null ? "/" : next[pane].path };
  }
  return next;
}

// ------------------------------------------------------------------- colour
//
// The inks, named here so `verify:contrast` can measure them — the same reason
// `palette.ts` and `press.ts` carry theirs. Everything below is on one of two
// grounds: `chrome` in the top bar and the sidebar, and `raised` or `line`
// where a row or a chip is the current one.
//
// 2a draws every quiet line in this feature in `#4d7f99` — the shortcut beside
// a name, the `⌥1–9` in the section header, the small caps in the save form.
// That is this app's `--color-ink-faint`, and it clears AA on nothing here:
// 3.82:1 on `chrome`, 2.92:1 on `raised`, 2.61:1 on `line`. For the record, and
// measured in `verify:contrast`. One step up the same ladder — `ink-dim`, which
// is 2a's own `#6fb2c9` — clears all three at 7.06, 5.39 and 4.82.

/** The chip in the top bar, at rest and under the pointer. */
export const CHIP_INK = "text-ink-muted";
export const CHIP_HOVER_FILL = "bg-raised";
/** And the chord beside its name: quieter than the name, and still legible. */
export const CHIP_KEY_INK = "text-ink-dim";

/**
 * The chip for the view that is currently restored.
 *
 * 2a fills it with `#1f7cab` and writes the name in `#04202f`, which is 3.62:1
 * — the pair TRE-78 removed from fourteen other places for being under AA. The
 * app's own answer for "this row is the current one" is TRE-36's selected
 * palette row: the `line` fill with an accent edge. That is used here, and it
 * settles the dirty dot at the same time — 2a draws the amber unsaved marker
 * *inside* that chip, where it measures **1.59:1**, so the mockup's own two
 * decisions cannot both be drawn. On `line` the dot is 3.90:1, which is what
 * 1.4.11 asks of something that is not text.
 */
export const CHIP_ON_FILL = "bg-line";
export const CHIP_ON_EDGE = "border-accent";
export const CHIP_ON_INK = "text-ink";
export const CHIP_ON_KEY_INK = "text-ink-dim";

/** One view in the sidebar, quiet and current. */
export const ROW_INK = "text-ink-soft";
export const ROW_ON_FILL = "bg-raised";
export const ROW_ON_INK = "text-ink";
export const ROW_KEY_INK = "text-ink-dim";

/**
 * The unsaved marker, which is not text and is therefore held to 1.4.11's 3:1
 * against what is beside it rather than to 4.5:1. Measured on all three grounds
 * it can land on: 5.71 on `chrome`, 4.36 on `raised`, 3.90 on `line`.
 */
export const DIRTY_DOT = "bg-warning";

/** The save form: 2a's small caps above each field, and its panel. */
export const FORM_SURFACE = "bg-app";
export const FORM_LABEL_INK = "text-ink-dim";
export const FORM_VALUE_INK = "text-ink";
export const FORM_QUIET_INK = "text-ink-dim";

/** The mockup's own two, kept for the record rather than shipped. */
export const MOCKUP_QUIET_HEX = "#4d7f99";
export const MOCKUP_CHIP_FILL_HEX = "#1f7cab";
export const MOCKUP_CHIP_INK_HEX = "#04202f";
