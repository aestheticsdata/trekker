/**
 * The cursor and the `..` row, checked by table (TRE-77).
 *
 * Making `..` a row the cursor can stand on puts one name into `cur` that is
 * not in the listing, and the two things that can go wrong with it are both
 * quiet. A `..` that reaches `sel` aims `rm`, chmod, the transfer and the
 * rename pattern at the parent directory. A window index computed from a
 * listing that does not contain `..` is off by one below the root and simply
 * -1 on `..` itself, which the virtualiser reads as "the cursor is nowhere" and
 * answers by not scrolling — a keyboard walking down a long directory that
 * stops following itself.
 *
 * Neither throws, so both are enumerated here rather than sampled: every
 * gesture that writes the cursor, at the root and below it, with the selection
 * checked after each one.
 *
 *   node scripts/verify-cursor.ts        (or: pnpm verify:cursor)
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it. Until then it follows the convention `verify-virtual.ts` set.
 */

import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The app's path aliases, taught to Node.
 *
 * The other verify scripts reach straight into `src/helpers/`, whose modules
 * import nothing but types and so need none of this. The reducer is not a
 * helper — it is the pane's, it lives beside the component it serves, and it
 * imports `@helpers/listing` for real — so running it outside Next means
 * answering the one specifier `tsconfig` answers for everything else.
 *
 * Deliberately dumb: `@x/y` is `src/x/y.ts` and nothing here resolves to a
 * `.tsx`, because a verify script that needed to load a component would be a
 * verify script asking the wrong question.
 */
const SRC = resolvePath(dirname(fileURLToPath(import.meta.url)), "../src");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("@")) return nextResolve(specifier, context);
    return { url: pathToFileURL(`${resolvePath(SRC, specifier.slice(1))}.ts`).href, shortCircuit: true };
  },
});

const { cursorWindowIndex, explorerReducer, initialState, PARENT_NAME } = await import(
  "../src/components/explorer/pane-state.ts"
);

import type { ExplorerAction, ExplorerState, PaneMemory } from "../src/components/explorer/pane-state.ts";

let failures = 0;
let checks = 0;

function check(what: string, got: unknown, want: unknown) {
  checks += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) return;
  failures += 1;
  if (failures <= 12) console.log(`FAIL ${what}\n     got  ${a}\n     want ${b}`);
}

/* ------------------------------------------------------------------ */
/* Where the cursor sits in the scroll window                          */
/* ------------------------------------------------------------------ */

/**
 * Every shape the three inputs can take, and not one sampled.
 *
 * `hasParent` is the pane's `upRow === 1`, `rowIndex` is what `findIndex`
 * answered over the listing, and `cur` is the name. The only interesting sums
 * are the two edges — `..` at the top of the window, and the first real row
 * pushed down by one when it is there.
 */
const WINDOW: Array<{ what: string; cur: string | null; rowIndex: number; hasParent: boolean; want: number }> = [
  { what: "no cursor, below the root", cur: null, rowIndex: -1, hasParent: true, want: -1 },
  { what: "no cursor, at the root", cur: null, rowIndex: -1, hasParent: false, want: -1 },
  // A null cursor cannot have produced a row index, but the guard must not
  // depend on that: -1 is the answer whatever the second argument says.
  { what: "no cursor, stale row index", cur: null, rowIndex: 4, hasParent: true, want: -1 },

  { what: "`..` below the root is row 0", cur: PARENT_NAME, rowIndex: -1, hasParent: true, want: 0 },
  { what: "`..` at the root is nowhere", cur: PARENT_NAME, rowIndex: -1, hasParent: false, want: -1 },

  { what: "first row below the root", cur: "a", rowIndex: 0, hasParent: true, want: 1 },
  { what: "first row at the root", cur: "a", rowIndex: 0, hasParent: false, want: 0 },
  { what: "seventh row below the root", cur: "g", rowIndex: 6, hasParent: true, want: 7 },
  { what: "seventh row at the root", cur: "g", rowIndex: 6, hasParent: false, want: 6 },

  // A cursor naming a row the glob has since hidden, or one renamed under it.
  { what: "cursor names no row, below the root", cur: "gone", rowIndex: -1, hasParent: true, want: -1 },
  { what: "cursor names no row, at the root", cur: "gone", rowIndex: -1, hasParent: false, want: -1 },
];

for (const row of WINDOW) {
  check(`window: ${row.what}`, cursorWindowIndex(row.cur, row.rowIndex, row.hasParent), row.want);
}

/* ------------------------------------------------------------------ */
/* What each gesture does to the cursor and the selection              */
/* ------------------------------------------------------------------ */

/** Three entries, as the pane would hand them over. */
const ROWS = ["a", "b", "c"] as const;
/** What the explorer passes below the root, and what it passes at it. */
const BELOW = [PARENT_NAME, ...ROWS];
const AT_ROOT = [...ROWS];

function paneWith(cur: string | null, sel: string[]): ExplorerState {
  const base = initialState("/var/log");
  const pane: PaneMemory = { ...base.panes[0], cur, sel };
  return { ...base, panes: [pane, base.panes[1]] };
}

/** The cursor and the selection after one action, which is all these decide. */
function after(before: ExplorerState, action: ExplorerAction): { cur: string | null; sel: string[] } {
  const next = explorerReducer(before, action);
  return { cur: next.panes[0].cur, sel: next.panes[0].sel };
}

const GESTURES: Array<{
  what: string;
  cur: string | null;
  sel: string[];
  action: ExplorerAction;
  want: { cur: string | null; sel: string[] };
}> = [
  /* --- arrow keys, below the root ------------------------------------ */
  {
    what: "↑ from the first row lands on `..`",
    cur: "a",
    sel: ["a"],
    action: { type: "move", pane: 0, delta: -1, names: BELOW },
    // The selection stays where it was: stepping over `..` on the way up must
    // not be a way to lose what is highlighted.
    want: { cur: PARENT_NAME, sel: ["a"] },
  },
  {
    what: "↑ from `..` stays on `..`",
    cur: PARENT_NAME,
    sel: ["a"],
    action: { type: "move", pane: 0, delta: -1, names: BELOW },
    want: { cur: PARENT_NAME, sel: ["a"] },
  },
  {
    what: "↓ from `..` takes the first row, and selects it",
    cur: PARENT_NAME,
    sel: [],
    action: { type: "move", pane: 0, delta: 1, names: BELOW },
    want: { cur: "a", sel: ["a"] },
  },
  {
    what: "↑ from `..` leaves a multi-selection whole",
    cur: PARENT_NAME,
    sel: ["a", "b", "c"],
    action: { type: "move", pane: 0, delta: -1, names: BELOW },
    want: { cur: PARENT_NAME, sel: ["a", "b", "c"] },
  },
  {
    what: "↓ from the last row stays on it",
    cur: "c",
    sel: ["c"],
    action: { type: "move", pane: 0, delta: 1, names: BELOW },
    want: { cur: "c", sel: ["c"] },
  },
  {
    what: "↓ with no cursor and nothing but `..` to stand on",
    cur: null,
    sel: [],
    action: { type: "move", pane: 0, delta: 1, names: [PARENT_NAME] },
    want: { cur: PARENT_NAME, sel: [] },
  },

  /* --- arrow keys, at the root --------------------------------------- */
  {
    what: "↑ from the first row at the root stays on it",
    cur: "a",
    sel: ["a"],
    action: { type: "move", pane: 0, delta: -1, names: AT_ROOT },
    want: { cur: "a", sel: ["a"] },
  },
  {
    what: "↓ at the root selects as it always did",
    cur: "a",
    sel: ["a"],
    action: { type: "move", pane: 0, delta: 1, names: AT_ROOT },
    want: { cur: "b", sel: ["b"] },
  },

  /* --- a plain click -------------------------------------------------- */
  {
    what: "clicking `..` moves the cursor and leaves the selection",
    cur: "b",
    sel: ["b"],
    action: { type: "click", pane: 0, name: PARENT_NAME, names: BELOW, extend: false, toggle: false },
    want: { cur: PARENT_NAME, sel: ["b"] },
  },
  {
    what: "clicking `..` leaves a fifty-entry selection alone",
    cur: "a",
    sel: ["a", "b", "c"],
    action: { type: "click", pane: 0, name: PARENT_NAME, names: BELOW, extend: false, toggle: false },
    want: { cur: PARENT_NAME, sel: ["a", "b", "c"] },
  },
  {
    what: "clicking a row still replaces the selection",
    cur: PARENT_NAME,
    sel: ["a", "b"],
    action: { type: "click", pane: 0, name: "c", names: BELOW, extend: false, toggle: false },
    want: { cur: "c", sel: ["c"] },
  },

  /* --- ⌘-click -------------------------------------------------------- */
  {
    what: "⌘-clicking `..` adds nothing",
    cur: "a",
    sel: ["a"],
    action: { type: "click", pane: 0, name: PARENT_NAME, names: BELOW, extend: false, toggle: true },
    want: { cur: PARENT_NAME, sel: ["a"] },
  },
  {
    what: "⌘-clicking `..` with nothing selected still selects nothing",
    cur: null,
    sel: [],
    action: { type: "click", pane: 0, name: PARENT_NAME, names: BELOW, extend: false, toggle: true },
    want: { cur: PARENT_NAME, sel: [] },
  },
  {
    what: "⌘-clicking a row still adds it",
    cur: "a",
    sel: ["a"],
    action: { type: "click", pane: 0, name: "c", names: BELOW, extend: false, toggle: true },
    want: { cur: "c", sel: ["a", "c"] },
  },

  /* --- ⇧-click -------------------------------------------------------- */
  {
    what: "⇧-clicking `..` moves the cursor and leaves the range alone",
    cur: "c",
    sel: ["c"],
    action: { type: "click", pane: 0, name: PARENT_NAME, names: BELOW, extend: true, toggle: false },
    want: { cur: PARENT_NAME, sel: ["c"] },
  },
  {
    what: "⇧-clicking down from `..` selects the rows and not `..`",
    cur: PARENT_NAME,
    sel: [],
    action: { type: "click", pane: 0, name: "b", names: BELOW, extend: true, toggle: false },
    want: { cur: "b", sel: ["a", "b"] },
  },
  {
    what: "⇧-clicking the whole listing from `..`",
    cur: PARENT_NAME,
    sel: [],
    action: { type: "click", pane: 0, name: "c", names: BELOW, extend: true, toggle: false },
    want: { cur: "c", sel: ["a", "b", "c"] },
  },
  {
    what: "⇧-clicking between two rows is untouched",
    cur: "a",
    sel: ["a"],
    action: { type: "click", pane: 0, name: "c", names: BELOW, extend: true, toggle: false },
    want: { cur: "c", sel: ["a", "b", "c"] },
  },

  /* --- everything else that writes the cursor -------------------------- */
  {
    what: "⌘A takes the rows and never `..`",
    cur: PARENT_NAME,
    sel: [],
    // The explorer hands `selectAll` the listing alone, which is the point:
    // same-looking expression, different set.
    action: { type: "selectAll", pane: 0, names: AT_ROOT },
    want: { cur: PARENT_NAME, sel: ["a", "b", "c"] },
  },
  {
    what: "a rename or a delete clears both",
    cur: PARENT_NAME,
    sel: ["a"],
    action: { type: "selectNone", pane: 0 },
    want: { cur: null, sel: [] },
  },
  {
    what: "navigating clears both",
    cur: PARENT_NAME,
    sel: ["a"],
    action: { type: "navigate", pane: 0, path: "/var" },
    want: { cur: null, sel: [] },
  },
  {
    what: "a created entry is revealed",
    cur: PARENT_NAME,
    sel: [],
    action: { type: "reveal", pane: 0, name: "new-dir" },
    want: { cur: "new-dir", sel: ["new-dir"] },
  },
];

for (const gesture of GESTURES) {
  const got = after(paneWith(gesture.cur, gesture.sel), gesture.action);
  check(`gesture: ${gesture.what}`, got, gesture.want);
  // The one rule this whole ticket rests on, asserted after every gesture
  // rather than only where it is expected to bite.
  check(`gesture: ${gesture.what} — \`..\` stayed out of the selection`, got.sel.includes(PARENT_NAME), false);
}

/* ------------------------------------------------------------------ */
/* The other pane never moves                                          */
/* ------------------------------------------------------------------ */

const twoPanes = explorerReducer(paneWith("a", ["a"]), {
  type: "click",
  pane: 0,
  name: PARENT_NAME,
  names: BELOW,
  extend: false,
  toggle: false,
});
check("the other pane is untouched", twoPanes.panes[1], initialState("/var/log").panes[1]);

/* ------------------------------------------------------------------ */
/* A walk, because a single step can be right and a sequence wrong     */
/* ------------------------------------------------------------------ */

/**
 * Down to the last row, up past the first onto `..`, and down again.
 *
 * Each step is checked above on its own; what this adds is that the cursor
 * comes back to where it started, which is what "one more row" has to mean if
 * the keyboard is to be usable at all.
 */
let walk = paneWith(null, []);
const seen: Array<string | null> = [];
for (const delta of [1, 1, 1, 1, 1, -1, -1, -1, -1, -1, 1]) {
  walk = explorerReducer(walk, { type: "move", pane: 0, delta, names: BELOW });
  seen.push(walk.panes[0].cur);
}
check(
  "a walk down and back up visits every row once",
  seen,
  // From nothing the first press lands on row 0, which below the root is `..`.
  [PARENT_NAME, "a", "b", "c", "c", "b", "a", PARENT_NAME, PARENT_NAME, PARENT_NAME, "a"],
);

console.log(failures === 0 ? `cursor: ${checks} checks passed` : `cursor: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
