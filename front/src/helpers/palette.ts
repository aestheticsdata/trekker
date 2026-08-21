import type { ActionId } from "@components/shell/actions";

/**
 * The palette's arithmetic (TRE-36 §2, §3).
 *
 * Everything here is a pure function of a typed string, which is the half of a
 * command palette that can be wrong without looking wrong: a ranking that
 * quietly drops the entry somebody is typing towards reads as "the app does not
 * have that", and nobody files a bug about a feature they concluded does not
 * exist. So it is tabled by `pnpm verify:palette` rather than tried by hand.
 *
 * Here rather than in the component for the reason `menu.ts`, `terminal.ts` and
 * `press.ts` all give: node runs a `.ts` script directly, and it can strip types
 * but not JSX. The class names live here for the same reason — they are pairs
 * of colours, and `pnpm verify:contrast` measures pairs it can import.
 *
 * Imports nothing but a type.
 */

// ------------------------------------------------------------- what a row is

/**
 * The groups, in the order the mockup stacks them.
 *
 * Places first, because reaching a directory is what the palette is opened for
 * nine times in ten; machines last, because rebinding a pane is rare and
 * deliberate. `rank` never reorders these — it reorders entries, and the
 * headers follow wherever they land.
 */
export const GROUPS = ["GO TO", "ACTIONS", "VIEW", "SHELL", "VIEWS", "SERVERS"] as const;

export type PaletteGroup = (typeof GROUPS)[number];

/** As much of an entry as ranking needs, so a test can make one out of nothing. */
export interface Candidate {
  group: string;
  label: string;
  /** The small second line. Matched too, which is most of what makes it useful. */
  detail: string;
}

// ------------------------------------------------------------------ matching

/**
 * How the fields are weighted against each other.
 *
 * The shape matters more than the numbers: a hit anywhere in the label beats a
 * hit anywhere in the description, and both beat a loose one. That is what
 * makes typing `ren` put `rename` above the four entries whose *description*
 * happens to contain "current".
 *
 * `word` is the interesting one. `pane` matching "copy to other **pane**" is a
 * different quality of hit from `ane` matching the middle of the same word, and
 * without the distinction the two rank identically — which is how a palette
 * ends up feeling like it is guessing.
 *
 * There is deliberately no loose grade for the description. A description is a
 * sentence, and four characters are a subsequence of almost any sentence: with
 * one, typing `pane` returned `rename` — whose description happens to contain a
 * p, an a, an n and an e in that order — and an entry that survives every
 * keystroke is an entry the query can never get rid of.
 */
const WEIGHT = {
  start: 100,
  word: 80,
  label: 60,
  labelLoose: 30,
  detail: 20,
  group: 12,
} as const;

/** What counts as the beginning of a word, for `WEIGHT.word`. */
const BOUNDARY = new Set([" ", "/", "-", "_", ".", ":", "@"]);

/**
 * Whether the needle appears in order, but not necessarily together.
 *
 * `rnm` finds "rename" this way. Against the label only, and it ranks below
 * every literal hit rather than competing with one: at three characters almost
 * everything is a subsequence of almost everything.
 */
function loosely(needle: string, hay: string): boolean {
  let at = 0;
  for (const character of hay) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

/** The best this one token can do against one entry, or 0 for nowhere at all. */
function tokenScore(token: string, label: string, detail: string, group: string): number {
  const at = label.indexOf(token);
  if (at === 0) return WEIGHT.start;
  if (at > 0) return BOUNDARY.has(label[at - 1]) ? WEIGHT.word : WEIGHT.label;
  if (loosely(token, label)) return WEIGHT.labelLoose;
  if (detail.includes(token)) return WEIGHT.detail;
  if (group.includes(token)) return WEIGHT.group;
  return 0;
}

/**
 * What this entry is worth for this query, or null when it is not a match.
 *
 * The query is split on whitespace and **every** token has to land somewhere.
 * That is what "out of order" means here: `pane copy` and `copy pane` both find
 * "copy to other pane", because neither is asked to appear as written. One
 * token missing rejects the entry outright rather than scoring it low — a
 * palette that keeps showing an entry as you type more of what you do not want
 * is a palette that never narrows.
 */
export function score(query: string, candidate: Candidate): number | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;

  const label = candidate.label.toLowerCase();
  const detail = candidate.detail.toLowerCase();
  const group = candidate.group.toLowerCase();

  let total = 0;
  for (const token of tokens) {
    const got = tokenScore(token, label, detail, group);
    if (got === 0) return null;
    total += got;
  }
  return total;
}

/**
 * The entries this query leaves, best first.
 *
 * An empty query returns the list untouched — the palette opened with nothing
 * typed is a menu of everything the app does, in the order somebody arranged,
 * and sorting that by anything would be sorting a table of contents.
 *
 * Ties keep their original position, which is why the sort is on a decorated
 * copy rather than on `Array.prototype.sort` alone: the sort is specified as
 * stable, the *inputs* are not — two entries scoring 100 should come out in the
 * order the app declared them, not in whichever order the comparison happened
 * to see them.
 */
export function rank<T extends Candidate>(items: readonly T[], query: string): readonly T[] {
  if (query.trim().length === 0) return items;

  const kept: Array<{ item: T; score: number; at: number }> = [];
  items.forEach((item, at) => {
    const got = score(query, item);
    if (got !== null) kept.push({ item, score: got, at });
  });

  kept.sort((a, b) => (b.score === a.score ? a.at - b.at : b.score - a.score));
  return kept.map((entry) => entry.item);
}

/**
 * Where the group headers go: on the first row of each **run**, not each group.
 *
 * With nothing typed the two are the same thing. With a query they are not —
 * ranking interleaves the groups, and a header drawn once per group would
 * label the wrong rows from its second appearance onward. So it is drawn
 * wherever the group changes, and the same word can appear twice in one list.
 * That reads correctly: each header is telling the truth about the rows under
 * it, which is the only job it has.
 */
export function withHeads<T extends Candidate>(items: readonly T[]): ReadonlyArray<{ item: T; head: string | null }> {
  let last: string | null = null;
  return items.map((item) => {
    const head = item.group === last ? null : item.group;
    last = item.group;
    return { item, head };
  });
}

// ------------------------------------------------------------- typing a path

/**
 * A typed absolute path, split into the directory to list and what has been
 * typed of the next segment (TRE-36 §3).
 *
 * `null` for anything that is not one. The test is a leading `/` and nothing
 * else: this is a Unix file manager, an absolute path is unambiguous, and the
 * moment a heuristic is involved it becomes a mode somebody can fall into by
 * accident.
 */
export interface PathQuery {
  /** The directory whose listing supplies the completions. */
  dir: string;
  /** What has been typed of the entry inside it. Empty after a trailing `/`. */
  leaf: string;
  /** Where ↩ goes, which is the whole thing with a trailing slash trimmed. */
  target: string;
}

export function pathQuery(input: string): PathQuery | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const cut = trimmed.lastIndexOf("/");
  return {
    dir: cut === 0 ? "/" : trimmed.slice(0, cut),
    leaf: trimmed.slice(cut + 1),
    // `/srv/` and `/srv` are the same directory, and the pane writes it the
    // second way — so the entry says what the pane will show, not what was typed.
    target: trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed,
  };
}

/** `/srv` + `backups` → `/srv/backups`, without the doubled slash at the root. */
export function joinInto(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/**
 * What `⇥` completes to: the names that carry on what has been typed.
 *
 * Case-insensitive, because the alternative is a completion that fails on
 * `/Users` and gives no reason. Order is the listing's own — already sorted by
 * whatever the pane is sorted by, which is the order the eye expects.
 */
export function completions(leaf: string, names: readonly string[], limit: number): readonly string[] {
  const wanted = leaf.toLowerCase();
  const kept: string[] = [];
  for (const name of names) {
    if (!name.toLowerCase().startsWith(wanted)) continue;
    kept.push(name);
    if (kept.length === limit) break;
  }
  return kept;
}

/**
 * The longest head every candidate shares, which is what `⇥` fills in.
 *
 * A shell completes to the common prefix rather than to the first match, and
 * the difference shows the moment there are two: `/var/lo` with `log` and
 * `logrotate` under it should become `/var/log`, and jumping to whichever one
 * sorted first would put the caret somewhere nobody asked to be. Compared
 * case-insensitively but returned from the first candidate, so the completion
 * carries the directory's own capitalisation.
 */
export function commonPrefix(names: readonly string[]): string {
  if (names.length === 0) return "";
  let end = names[0].length;
  for (const name of names.slice(1)) {
    end = Math.min(end, name.length);
    let at = 0;
    while (at < end && name[at].toLowerCase() === names[0][at].toLowerCase()) at += 1;
    end = at;
  }
  return names[0].slice(0, end);
}

// -------------------------------------------------------------------- glyphs

/**
 * The 16px icon column.
 *
 * Decoration, and it says so: the label carries the meaning and this is what
 * lets the eye skip four rows at a time. Repeats are deliberate and are the
 * mockup's own idiom — 2a draws the same `→` beside all five of its GO TO rows,
 * because what those rows have in common is the point.
 *
 * Exhaustive over `ActionId` rather than partial, so an operation added to the
 * registry without a mark is a type error here rather than a blank column
 * nobody notices.
 */
export const ACTION_GLYPH: Readonly<Record<ActionId, string>> = {
  newDir: "+",
  newFile: "+",
  open: "→",
  openOther: "→",
  cut: "↧",
  copy: "▤",
  paste: "↥",
  duplicate: "▤",
  copyTo: "↦",
  moveTo: "↦",
  refresh: "↻",
  rename: "aA",
  chmod: "□",
  download: "↓",
  upload: "↑",
  tail: "≡",
  link: "§",
  copyPath: "▤",
  copyName: "▤",
  favourite: "★",
  compare: "⇄",
  hash: "#",
  rm: "⌦",
};

/** The groups that are not the action registry, drawn the way 2a draws them. */
export const GLYPH = {
  goTo: "→",
  inspector: "◧",
  split: "▤",
  heat: "▦",
  shell: "$",
  view: "▤",
  saveView: "+",
  server: "⌁",
} as const;

// -------------------------------------------------------------------- colour
//
// The panel is 2a's, on the sunk `--color-strip` ground it shares with the
// disk-usage bar. Two of its inks are not 2a's, and the reason is the one
// TRE-33, TRE-34 and TRE-35 each recorded before it: the hue is the mockup's,
// the ground is the mockup's, and the ink is lifted until it clears AA.
//
// What failed here: 2a writes the group headers and the `›` in `#3e8fae`
// (`accent-soft`), which is 4.34:1 on this ground, and every quiet line —
// the match count, the footer, the second line of a row — in `#4d7f99`
// (`ink-faint`), which is 3.64:1. Both are under 4.5, and the second one is
// under it for the line that says what an entry actually does.
//
// The row's second line is the awkward one, because it has two grounds: the
// panel under an ordinary row, and `--color-line` under the selected one. On
// that fill nothing between `ink-faint` and `ink-dim` clears at all — the whole
// span from 2.61 to 4.82 is a wall — so the second line switches ink with the
// row, exactly as the mockup already switches the icon and the label.

export const PALETTE_SURFACE = "bg-strip";
export const PALETTE_EDGE = "border-accent";
/** The header, the footer and the rule under the input. */
export const PALETTE_RULE = "border-line";

/** The `›` and the group headers — 2a's `#3e8fae`, lifted to clear. */
export const PALETTE_LABEL_INK = "text-on-strip-label";
/** The count, the footer, the empty state — 2a's `#4d7f99`, lifted to clear. */
export const PALETTE_QUIET_INK = "text-on-strip-dim";
export const PALETTE_INPUT_INK = "text-ink";

/** The row under the keyboard, which is also the row under the pointer. */
export const ROW_FILL = "bg-line";
export const ROW_EDGE = "border-accent";

export const ICON_INK = "text-on-strip-dim";
export const ICON_ON_INK = "text-brand";
export const ROW_LABEL_INK = "text-ink-soft";
export const ROW_LABEL_ON_INK = "text-ink";
export const ROW_DETAIL_INK = "text-on-strip-dim";
/** On the selected row's fill, where the quiet step does not survive. */
export const ROW_DETAIL_ON_INK = "text-ink-dim";
/** An entry that cannot run now: legible, obviously quieter, reason attached. */
export const ROW_OFF_INK = "text-ink-dim";
export const KEY_INK = "text-ink-dim";
export const KEY_EDGE = "border-line-strong";
/** `rm` stays red in a list somebody is arrowing down, as it does everywhere. */
export const ROW_DANGER_INK = "text-danger-soft";
/** The one bright line in the empty state: what ↩ will do instead. */
export const FALLBACK_INK = "text-ink-dim";
