/**
 * The clipboard, checked by table (TRE-71).
 *
 * What `⌘V` means is a decision taken from four facts — is anything held, does
 * the destination have a host, was it a cut or a copy, and is this the place it
 * came from — and the way it fails is not a crash. It is a move that quietly
 * does nothing, or a cut pasted onto itself that opens a modal about zero
 * items, at one combination somebody meets once a month.
 *
 * So every combination is enumerated here rather than sampled, together with
 * the two functions the paste leans on afterwards: which held names survived
 * until the paste, and which rows a pane should draw dimmed.
 *
 *   node scripts/verify-clipboard.ts        (or: pnpm verify:clipboard)
 *
 * There is no test runner in `front/` yet; TRE-39 brings one, and this moves
 * into it. Until then it follows the convention `verify-virtual.ts` set.
 */

import { cutNamesIn, describeClipboard, nameList, resolvePaste, splitHeld } from "../src/helpers/clipboard.ts";

import type { Clipboard, PasteDestination } from "../src/helpers/clipboard.ts";

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

const HERE = "/var/log";
const THERE = "/srv/backup";

function clip(mode: "cut" | "copy", hostId = "h1", directory = HERE, names = ["access.log", "error.log"]): Clipboard {
  return { mode, hostId, directory, names };
}

function to(hostId: string | null, path: string): PasteDestination {
  return { hostId, path };
}

// ---------------------------------------------------------------- resolvePaste

console.log("--- what ⌘V means ---");

const DECISIONS: ReadonlyArray<{ what: string; clip: Clipboard | null; destination: PasteDestination; want: unknown }> =
  [
    { what: "nothing held", clip: null, destination: to("h1", THERE), want: { kind: "empty" } },
    {
      what: "held, but no names in it",
      clip: clip("cut", "h1", HERE, []),
      destination: to("h1", THERE),
      want: { kind: "empty" },
    },
    // Checked before the pane's host, so a ⌘V on an unbound pane holding
    // nothing is silence rather than "bind a host first" for a paste that was
    // never going to happen.
    { what: "nothing held, unbound pane", clip: null, destination: to(null, THERE), want: { kind: "empty" } },
    {
      what: "cut, pasted on a pane with no host",
      clip: clip("cut"),
      destination: to(null, THERE),
      want: { kind: "unbound" },
    },
    {
      what: "copy, pasted on a pane with no host",
      clip: clip("copy"),
      destination: to(null, THERE),
      want: { kind: "unbound" },
    },
    {
      what: "cut, put back where it came from",
      clip: clip("cut"),
      destination: to("h1", HERE),
      want: { kind: "sameDirectory" },
    },
    {
      what: "cut, same path on another host",
      clip: clip("cut"),
      destination: to("h2", HERE),
      want: { kind: "transfer", operation: "move", source: clip("cut") },
    },
    {
      what: "cut, another directory on the same host",
      clip: clip("cut"),
      destination: to("h1", THERE),
      want: { kind: "transfer", operation: "move", source: clip("cut") },
    },
    // A copy pasted where it came from is a real request — it is what
    // `duplicate` is — so it must not be caught by the no-op rule the cut is.
    {
      what: "copy, put back where it came from",
      clip: clip("copy"),
      destination: to("h1", HERE),
      want: { kind: "transfer", operation: "copy", source: clip("copy") },
    },
    {
      what: "copy, another host",
      clip: clip("copy"),
      destination: to("h2", THERE),
      want: { kind: "transfer", operation: "copy", source: clip("copy") },
    },
    // The directory is compared as written, and a trailing slash is not what
    // any pane holds — but a near-miss must be a transfer, never a silent no-op.
    {
      what: "cut, a directory that only looks like the source",
      clip: clip("cut"),
      destination: to("h1", `${HERE}/archive`),
      want: { kind: "transfer", operation: "move", source: clip("cut") },
    },
  ];

for (const row of DECISIONS) {
  check(row.what, resolvePaste(row.clip, row.destination), row.want);
}

/**
 * The same question by sweep, for the invariants the table states one row at a
 * time: a cut is always a move and a copy is always a copy, nothing is a
 * transfer without a destination host, and the only no-op is a cut on its own
 * directory.
 */
for (const mode of ["cut", "copy"] as const) {
  for (const hostId of ["h1", "h2"]) {
    for (const path of [HERE, THERE, "/", `${HERE}/deep`]) {
      for (const names of [[], ["one"], ["one", "two"]]) {
        for (const destinationHost of ["h1", "h2", null]) {
          const held = clip(mode, hostId, path, names);
          const decision = resolvePaste(held, to(destinationHost, HERE));
          checks += 1;

          const samePlace = hostId === destinationHost && path === HERE;
          const expected =
            names.length === 0
              ? "empty"
              : destinationHost === null
                ? "unbound"
                : mode === "cut" && samePlace
                  ? "sameDirectory"
                  : "transfer";

          if (decision.kind !== expected) {
            failures += 1;
            if (failures <= 12) {
              console.log(`FAIL sweep ${mode} ${hostId}:${path} -> ${destinationHost}:${HERE}: ${decision.kind}`);
            }
            continue;
          }
          if (decision.kind === "transfer" && decision.operation !== (mode === "cut" ? "move" : "copy")) {
            failures += 1;
            if (failures <= 12) console.log(`FAIL sweep operation for ${mode}: ${decision.operation}`);
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ splitHeld

console.log("--- what is still there when the paste happens ---");

check("all present", splitHeld(["a", "b"], ["b", "a", "c"]), { present: ["a", "b"], missing: [] });
check("one gone", splitHeld(["a", "b"], ["a"]), { present: ["a"], missing: ["b"] });
check("all gone", splitHeld(["a", "b"], []), { present: [], missing: ["a", "b"] });
check("nothing held", splitHeld([], ["a"]), { present: [], missing: [] });
// The order is the one they were taken in, so the toast names them back the
// way they were selected rather than the way the directory happens to sort.
check("held order, not listing order", splitHeld(["z", "a"], ["a", "z"]), { present: ["z", "a"], missing: [] });
// A name that came back as a different kind is still that name. Whether a file
// became a directory is the transfer plan's question, not this one's.
check("present is by name alone", splitHeld(["logs"], ["logs"]), { present: ["logs"], missing: [] });

// ----------------------------------------------------------------- cutNamesIn

console.log("--- which rows render dimmed ---");

function dimmed(clipboard: Clipboard | null, hostId: string | null, path: string): string[] | null {
  const names = cutNamesIn(clipboard, hostId, path);
  return names === null ? null : [...names].sort();
}

check("a cut, in its own directory", dimmed(clip("cut"), "h1", HERE), ["access.log", "error.log"]);
check("a cut, one directory over", dimmed(clip("cut"), "h1", THERE), null);
check("a cut, same path on another host", dimmed(clip("cut"), "h2", HERE), null);
// A copy dims nothing: those files are not going anywhere, and dimming them
// would say they were.
check("a copy, in its own directory", dimmed(clip("copy"), "h1", HERE), null);
check("nothing held", dimmed(null, "h1", HERE), null);
check("a pane with no host", dimmed(clip("cut"), null, HERE), null);

// ------------------------------------------------------- what the bar reports

console.log("--- what the status bar says ---");

check(
  "one, cut, host known",
  describeClipboard(clip("cut", "h1", HERE, ["a"]), "web-01"),
  "1 entry cut from web-01:/var/log",
);
check("two, copied, host known", describeClipboard(clip("copy"), "web-01"), "2 entries copied from web-01:/var/log");
check("host unknown", describeClipboard(clip("cut", "h1", HERE, ["a"]), null), "1 entry cut from /var/log");

check("a short list is named in full", nameList(["a", "b", "c"]), "a, b, c");
check("a long list is not", nameList(["a", "b", "c", "d", "e"]), "a, b, c and 2 more");
check("one over the limit", nameList(["a", "b", "c", "d"]), "a, b, c and 1 more");

console.log(`\n${checks - failures}/${checks} assertions held.`);
if (failures > 12) console.log(`(${failures - 12} further failures not printed)`);
process.exit(failures === 0 ? 0 : 1);
