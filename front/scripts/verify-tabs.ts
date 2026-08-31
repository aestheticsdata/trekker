/**
 * The tab strip's arithmetic, checked by table (TRE-130, TRE-131).
 *
 * Closing a tab is index arithmetic over an array that is also being read for a
 * path, and every way it can be wrong is quiet. Close the handle to the left of
 * the open one and the open tab is now a different directory than the pane is
 * showing. Close the right-hand end and `Math.min` is the only thing standing
 * between the pane and an index past the end of its own strip. Neither throws;
 * both leave a pane whose label and whose listing disagree, which is the defect
 * TRE-131 was reported as in the first place.
 *
 * The invariant this file exists for is the last group below. The URL owns the
 * path and the reducer owns the strip, so `closeTabTarget` has to answer, from
 * the state *before* the dispatch, exactly the path the reducer is about to
 * land on — the caller writes one and dispatches the other, and nothing at
 * runtime ever compares them. Swept over every shape rather than sampled.
 *
 *   node scripts/verify-tabs.ts        (or: pnpm verify:tabs)
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it. Until then it follows the convention `verify-cursor.ts` set.
 */

import { registerAliases } from "./aliases.ts";

// `pane-state.ts` imports `@helpers/listing` for real, so the alias hook has to
// be installed before the module is evaluated; see `aliases.ts` on why this
// import is dynamic and the one above it is not.
registerAliases();

const {
  canCloseTabs,
  closeOtherTabsTarget,
  closeTabTarget,
  explorerReducer,
  initialState,
  PARENT_NAME,
} = await import("../src/components/explorer/pane-state.ts");

import type { ExplorerState, PaneMemory, PaneView } from "../src/components/explorer/pane-state.ts";

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
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Distinct paths, one per handle, so a wrong index is a wrong *string* rather
 * than a coincidence. Two tabs on one directory is an ordinary thing to have
 * and is exactly the shape that would let an off-by-one pass.
 */
const PATHS = ["/one", "/two", "/three", "/four"];

/** A pane on `tabs`, standing on `tab`, with something selected on it. */
function paneWith(tabs: string[], tab: number): ExplorerState {
  const base = initialState("/");
  const pane: PaneMemory = { tabs: [...tabs], tab, hist: [], fwd: [], sel: ["kept"], cur: "kept" };
  return { ...base, panes: [pane, base.panes[1]] };
}

/** What the pure pair is asked, which is a `PaneView` — memory plus the URL. */
function viewOf(state: ExplorerState): PaneView {
  const pane = state.panes[0];
  return { ...pane, hostId: null, path: pane.tabs[pane.tab] ?? "/", sort: "name", dir: 1, hide: "" };
}

/** Every strip worth trying, with every handle it could be standing on. */
const SHAPES: Array<{ tabs: string[]; tab: number }> = [];
for (let length = 1; length <= PATHS.length; length += 1) {
  for (let tab = 0; tab < length; tab += 1) SHAPES.push({ tabs: PATHS.slice(0, length), tab });
}

/* ------------------------------------------------------------------ */
/* The rule the whole feature rests on: a pane keeps a tab             */
/* ------------------------------------------------------------------ */

check("one tab cannot be closed", canCloseTabs(viewOf(paneWith(["/one"], 0))), false);
check("two tabs can", canCloseTabs(viewOf(paneWith(["/one", "/two"], 0))), true);

const lone = paneWith(["/one"], 0);
check("closing the only tab is a no-op", explorerReducer(lone, { type: "closeTab", pane: 0, tab: 0 }), lone);
check(
  "closing the others when there are none is a no-op",
  explorerReducer(lone, { type: "closeOtherTabs", pane: 0, tab: 0 }),
  lone,
);
check("the only tab's × has nothing to write", closeTabTarget(viewOf(lone), 0), null);

// Out of range from every direction. A menu opened on a handle and left
// standing while the strip changed underneath it is the realistic way this
// arrives, and `tabs[-1]` is `undefined`, which is a path nothing downstream
// expects.
for (const shape of SHAPES) {
  const before = paneWith(shape.tabs, shape.tab);
  for (const tab of [-1, shape.tabs.length, shape.tabs.length + 3]) {
    check(
      `close ${tab} of ${shape.tabs.length} is refused`,
      explorerReducer(before, { type: "closeTab", pane: 0, tab }),
      before,
    );
    check(`close others than ${tab} of ${shape.tabs.length} is refused`, closeOtherTabsTarget(viewOf(before), tab), null);
  }
}

/* ------------------------------------------------------------------ */
/* Where the open tab ends up                                          */
/* ------------------------------------------------------------------ */

/**
 * The table, written out rather than derived, because a rule and its
 * implementation agreeing with each other proves nothing.
 *
 * `tab` is the handle that closes, `was` the one that was open, and `want` the
 * strip and the open index afterwards.
 */
const CLOSES: Array<{ what: string; tabs: string[]; was: number; tab: number; want: { tabs: string[]; tab: number } }> = [
  {
    what: "the open tab, with one to its right",
    tabs: ["/one", "/two", "/three"],
    was: 1,
    tab: 1,
    want: { tabs: ["/one", "/three"], tab: 1 },
  },
  {
    what: "the open tab at the right-hand end",
    tabs: ["/one", "/two", "/three"],
    was: 2,
    tab: 2,
    want: { tabs: ["/one", "/two"], tab: 1 },
  },
  {
    what: "the open tab at the left-hand end",
    tabs: ["/one", "/two", "/three"],
    was: 0,
    tab: 0,
    want: { tabs: ["/two", "/three"], tab: 0 },
  },
  {
    what: "a tab to the left of the open one",
    tabs: ["/one", "/two", "/three"],
    was: 2,
    tab: 0,
    want: { tabs: ["/two", "/three"], tab: 1 },
  },
  {
    what: "a tab to the right of the open one",
    tabs: ["/one", "/two", "/three"],
    was: 0,
    tab: 2,
    want: { tabs: ["/one", "/two"], tab: 0 },
  },
  {
    what: "one of two, from the right",
    tabs: ["/one", "/two"],
    was: 0,
    tab: 1,
    want: { tabs: ["/one"], tab: 0 },
  },
  {
    what: "one of two, from the left, while standing on it",
    tabs: ["/one", "/two"],
    was: 0,
    tab: 0,
    want: { tabs: ["/two"], tab: 0 },
  },
];

for (const row of CLOSES) {
  const next = explorerReducer(paneWith(row.tabs, row.was), { type: "closeTab", pane: 0, tab: row.tab });
  check(`closing ${row.what}`, { tabs: next.panes[0].tabs, tab: next.panes[0].tab }, row.want);
}

const OTHERS: Array<{ what: string; tabs: string[]; was: number; tab: number; want: string[] }> = [
  { what: "keeping the open one", tabs: ["/one", "/two", "/three"], was: 1, tab: 1, want: ["/two"] },
  { what: "keeping a background one", tabs: ["/one", "/two", "/three"], was: 0, tab: 2, want: ["/three"] },
  { what: "keeping the last of four", tabs: PATHS, was: 3, tab: 3, want: ["/four"] },
];

for (const row of OTHERS) {
  const next = explorerReducer(paneWith(row.tabs, row.was), { type: "closeOtherTabs", pane: 0, tab: row.tab });
  check(`closing the others, ${row.what}`, { tabs: next.panes[0].tabs, tab: next.panes[0].tab }, { tabs: row.want, tab: 0 });
}

/* ------------------------------------------------------------------ */
/* What the pane is looking at, and what it keeps                      */
/* ------------------------------------------------------------------ */

/**
 * The selection and the cursor go when — and only when — the pane moves.
 *
 * Both directions matter. Names left over from a directory that is no longer on
 * screen aim `rm`, chmod and the rename pattern at rows nobody can see; and a
 * fifty-entry selection lost to tidying up a handle at the other end of the
 * strip is a gesture nobody makes twice.
 */
for (const shape of SHAPES) {
  if (shape.tabs.length === 1) continue;
  for (let tab = 0; tab < shape.tabs.length; tab += 1) {
    const next = explorerReducer(paneWith(shape.tabs, shape.tab), { type: "closeTab", pane: 0, tab });
    const moved = tab === shape.tab;
    check(
      `closing ${tab} of ${shape.tabs.length} while on ${shape.tab}: selection`,
      { sel: next.panes[0].sel, cur: next.panes[0].cur },
      moved ? { sel: [], cur: null } : { sel: ["kept"], cur: "kept" },
    );
  }
}

const twoPanes = explorerReducer(paneWith(["/one", "/two"], 0), { type: "closeTab", pane: 0, tab: 1 });
check("the other pane is untouched", twoPanes.panes[1], initialState("/").panes[1]);

const stacks = explorerReducer(
  { ...paneWith(["/one", "/two"], 0), panes: [{ ...paneWith(["/one", "/two"], 0).panes[0], hist: ["/was"], fwd: ["/next"] }, initialState("/").panes[1]] },
  { type: "closeTab", pane: 0, tab: 1 },
);
// Shutting a handle is not a navigation. The pane goes nowhere it has not
// already been, so `←` still offers what it offered a moment ago.
check("closing a tab leaves the history stacks alone", { hist: stacks.panes[0].hist, fwd: stacks.panes[0].fwd }, {
  hist: ["/was"],
  fwd: ["/next"],
});

/* ------------------------------------------------------------------ */
/* The URL and the memory are written with the same value              */
/* ------------------------------------------------------------------ */

/**
 * The one that cannot be caught by eye at runtime.
 *
 * `closeTab` in the explorer resolves the destination from the pure function
 * and *then* dispatches, so the query string is written from one answer and the
 * strip from another. Nothing afterwards compares them: they simply disagree,
 * and the pane shows one directory under a tab labelled with a different one —
 * which is TRE-131 all over again, arriving through the door TRE-130 opened.
 *
 * So: every shape, every handle, both actions, and the rule is the same for
 * both. Null means the pane does not move, and then it must not have; a path
 * means the pane moves there, and then `tabs[tab]` must be it.
 */
for (const shape of SHAPES) {
  for (let tab = 0; tab < shape.tabs.length; tab += 1) {
    const before = paneWith(shape.tabs, shape.tab);
    const standing = before.panes[0].tabs[before.panes[0].tab];

    for (const type of ["closeTab", "closeOtherTabs"] as const) {
      const target =
        type === "closeTab" ? closeTabTarget(viewOf(before), tab) : closeOtherTabsTarget(viewOf(before), tab);
      const after = explorerReducer(before, { type, pane: 0, tab });
      const landed = after.panes[0].tabs[after.panes[0].tab];

      check(
        `${type} ${tab} of ${shape.tabs.length} from ${shape.tab}: the URL matches the strip`,
        landed,
        target ?? standing,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* A sequence, because a single close can be right and a run wrong     */
/* ------------------------------------------------------------------ */

/**
 * Four tabs, standing on the first, closing the right-hand end each time.
 *
 * Every close is aimed at a background handle, so the pane must not move once —
 * and `tab` is 0 throughout, which is the case where an index that failed to
 * follow the array would look correct by accident. It is checked against the
 * *path*, not the index, for exactly that reason.
 */
let walk = paneWith(PATHS, 0);
const fromRight: string[] = [walk.panes[0].tabs[walk.panes[0].tab]];
for (let step = 0; step < 4; step += 1) {
  walk = explorerReducer(walk, { type: "closeTab", pane: 0, tab: walk.panes[0].tabs.length - 1 });
  fromRight.push(walk.panes[0].tabs[walk.panes[0].tab]);
}
check(
  "closing the far end never moves the pane, and stops at one tab",
  { seen: fromRight, tabs: walk.panes[0].tabs },
  // The fourth close is the refusal: three handles come off, one stays.
  { seen: ["/one", "/one", "/one", "/one", "/one"], tabs: ["/one"] },
);

/**
 * The same run from the other end: standing on the last tab and closing it.
 *
 * This is where `Math.min` earns its place. Each close takes the right-hand
 * end *and* the open index with it, so the pane has to walk left one handle at
 * a time; without the clamp the second step indexes past the end of its own
 * strip and `tabs[tab]` is `undefined` — a path the URL would then be written
 * with, and one no parser downstream accepts.
 */
walk = paneWith(PATHS, PATHS.length - 1);
const fromEnd: string[] = [walk.panes[0].tabs[walk.panes[0].tab]];
for (let step = 0; step < 4; step += 1) {
  walk = explorerReducer(walk, { type: "closeTab", pane: 0, tab: walk.panes[0].tab });
  fromEnd.push(walk.panes[0].tabs[walk.panes[0].tab]);
}
check(
  "closing the open tab at the end walks the pane left, one at a time",
  { seen: fromEnd, tabs: walk.panes[0].tabs },
  { seen: ["/four", "/three", "/two", "/one", "/one"], tabs: ["/one"] },
);

// `..` is a cursor, never a tab. Nothing here should have invented one.
check("no handle is named `..`", walk.panes[0].tabs.includes(PARENT_NAME), false);

console.log(failures === 0 ? `tabs: ${checks} checks passed` : `tabs: ${failures} of ${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
