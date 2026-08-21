/**
 * What the palette does with what is typed into it (TRE-36 §2, §3).
 *
 * A ranking is the kind of thing that can be wrong without ever looking wrong.
 * An entry that quietly stops matching is not reported as a bug — it is read as
 * "the app cannot do that", by somebody who then goes and does it another way
 * and never mentions it. So the two halves are tabled rather than tried.
 *
 * Ranking: the ordering is asserted as an ordering, not as scores. What matters
 * is that `ren` puts `rename` above the entries that merely mention it, that
 * every token has to land somewhere, and that a tie comes out in the order the
 * app declared — the numbers behind that are free to change.
 *
 * Paths: a table of every shape a typed path takes, including the ones that
 * only appear while somebody is mid-word. `/`, `/srv`, `/srv/` and `/srv/me`
 * are four different questions and the trailing-slash pair is the one that
 * silently offers the wrong directory's contents when it is wrong.
 *
 *   node scripts/verify-palette.ts        (or: pnpm verify:palette)
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it.
 */

import {
  ACTION_GLYPH,
  commonPrefix,
  completions,
  GROUPS,
  joinInto,
  pathQuery,
  rank,
  score,
  withHeads,
} from "../src/helpers/palette.ts";
import { registerAliases } from "./aliases.ts";

// The registry imports `@helpers/keys`; see `aliases.ts` for why this has to be
// a dynamic import rather than a static one.
registerAliases();
const { isRule, resolveActions } = await import("../src/components/shell/actions.ts");

import type { Candidate } from "../src/helpers/palette.ts";

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

/** A candidate, written the short way: label, description, group. */
function entry(label: string, detail = "", group = "ACTIONS"): Candidate {
  return { label, detail, group };
}

// ------------------------------------------------------------------ matching

console.log("--- what counts as a match ---");

const RENAME = entry("rename", "one name, or a pattern over the selection");

ok("a prefix matches", score("ren", RENAME) !== null);
ok("so does the middle of a word", score("nam", RENAME) !== null);
ok("and so does a subsequence", score("rnm", RENAME) !== null);
ok("case is not a question", score("REN", RENAME) !== null);
ok("a token that is nowhere rejects the entry", score("zzz", RENAME) === null);
ok("and rejects it even beside one that matches", score("rename zzz", RENAME) === null);
check("an empty query matches everything, flat", score("", RENAME), 0);
check("and so does whitespace", score("   ", RENAME), 0);

ok("the group is searchable", score("actions", RENAME) !== null);
ok("the description is searchable", score("pattern", RENAME) !== null);

const COPY_TO = entry("copy to other pane", "with each conflict decided per entry");
ok("tokens may arrive in any order", score("pane copy", COPY_TO) !== null);
ok("in either order", score("copy pane", COPY_TO) !== null);
check(
  "and the order does not change the score",
  score("pane copy", COPY_TO),
  score("copy pane", COPY_TO),
);

console.log("--- and what beats what ---");

const START = entry("compare with other pane");
const WORD = entry("open in compare mode");
const MIDDLE = entry("recompare");
const NEITHER = entry("copy to other pane"); // no `compare`, loosely or otherwise
const IN_DETAIL = entry("refresh", "compare is what this is not");

function above(what: string, better: Candidate, worse: Candidate, query: string) {
  const a = score(query, better);
  const b = score(query, worse);
  checks += 1;
  if (a === null || b === null || a <= b) fail(`${what}: ${a} should beat ${b}`);
}

above("the start of the label beats a word inside it", START, WORD, "compare");
above("a word inside the label beats the middle of one", WORD, MIDDLE, "compare");
above("anywhere in the label beats the description", MIDDLE, IN_DETAIL, "compare");
above("a literal hit beats a loose one", entry("permissions"), entry("make it so"), "mis");
ok("and the loose one is still a hit", score("mis", entry("make it so")) !== null);
ok("a label that has none of it is not a hit", score("compare", NEITHER) === null);
// A description is a sentence, and four characters are a subsequence of almost
// any sentence. `rename` used to survive `pane` on exactly that.
ok("nor is a subsequence of the description", score("pane", RENAME) === null);

console.log("--- the order that comes out ---");

const LIST: readonly Candidate[] = [
  entry("compare with other pane", "name, size and hash, both directories"),
  entry("permissions", "mode, owner and group"),
  entry("rename", "one name, or a pattern over the selection"),
  entry("copy to other pane", "with each conflict decided per entry"),
  entry("refresh", "re-read this directory from the host"),
];

check(
  "an empty query keeps the app's own order",
  rank(LIST, "").map((item) => item.label),
  LIST.map((item) => item.label),
);
// Both end in "other pane", so both are a word-boundary hit and the tie is a
// real one — which is exactly when declaration order has to decide.
check(
  "`pane` finds the two that say it and nothing else",
  rank(LIST, "pane").map((item) => item.label),
  ["compare with other pane", "copy to other pane"],
);
check(
  "`re` puts the two that start with it above the three that contain it",
  rank(LIST, "re").slice(0, 2).map((item) => item.label),
  ["rename", "refresh"],
);
check("a query nothing answers returns nothing", rank(LIST, "zzz").length, 0);

// Ties keep their declared order — the palette's list is somebody's arrangement
// and equal matches must not shuffle it.
const TIED: readonly Candidate[] = [entry("aa one"), entry("aa two"), entry("aa three")];
check(
  "equal scores stay in declaration order",
  rank(TIED, "aa").map((item) => item.label),
  ["aa one", "aa two", "aa three"],
);

// ------------------------------------------------------------------- headers

console.log("--- where a group header goes ---");

const GROUPED: readonly Candidate[] = [
  entry("a", "", "GO TO"),
  entry("b", "", "GO TO"),
  entry("c", "", "ACTIONS"),
  entry("d", "", "GO TO"),
];

check(
  "once per run, not once per group",
  withHeads(GROUPED).map((row) => row.head),
  ["GO TO", null, "ACTIONS", "GO TO"],
);
check("nothing in, nothing out", withHeads([]).length, 0);
check("one row carries its own header", withHeads([entry("a", "", "VIEW")])[0].head, "VIEW");

check("the groups are the mockup's, in its order", GROUPS.join(" "), "GO TO ACTIONS VIEW SHELL VIEWS SERVERS");

// ------------------------------------------------------------- typing a path

console.log("--- a typed path, split ---");

const PATHS: ReadonlyArray<[string, { dir: string; leaf: string; target: string } | null]> = [
  ["", null],
  ["   ", null],
  ["rename", null],
  ["srv/www", null],
  ["~", null],
  ["./relative", null],
  ["/", { dir: "/", leaf: "", target: "/" }],
  ["/s", { dir: "/", leaf: "s", target: "/s" }],
  ["/srv", { dir: "/", leaf: "srv", target: "/srv" }],
  ["/srv/", { dir: "/srv", leaf: "", target: "/srv" }],
  ["/srv/me", { dir: "/srv", leaf: "me", target: "/srv/me" }],
  ["/srv/media/", { dir: "/srv/media", leaf: "", target: "/srv/media" }],
  ["/srv/media/up", { dir: "/srv/media", leaf: "up", target: "/srv/media/up" }],
  ["  /srv/media  ", { dir: "/srv", leaf: "media", target: "/srv/media" }],
  // A space inside a path is a name, not a separator, and `.trim()` must not
  // reach into one.
  ["/srv/my files", { dir: "/srv", leaf: "my files", target: "/srv/my files" }],
];

for (const [input, want] of PATHS) {
  check(`pathQuery(${JSON.stringify(input)})`, pathQuery(input), want);
}

check("join at the root", joinInto("/", "srv"), "/srv");
check("join below it", joinInto("/srv", "backups"), "/srv/backups");

console.log("--- and completed ---");

const UNDER_VAR = ["backups", "cache", "lib", "log", "logrotate.d", "mail", "spool", "tmp", "www"];

check("everything, capped", completions("", UNDER_VAR, 4), ["backups", "cache", "lib", "log"]);
check("what carries on the leaf", completions("lo", UNDER_VAR, 8), ["log", "logrotate.d"]);
check("case is not a question here either", completions("LO", UNDER_VAR, 8), ["log", "logrotate.d"]);
check("nothing matches nothing", completions("zz", UNDER_VAR, 8), []);
check("the listing's own order is kept", completions("", UNDER_VAR, 3), ["backups", "cache", "lib"]);

check("⇥ stops where the candidates disagree", commonPrefix(["log", "logrotate.d"]), "log");
check("and takes the whole name when there is one", commonPrefix(["backups"]), "backups");
check("nothing shared is nothing filled in", commonPrefix(["log", "mail"]), "");
check("no candidates, no completion", commonPrefix([]), "");
// Compared case-insensitively but returned as the directory spells it, so ⇥
// into `/Users` does not rewrite the capital somebody's filesystem chose.
check("the directory's own capitals survive", commonPrefix(["Users", "users-old"]), "Users");

// -------------------------------------------------------------------- glyphs

console.log("--- the icon column ---");

for (const [id, glyph] of Object.entries(ACTION_GLYPH)) {
  // Two characters is what fits the 16px column at 11px mono, and 2a's own
  // `aA` is already both of them.
  ok(`${id} has a mark, and it fits`, glyph.length > 0 && glyph.length <= 2);
}

console.log("--- every row the palette draws says what it does ---");

// The description is what the ranking matches on and what a disabled row's
// reason replaces. An action reaching the palette without one is a row with a
// blank second line and nothing but its own label to be found by.
for (const row of resolveActions(
  { kind: "entries", entries: ["file"], hostId: "h1", otherHostId: "h2", holding: true },
  "palette",
)) {
  if (isRule(row)) continue;
  ok(`${row.id} carries a note`, (row.note ?? "").length > 0);
  ok(`${row.id} carries a glyph`, ACTION_GLYPH[row.id].length > 0);
}

console.log(`\n${checks - failures}/${checks} assertions held.`);
if (failures > 14) console.log(`(${failures - 14} further failures not printed)`);
process.exit(failures === 0 ? 0 : 1);
