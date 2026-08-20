/**
 * The context menu's two checkable halves (TRE-70 §8).
 *
 * Placement is arithmetic whose failure mode is a menu with three rows below
 * the fold, at one window height, at one pointer position. Nobody finds that by
 * right-clicking around for a minute, so it is swept by brute force instead:
 * every pointer position on a grid, against every menu size, against every
 * viewport — and at each one the box has to be on screen, has to leave the
 * pointer visible, and has to prefer down-right when there is room for it.
 *
 * `resolveActions` is the function three surfaces trust to agree with each
 * other, so it is tabled rather than sampled: every target shape against the
 * entries and the reasons expected.
 *
 *   node scripts/verify-menu.ts        (or: pnpm verify:menu)
 *
 * The sizes are deliberately not round. `--ui-base` (TRE-44) scales every
 * length through a percentage, so a menu 197.6px wide is as ordinary as one at
 * 208, and integer-only arithmetic passes a test that lies.
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it.
 */

import { isRule, resolveActions } from "../src/components/shell/actions.ts";
import { covers, placeMenu } from "../src/helpers/menu.ts";

import type { ActionContext, ActionRow } from "../src/components/shell/actions.ts";

let failures = 0;
let checks = 0;

function fail(what: string) {
  failures += 1;
  if (failures <= 14) console.log(`FAIL ${what}`);
}

function check(what: string, got: unknown, want: unknown) {
  checks += 1;
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) fail(`${what}\n     got  ${a}\n     want ${b}`);
}

// ------------------------------------------------------------------ placement

console.log("--- where the menu goes ---");

const MARGIN = 4;
/** 197.6 and 231.4 are what `--ui-base` 10 and 14 do to the same menu. */
const SIZES = [
  { width: 197.6, height: 120 },
  { width: 208, height: 402.5 },
  { width: 231.4, height: 640 },
  { width: 900, height: 1400 },
];
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 420 },
  { width: 1024, height: 240.5 },
  { width: 360, height: 180 },
];

for (const viewport of VIEWPORTS) {
  for (const size of SIZES) {
    // Every corner, every edge midpoint, the centre, and a ring just inside the
    // margin — the positions a pointer actually reaches.
    const xs = new Set<number>([0, MARGIN, 1, viewport.width / 2, viewport.width - MARGIN, viewport.width, 17.5]);
    const ys = new Set<number>([0, MARGIN, 1, viewport.height / 2, viewport.height - MARGIN, viewport.height, 17.5]);
    for (let step = 0; step <= 10; step += 1) {
      xs.add((viewport.width * step) / 10);
      ys.add((viewport.height * step) / 10);
    }

    for (const x of xs) {
      for (const y of ys) {
        const point = { x, y };
        const box = placeMenu(point, size, viewport, MARGIN);
        const where = `${viewport.width}x${viewport.height} menu ${size.width}x${size.height} at ${x},${y}`;

        checks += 1;
        // On screen, both axes. `maxHeight` is what it may draw in, so a menu
        // that had to shrink scrolls inside a box that still fits.
        if (box.left < 0 || box.left + box.width > viewport.width) fail(`${where}: off screen in x -> ${box.left}`);
        else if (box.top < 0 || box.top + box.maxHeight > viewport.height)
          fail(`${where}: off screen in y -> ${box.top}+${box.maxHeight}`);
        // Never under the pointer.
        else if (covers(box, point)) fail(`${where}: covers the pointer`);
        // Nothing is ever drawn at a negative height.
        else if (box.maxHeight < 0 || box.width < 0) fail(`${where}: negative box`);
        // Down-right whenever there is room for it, because that is where the
        // hand already is and where every desktop menu opens.
        else if (
          x + size.width <= viewport.width - MARGIN &&
          y + size.height <= viewport.height - MARGIN &&
          (box.left !== x || box.top !== y)
        ) {
          fail(`${where}: had room down-right and went to ${box.left},${box.top}`);
        }
      }
    }
  }
}

// A menu taller than the window keeps every row reachable by scrolling inside
// itself, rather than drawing the tail past the bottom edge.
for (const viewport of VIEWPORTS) {
  const tall = { width: 200, height: viewport.height * 3 };
  const box = placeMenu({ x: 10, y: viewport.height / 2 }, tall, viewport, MARGIN);
  checks += 1;
  if (box.maxHeight >= tall.height) fail(`tall menu on ${viewport.height}px: did not shrink`);
  else if (box.maxHeight <= 0) fail(`tall menu on ${viewport.height}px: no room at all`);
}

// --------------------------------------------------------------- the registry

console.log("--- which entries exist, and which are live ---");

function context(patch: Partial<ActionContext> = {}): ActionContext {
  return { kind: "entries", entries: ["file"], hostId: "h1", otherHostId: "h2", holding: false, ...patch };
}

/** The ids a surface draws, rules dropped. */
function ids(rows: readonly ActionRow[]): string[] {
  return rows.filter((row) => !isRule(row)).map((row) => (isRule(row) ? "" : row.id));
}

/** Why one entry is disabled, or null when it is live. */
function why(rows: readonly ActionRow[], id: string): string | null {
  for (const row of rows) {
    if (!isRule(row) && row.id === id) return row.unavailableReason ?? null;
  }
  return "ABSENT";
}

check("the entries shape", ids(resolveActions(context(), "menu")), [
  "newDir",
  "newFile",
  "open",
  "openOther",
  "cut",
  "copy",
  "duplicate",
  "copyTo",
  "moveTo",
  "rename",
  "chmod",
  "download",
  "link",
  "hash",
  "copyPath",
  "copyName",
  "favourite",
  "rm",
]);

check("the directory shape", ids(resolveActions(context({ kind: "directory", entries: [] }), "menu")), [
  "newDir",
  "newFile",
  "paste",
  "upload",
  "refresh",
  "compare",
  "copyPath",
  "favourite",
]);

// The toolbar's row is what it has always been, and takes the short labels.
check("the toolbar row", ids(resolveActions(context(), "toolbar")), [
  "newDir",
  "copyTo",
  "moveTo",
  "duplicate",
  "compare",
  "chmod",
  "rename",
  "download",
  "upload",
  "rm",
]);
const toolbar = resolveActions(context(), "toolbar");
check(
  "the toolbar's shorter labels",
  toolbar.filter((row) => !isRule(row)).map((row) => (isRule(row) ? "" : row.label)),
  ["new", "copy", "move", "duplicate", "compare", "permissions", "rename", "download", "upload", "rm"],
);
check("and the menu's longer ones", why(resolveActions(context(), "menu"), "copyTo"), null);
check(
  "which the menu spells out",
  resolveActions(context(), "menu")
    .filter((row) => !isRule(row) && (row.id === "copyTo" || row.id === "copy"))
    .map((row) => (isRule(row) ? "" : row.label)),
  ["copy", "copy to other pane"],
);

// The rules never double up and never bookend the list.
for (const kind of ["entries", "directory"] as const) {
  const rows = resolveActions(context({ kind, entries: kind === "directory" ? [] : ["file"] }), "menu");
  checks += 1;
  if (isRule(rows[0]) || isRule(rows[rows.length - 1])) fail(`${kind}: a rule at an end`);
  else if (rows.some((row, index) => index > 0 && isRule(row) && isRule(rows[index - 1])))
    fail(`${kind}: two rules together`);
}

console.log("--- and what each one needs ---");

const NO_HOST = "Bind a host to this pane first";
const NOTHING = "Select an entry, or put the cursor on one";
const ONE = "This takes one entry at a time";

const TABLE: ReadonlyArray<{
  what: string;
  context: ActionContext;
  id: string;
  want: string | null;
  /** The menu unless said otherwise — `compare` only ever had a toolbar button. */
  surface?: "toolbar" | "menu";
}> = [
  // Nothing selected: the whole entries shape stands down, and says the same
  // sentence the toolbar's buttons already say.
  { what: "rm with nothing selected", context: context({ entries: [] }), id: "rm", want: NOTHING },
  { what: "rename with nothing selected", context: context({ entries: [] }), id: "rename", want: NOTHING },
  { what: "rm on one file", context: context(), id: "rm", want: null },
  { what: "rm on a multi-selection", context: context({ entries: ["file", "dir", "link"] }), id: "rm", want: null },

  // One at a time.
  { what: "download of one", context: context(), id: "download", want: null },
  { what: "download of three", context: context({ entries: ["file", "file", "file"] }), id: "download", want: ONE },
  { what: "open of three", context: context({ entries: ["file", "file", "file"] }), id: "open", want: ONE },

  // Kinds.
  { what: "a signed link for a file", context: context(), id: "link", want: null },
  // Aimed at the two panes rather than at a selection, so it needs a host on
  // both sides and cares about nothing being selected.
  {
    what: "compare with both panes bound",
    context: context({ kind: "directory", entries: [] }),
    id: "compare",
    want: null,
  },
  {
    what: "compare with nothing on the other pane",
    context: context({ kind: "directory", entries: [], otherHostId: null }),
    id: "compare",
    want: "The other pane has no host to compare against",
  },
  // A checksum takes many, and a directory among them is expanded into the
  // files under it rather than refused — so there is no kind rule here.
  { what: "sha256 of one file", context: context(), id: "hash", want: null },
  { what: "sha256 of a directory", context: context({ entries: ["dir"] }), id: "hash", want: null },
  { what: "sha256 of a multi-selection", context: context({ entries: ["file", "dir"] }), id: "hash", want: null },
  { what: "sha256 with nothing selected", context: context({ entries: [] }), id: "hash", want: NOTHING },
  {
    what: "a signed link for a directory",
    context: context({ entries: ["dir"] }),
    id: "link",
    want: "A signed link points at a file",
  },
  { what: "open a directory in the other pane", context: context({ entries: ["dir"] }), id: "openOther", want: null },
  // It points the other pane at this host rather than sending anything there,
  // so an empty pane over there is not a reason to refuse.
  {
    what: "open a directory in an unbound other pane",
    context: context({ entries: ["dir"], otherHostId: null }),
    id: "openOther",
    want: null,
  },
  {
    what: "open a file in the other pane",
    context: context(),
    id: "openOther",
    want: "Only a directory can be opened in the other pane",
  },
  { what: "favourite a directory", context: context({ entries: ["dir"] }), id: "favourite", want: null },
  {
    what: "favourite a file",
    context: context(),
    id: "favourite",
    want: "Only a directory can be a favourite",
  },
  // The directory shape favourites the place the pane is standing in, so it
  // needs no selection at all.
  {
    what: "favourite the directory itself",
    context: context({ kind: "directory", entries: [] }),
    id: "favourite",
    want: null,
  },
  {
    what: "copy path of the directory itself",
    context: context({ kind: "directory", entries: [] }),
    id: "copyPath",
    want: null,
  },
  {
    what: "copy path of three entries",
    context: context({ entries: ["file", "file", "file"] }),
    id: "copyPath",
    want: ONE,
  },

  // The other pane.
  { what: "F5 with a host over there", context: context(), id: "copyTo", want: null },
  {
    what: "F5 with no host over there",
    context: context({ otherHostId: null }),
    id: "copyTo",
    want: "The other pane has no host to send these to",
  },
  {
    what: "F6 with no host over there",
    context: context({ otherHostId: null }),
    id: "moveTo",
    want: "The other pane has no host to send these to",
  },
  // The clipboard does not care about the other pane — that is its whole point.
  {
    what: "paste with no host over there",
    context: context({ kind: "directory", entries: [], otherHostId: null, holding: true }),
    id: "paste",
    want: null,
  },
  {
    what: "paste holding nothing",
    context: context({ kind: "directory", entries: [] }),
    id: "paste",
    want: "Nothing on the clipboard",
  },

  // A pane with no host can do nothing at all, and the reason is the same one
  // everywhere rather than a different sentence per action.
  { what: "rm on an unbound pane", context: context({ hostId: null }), id: "rm", want: NO_HOST },
  { what: "new directory on an unbound pane", context: context({ hostId: null }), id: "newDir", want: NO_HOST },
  {
    what: "refresh on an unbound pane",
    context: context({ kind: "directory", entries: [], hostId: null }),
    id: "refresh",
    want: NO_HOST,
  },
  {
    what: "paste on an unbound pane, holding something",
    context: context({ kind: "directory", entries: [], hostId: null, holding: true }),
    id: "paste",
    want: NO_HOST,
  },

  // Live as of TRE-28. It asks about the two panes' directories, so a
  // selection neither enables nor disables it — only a host on each side does.
  {
    what: "compare from the toolbar",
    context: context(),
    id: "compare",
    want: null,
    surface: "toolbar",
  },
  {
    what: "compare from the toolbar with an unbound other pane",
    context: context({ otherHostId: null }),
    id: "compare",
    want: "The other pane has no host to compare against",
    surface: "toolbar",
  },

  // Entries belonging to the other shape are absent, not disabled.
  { what: "paste in the entries shape", context: context(), id: "paste", want: "ABSENT" },
  { what: "rm in the directory shape", context: context({ kind: "directory", entries: [] }), id: "rm", want: "ABSENT" },
  {
    what: "copy name in the directory shape",
    context: context({ kind: "directory", entries: [] }),
    id: "copyName",
    want: "ABSENT",
  },
  { what: "compare in the menu", context: context(), id: "compare", want: "ABSENT" },
];

for (const row of TABLE) {
  check(row.what, why(resolveActions(row.context, row.surface ?? "menu"), row.id), row.want);
}

// The toolbar reads the same rules, so an action dead in one surface is dead in
// the other — the drift this registry exists to prevent.
for (const patch of [
  {},
  { entries: [] },
  { hostId: null },
  { otherHostId: null },
  { entries: ["dir", "file"] },
] as const) {
  for (const id of ["rm", "rename", "chmod", "copyTo", "moveTo", "download", "duplicate"]) {
    const shared = context(patch as Partial<ActionContext>);
    checks += 1;
    const inMenu = why(resolveActions(shared, "menu"), id);
    const inToolbar = why(resolveActions(shared, "toolbar"), id);
    if (inMenu !== inToolbar)
      fail(`${id} with ${JSON.stringify(patch)}: menu says ${inMenu}, toolbar says ${inToolbar}`);
  }
}

console.log(`\n${checks - failures}/${checks} assertions held.`);
if (failures > 14) console.log(`(${failures - 14} further failures not printed)`);
process.exit(failures === 0 ? 0 : 1);
