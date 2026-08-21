/**
 * The keymap, and everything that claims to read it (TRE-36 §2).
 *
 * The palette's promise is that the key beside an entry is the key that runs
 * it. That promise is not kept by writing the table carefully once — it is kept
 * by there being one table, and by nothing anywhere else spelling a chord. So
 * two different things are checked here.
 *
 * The arithmetic: every chord round-trips through `commandFor`, no two commands
 * claim the same one, and `matches` refuses a chord that has picked up an extra
 * modifier on the way. That last one is the quiet failure — `⌘X` firing on
 * `⌥⌘X` is a cut nobody asked for, on a selection nobody was looking at.
 *
 * The structure: the action registry's hints are read out of the table rather
 * than written beside the labels, and the explorer dispatches from it rather
 * than from `case "F5"`. Both are read off disk, because a type cannot say
 * "and this is the only place it is written".
 *
 *   node scripts/verify-keys.ts        (or: pnpm verify:keys)
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFor, hintFor, KEYS, matches, writeChord } from "../src/helpers/keys.ts";
import { registerAliases } from "./aliases.ts";

// The registry imports `@helpers/keys`, which is the whole point of it; see
// `aliases.ts` for why this has to be a dynamic import.
registerAliases();
const { isRule, resolveActions } = await import("../src/components/shell/actions.ts");

import type { ActionContext } from "../src/components/shell/actions.ts";
import type { Chord, CommandId, KeyLike } from "../src/helpers/keys.ts";

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

const TABLE = KEYS as Readonly<Partial<Record<CommandId, Chord>>>;
const ENTRIES = Object.entries(TABLE) as ReadonlyArray<[CommandId, Chord]>;

/** The event a browser would deliver for this chord, and nothing more. */
function press(chord: Chord): KeyLike {
  return {
    key: chord.key,
    metaKey: chord.meta === true,
    altKey: chord.alt === true,
    shiftKey: chord.shift === true,
  };
}

// --------------------------------------------------- the table walks both ways

console.log("--- every chord finds its way back ---");

for (const [id, chord] of ENTRIES) {
  check(`commandFor(${writeChord(chord)})`, commandFor(press(chord)), id);
  // And with Ctrl in place of ⌘, which is the same chord on a Linux keyboard.
  if (chord.meta === true) {
    const control = { ...press(chord), metaKey: false, ctrlKey: true };
    check(`commandFor(ctrl ${writeChord(chord)})`, commandFor(control), id);
  }
}

const spelled = new Map<string, CommandId>();
for (const [id, chord] of ENTRIES) {
  const written = writeChord(chord);
  const taken = spelled.get(written);
  checks += 1;
  if (taken !== undefined) fail(`${written} is claimed by both ${taken} and ${id}`);
  spelled.set(written, id);
}

// ------------------------------------------------------------ how they read

console.log("--- how a chord is written ---");

check("⌘K", hintFor("palette"), "⌘K");
check("⌘I", hintFor("inspector"), "⌘I");
check("⌥↩", hintFor("terminal"), "⌥↩");
check("F5", hintFor("copyTo"), "F5");
check("⌦", hintFor("rm"), "⌦");
check("↩", hintFor("open"), "↩");
check("modifiers in Apple's order", writeChord({ key: "k", meta: true, alt: true, shift: true }), "⌥⇧⌘K");
check("a letter is capitalised", writeChord({ key: "x", meta: true }), "⌘X");
check("a named key is not", writeChord({ key: "F10" }), "F10");
check("nothing reaches compare", hintFor("compare"), undefined);
check("nor chmod", hintFor("chmod"), undefined);
check("nor upload — `↑` was never a key", hintFor("upload"), undefined);

// ------------------------------------------------- and what they refuse to be

console.log("--- a chord is the chord, and not one with something extra held ---");

ok("⌘X is not ⌥⌘X", !matches({ key: "x", metaKey: true, altKey: true }, KEYS.cut));
ok("⌘X is not ⇧⌘X", !matches({ key: "x", metaKey: true, shiftKey: true }, KEYS.cut));
ok("⌘X is not X", !matches({ key: "x" }, KEYS.cut));
ok("⌘X is ⌘X", matches({ key: "x", metaKey: true }, KEYS.cut));
ok("⌘X is ⌃X", matches({ key: "x", ctrlKey: true }, KEYS.cut));
ok("F5 is not ⇧F5", !matches({ key: "F5", shiftKey: true }, KEYS.copyTo));
ok("F5 is not ⌘F5", !matches({ key: "F5", metaKey: true }, KEYS.copyTo));

// The two that share a key and are told apart by ⌥ alone. Getting this wrong
// would make ↩ in a pane open the terminal, or ⌥↩ open a directory.
check("↩ is `open`", commandFor({ key: "Enter" }), "open");
check("⌥↩ is the terminal", commandFor({ key: "Enter", altKey: true }), "terminal");
check("⌘↩ is neither", commandFor({ key: "Enter", metaKey: true }), null);
check("an unbound key is nothing", commandFor({ key: "F9" }), null);
check("nor is an arrow", commandFor({ key: "ArrowDown" }), null);
// ⇥, the arrows, ⌫ and ⎋ move a cursor rather than running an operation, and
// nothing advertises them — so nothing in the table may claim them either, or
// the pane's own navigation would start dispatching commands.
for (const key of ["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Escape"]) {
  check(`${key} stays the pane's`, commandFor({ key }), null);
}

// ------------------------------------------- the registry does not spell them

console.log("--- the action registry reads the table rather than copying it ---");

const CONTEXT: ActionContext = {
  kind: "entries",
  entries: ["file"],
  hostId: "h1",
  otherHostId: "h2",
  holding: true,
};

for (const row of resolveActions(CONTEXT, "palette")) {
  if (isRule(row)) continue;
  check(`${row.id} advertises what the table says`, row.hint, hintFor(row.id));
}

// The `mark` on those two is the glyph 2a draws, and it must never be sitting
// in `hint` again — that is precisely how `upload ↑` came to look like a key.
for (const row of resolveActions(CONTEXT, "toolbar")) {
  if (isRule(row)) continue;
  ok(`${row.id}: a mark is not a chord`, row.mark === undefined || row.hint === undefined);
}

const registry = readFileSync(join(SRC, "components", "shell", "actions.ts"), "utf8");
// One `hintFor(` in the file: the line inside `resolveActions`. A second would
// be a surface asking for its own copy, and a `hint:` literal anywhere in the
// specs would be the old arrangement growing back.
check("one lookup, in `resolveActions`", registry.match(/hintFor\(/g)?.length ?? 0, 1);
check("no hint is written into a spec", registry.match(/^\s*hint:\s*"/gm)?.length ?? 0, 0);

// ------------------------------------------------- and neither does the handler

console.log("--- and the keyboard layer dispatches from it ---");

const explorer = readFileSync(join(SRC, "components", "explorer", "explorer.tsx"), "utf8");

ok("the pane's switch runs on `commandFor`", explorer.includes("switch (commandFor(event))"));
for (const key of ["F2", "F3", "F5", "F6", "F7", "Delete"]) {
  ok(`no bare \`case "${key}"\` left behind`, !explorer.includes(`case "${key}":`));
}
// Every `useShortcut` takes a chord out of the table. Counted rather than
// parsed: a call site that grew its own `key: "j"` would show up as a mismatch.
check(
  "every useShortcut is given a chord",
  explorer.match(/chord: KEYS\./g)?.length ?? 0,
  // The lookbehind drops the declaration; what is being counted is call sites.
  explorer.match(/(?<!function )useShortcut\(\{/g)?.length ?? 0,
);
ok("⌥↩ is matched against the table", explorer.includes("matches(event, KEYS.terminal)"));

// The chip in the corner, which is the most-read shortcut in the application.
const topBar = readFileSync(join(SRC, "components", "shell", "top-bar.tsx"), "utf8");
ok("the top bar's chip names itself from the table", topBar.includes('hintFor("palette")'));
ok("and no longer says ⌘K in a string", !topBar.includes(">⌘K<"));

console.log(`\n${checks - failures}/${checks} assertions held.`);
if (failures > 14) console.log(`(${failures - 14} further failures not printed)`);
process.exit(failures === 0 ? 0 : 1);
