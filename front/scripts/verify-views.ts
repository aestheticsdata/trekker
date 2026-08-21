/**
 * What a saved view remembers, and what it deliberately does not (TRE-37).
 *
 * The dirty dot is the reason this file exists. It is a string comparison of
 * two layouts, and both halves of it can be wrong silently. A field that should
 * be compared and is not gives a view that stops looking unsaved after it has
 * been changed — the worst failure available here, because the operator then
 * presses `⌥3` expecting to get back and gets what they already had. A field
 * that should *not* be compared and is gives a dot that appears when the cursor
 * moves to the other pane, which is the noise the ticket asks for none of.
 *
 * Neither one throws. So both are tabled: every field the view stores, changed
 * one at a time, and every field it does not, changed the same way.
 *
 *   node scripts/verify-views.ts        (or: pnpm verify:views)
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  brokenPanes,
  describeHosts,
  describeLayout,
  describePane,
  describePanes,
  freeSlot,
  isDirty,
  layoutOf,
  leafOf,
  NEUTRAL,
  narrow,
  PANE_KEYS,
  rebind,
  serialise,
  suggestName,
} from "../src/helpers/views.ts";

import type { StoredLayout, ViewLayout } from "../src/schemas/layout.ts";

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
  if (a !== b) fail(`${what}: got ${a}, wanted ${b}`);
}

function ok(what: string, condition: boolean) {
  checks += 1;
  if (!condition) fail(what);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

/** A layout to move one field of at a time. */
const BASE: ViewLayout = {
  a: { host: "11111111-1111-1111-1111-111111111111", path: "/srv/www", sort: "name", dir: 1 },
  b: { host: "22222222-2222-2222-2222-222222222222", path: "/srv/backups", sort: "age", dir: -1 },
  split: "split",
  insp: true,
  heat: false,
  glob: "*.log",
};

const LABELS: Record<string, string> = {
  "11111111-1111-1111-1111-111111111111": "prod-01",
  "22222222-2222-2222-2222-222222222222": "nas-01",
};
const labelOf = (hostId: string | null) => (hostId === null ? null : (LABELS[hostId] ?? null));

// ------------------------------------------------------- one layout, one string

console.log("--- the same layout, however it was built ---");

// The two orders the app actually produces: one out of the API (a, b first),
// one assembled from the URL state (a and b appended last). `JSON.stringify`
// keeps insertion order, so stringifying these directly compares unequal.
const FROM_API = { a: BASE.a, b: BASE.b, split: BASE.split, insp: BASE.insp, heat: BASE.heat, glob: BASE.glob };
const FROM_URL = { split: BASE.split, insp: BASE.insp, heat: BASE.heat, glob: BASE.glob, a: BASE.a, b: BASE.b };

check("key order does not change the string", serialise(FROM_API), serialise(FROM_URL));
ok("and neither does a raw stringify agree", JSON.stringify(FROM_API) !== JSON.stringify(FROM_URL));
check("nor does a pane carrying something extra", serialise({ ...BASE, a: { ...BASE.a, tail: "/x" } as never }), serialise(BASE));

// The field list, pinned. A key added to `ViewLayout` and not to `serialise` is
// a key the dot stops noticing, and TypeScript cannot see the omission.
check(
  "exactly the fields a view stores",
  Object.keys(JSON.parse(serialise(BASE))),
  ["a", "b", "split", "insp", "heat", "glob"],
);
check("and exactly the fields of a pane", Object.keys(JSON.parse(serialise(BASE)).a), ["host", "path", "sort", "dir"]);

// ------------------------------------------------------------ what makes it dirty

console.log("--- every field a change is supposed to show ---");

const MOVES: ReadonlyArray<[string, ViewLayout]> = [
  ["pane A moved to another host", { ...BASE, a: { ...BASE.a, host: "33333333-3333-3333-3333-333333333333" } }],
  ["pane A unbound", { ...BASE, a: { ...BASE.a, host: null } }],
  ["pane A walked somewhere", { ...BASE, a: { ...BASE.a, path: "/srv/www/atlas" } }],
  ["pane B re-sorted", { ...BASE, b: { ...BASE.b, sort: "size" } }],
  ["pane B reversed", { ...BASE, b: { ...BASE.b, dir: 1 } }],
  ["a pane went full width", { ...BASE, split: "left" }],
  ["the inspector closed", { ...BASE, insp: false }],
  ["the heat map came on", { ...BASE, heat: true }],
  ["the glob changed", { ...BASE, glob: "*.gz" }],
  ["the glob was cleared", { ...BASE, glob: "" }],
];

for (const [what, moved] of MOVES) {
  ok(what, isDirty(BASE, moved));
}
ok("and nothing at all is not a change", !isDirty(BASE, { ...BASE, a: { ...BASE.a } }));

console.log("--- and every field it must stay quiet about ---");

/** The whole layout, of which a view is a strict subset. */
const LIVE: StoredLayout = {
  a: { ...BASE.a, tail: null },
  b: { ...BASE.b, tail: null },
  active: 0,
  split: BASE.split,
  view: "detail",
  heat: BASE.heat,
  insp: BASE.insp,
  du: true,
  duRoot: null,
  glob: BASE.glob,
};

const QUIET: ReadonlyArray<[string, StoredLayout]> = [
  ["the keyboard moved to the other pane", { ...LIVE, active: 1 }],
  ["the listing changed density", { ...LIVE, view: "list" }],
  ["the disk strip was collapsed", { ...LIVE, du: false }],
  ["the disk strip was pinned somewhere", { ...LIVE, duRoot: "/srv" }],
  ["a pane started following a file", { ...LIVE, a: { ...LIVE.a, tail: "/var/log/nginx/access.log" } }],
];

for (const [what, moved] of QUIET) {
  ok(what, !isDirty(layoutOf(LIVE), layoutOf(moved)));
}
check("the narrowing keeps what a view is", serialise(layoutOf(LIVE)), serialise(BASE));

// --------------------------------------------------------- the two checkboxes

console.log("--- what the two checkboxes actually change ---");

const BOTH = narrow(BASE, { sorts: true, layout: true });
check("both ticked stores what is on screen", serialise(BOTH), serialise(BASE));

const NO_SORTS = narrow(BASE, { sorts: false, layout: true });
check("sorts unticked neutralises pane A's sort", [NO_SORTS.a.sort, NO_SORTS.a.dir], [NEUTRAL.sort, NEUTRAL.dir]);
check("and pane B's", [NO_SORTS.b.sort, NO_SORTS.b.dir], [NEUTRAL.sort, NEUTRAL.dir]);
check("and the glob with them", NO_SORTS.glob, "");
check("leaving the arrangement alone", [NO_SORTS.split, NO_SORTS.insp, NO_SORTS.heat], ["split", true, false]);
check("and both paths, which are the view", [NO_SORTS.a.path, NO_SORTS.b.path], ["/srv/www", "/srv/backups"]);

const NO_LAYOUT = narrow({ ...BASE, split: "left", insp: false, heat: true }, { sorts: true, layout: false });
check(
  "layout unticked neutralises the arrangement",
  [NO_LAYOUT.split, NO_LAYOUT.insp, NO_LAYOUT.heat],
  [NEUTRAL.split, NEUTRAL.insp, NEUTRAL.heat],
);
check("leaving the sorts alone", [NO_LAYOUT.a.sort, NO_LAYOUT.b.dir], ["name", -1]);

// The neutral values have to be the URL's own defaults, or "do not save the
// sort order" quietly means "save this other sort order instead".
check("neutral is what an untouched app looks like", NEUTRAL.split, "split");
check("and its inspector is open", NEUTRAL.insp, true);
check("and its heat map is on", NEUTRAL.heat, true);
check("and its panes sort by name, ascending", [NEUTRAL.sort, NEUTRAL.dir], ["name", 1]);
check("and it filters nothing", NEUTRAL.glob, "");

// ------------------------------------------------------------- the shortcut

console.log("--- which chord a new view is offered ---");

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

check("nothing taken, the first one", freeSlot([], SLOTS), 1);
check("the gap, not the next number", freeSlot([1, 2, 4], SLOTS), 3);
check("nulls are not chords", freeSlot([null, null, 1], SLOTS), 2);
check("all nine taken is an honest none", freeSlot([...SLOTS], SLOTS), null);
check("and so is a taken list with holes filled out of order", freeSlot([9, 8, 7, 6, 5, 4, 3, 2, 1], SLOTS), null);

// ------------------------------------------------------------- how it reads

console.log("--- what a view is called, and what it says under its name ---");

check("the root has a name", leafOf("/"), "/");
check("so does a directory", leafOf("/srv/www"), "www");
check("a trailing slash is not a segment", leafOf("/srv/www/"), "www");

check(
  "two panes on one machine name the machine and both directories",
  suggestName({ ...BASE, b: { ...BASE.b, host: BASE.a.host } }, labelOf),
  "prod-01 · www ↔ backups",
);
check("two machines name the trip", suggestName(BASE, labelOf), "prod-01 → nas-01");
check("an unbound pane says so rather than guessing", suggestName({ ...BASE, b: { ...BASE.b, host: null } }, labelOf), "prod-01 → —");
check("nothing bound at all falls back to the directory", suggestName({ ...BASE, a: { ...BASE.a, host: null }, b: { ...BASE.b, host: null } }, labelOf), "www");

check("the sidebar's line is the two machines", describeHosts(BASE, labelOf), "prod-01 ↔ nas-01");
check("the palette's is both directories too", describePanes(BASE, labelOf), "prod-01:/srv/www  ↔  nas-01:/srv/backups");

check("a pane previews where and how", describePane(BASE.a, labelOf), { where: "prod-01:/srv/www", sorted: "sorted by name ▲" });
check("descending is drawn as descending", describePane(BASE.b, labelOf).sorted, "sorted by age ▼");
check("an unbound pane says no host", describePane({ ...BASE.a, host: null }, labelOf).where, "no host:/srv/www");

check("the arrangement previews as prose", describeLayout(BASE), { how: "both panes · inspector on · heat off", filter: "glob filter *.log" });
check("a solo pane is named", describeLayout({ ...BASE, split: "right" }).how, "pane B alone · inspector on · heat off");
check("no glob says so", describeLayout({ ...BASE, glob: "" }).filter, "no filter");
check("and whitespace is not a glob", describeLayout({ ...BASE, glob: "   " }).filter, "no filter");

// ------------------------------------------------------------ what is broken

console.log("--- a view whose host has gone ---");

const KNOWN = [BASE.a.host as string, BASE.b.host as string];

check("both hosts present, nothing broken", brokenPanes(BASE, LABELS, KNOWN), []);
check(
  "one host gone names the pane and the machine",
  brokenPanes(BASE, LABELS, [KNOWN[0]]),
  [{ pane: "b", was: "nas-01" }],
);
check("both gone reports both", brokenPanes(BASE, LABELS, []).map((broken) => broken.pane), ["a", "b"]);
check("no memo is an honest null rather than a wrong name", brokenPanes(BASE, {}, [])[0].was, null);
// An unbound pane is not a broken one: it was deliberately saved bound to
// nothing, and offering to rebind it would be inventing a problem.
check("an unbound pane is not broken", brokenPanes({ ...BASE, a: { ...BASE.a, host: null } }, LABELS, [KNOWN[1]]), []);

console.log("--- and where it is put instead ---");

const REBOUND = rebind(BASE, { b: "44444444-4444-4444-4444-444444444444" });
check("the pane takes the new host", REBOUND.b.host, "44444444-4444-4444-4444-444444444444");
// A path only means something against the machine it was read from.
check("and does not carry the old path onto it", REBOUND.b.path, "/srv/backups");
check("the other pane is untouched", serialise({ ...REBOUND, b: BASE.b }), serialise(BASE));

const UNBOUND = rebind(BASE, { a: null });
check("choosing nothing unbinds the pane", UNBOUND.a.host, null);
check("and takes it to the root, because the path meant the old machine", UNBOUND.a.path, "/");
check("a rebind of nothing changes nothing", serialise(rebind(BASE, {})), serialise(BASE));

check("both panes are answered for", PANE_KEYS, ["a", "b"]);

// ------------------------------------------------ nothing spells a chord itself

console.log("--- and nothing draws a chord of its own ---");

/**
 * The file with its comments taken out.
 *
 * These greps are about what the app *draws*, and a comment explaining why `⌥3`
 * is written by the keymap would otherwise fail the check that it is.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

for (const file of ["view-strip.tsx", "view-list.tsx", "view-form.tsx", "view-menu.tsx", "view-rebind.tsx"]) {
  const source = code(readFileSync(join(SRC, "components", "views", file), "utf8"));
  // The one rule TRE-36 exists to keep: `⌥3` is written by `writeViewSlot` and
  // by nothing else, so moving it there moves it everywhere.
  ok(`${file} spells no ⌥ of its own`, !source.includes("⌥"));
  ok(`${file} names no Digit code`, !source.includes("Digit"));
  // 2a's quiet ink is 3.82:1 on this app's chrome and clears AA on every ground
  // in this feature; the lifted ones are named constants `verify:contrast`
  // measures. `disabled:` is the one exemption, and it is the standard's:
  // WCAG 1.4.3 does not hold an inactive control to a ratio.
  for (const [, before] of source.matchAll(/(\S*)text-ink-faint/g)) {
    ok(`${file}: ink-faint only on a disabled control`, before.endsWith("disabled:"));
  }
}

console.log(`\n${checks - failures}/${checks} assertions held.`);
if (failures > 14) console.log(`(${failures - 14} further failures not printed)`);
process.exit(failures === 0 ? 0 : 1);
