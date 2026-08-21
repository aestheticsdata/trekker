import type { ActionId } from "@components/shell/actions";

/**
 * Every chord this app answers to, written down once (TRE-36 §2).
 *
 * The palette teaches shortcuts — that is most of what it is for. An entry
 * carries the key that reaches the same operation, so using the palette is how
 * you stop needing it. Which makes a second copy of those keys worse than
 * useless: a palette that advertises `F3` for a download the handler no longer
 * listens for is not a stale label, it is a lie the UI tells confidently, and
 * the person who believes it concludes the app is broken.
 *
 * Before this file the keys were written in four places — a `hint` string in
 * `components/shell/actions.ts`, a `case` in the explorer's switch, a `key`
 * passed to `useShortcut`, and a hard-coded `⌘K` in the top bar. Nothing held
 * them together. Two of them were already wrong: `compare` advertised `⇄` and
 * `upload` advertised `↑`, neither of which is a key anyone can press, and the
 * second is a key that means something else entirely.
 *
 * So: the table below is the only place a chord is spelled. `writeChord` turns
 * one into the thing a person reads, `matches` turns one into the thing the
 * handler asks, and `commandFor` walks it backwards from an event. Everything
 * else reads it. `pnpm verify:keys` checks the walk round-trips and that no two
 * commands claim the same chord.
 *
 * Imports nothing but a type, like the other helpers a verify script runs
 * directly under node.
 */

/**
 * What a chord can reach.
 *
 * Mostly the action registry, because most of what this app does is an
 * operation on a selection. The four that are not are the ones with no entry
 * there: they open or close a piece of the app rather than doing something to a
 * file.
 */
export type CommandId = ActionId | "inspector" | "selectAll" | "terminal" | "palette";

/**
 * One chord.
 *
 * `meta` covers ⌘ and Ctrl together rather than distinguishing them, which is
 * the rule `useShortcut` has followed since TRE-17: this app is read on a Mac
 * and on Linux, and a shortcut that works on one of them is a shortcut nobody
 * trusts. It is written `⌘` because the mockup writes it that way.
 */
export interface Chord {
  /** A `KeyboardEvent.key`: "F5", "Enter", "Delete", or a single letter. */
  key: string;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** As much of a `KeyboardEvent` as matching needs, so a test can make one. */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * The table.
 *
 * Absence is meaningful. `compare`, `chmod` and `hash` have no chord and so
 * advertise none — the mockup's palette draws `⌘⇧D` beside "compare both
 * panes", and that one is not implementable here for the reason TRE-69 ruled
 * out `⇧⌘N`: Chrome and Firefox both take `⌘⇧D` for bookmarking every open tab
 * before the page sees the key. An entry teaching it would teach a key that
 * never fires, which is the exact failure this file exists to prevent.
 *
 * The F-keys are the two-pane file managers this app is shaped after, and the
 * ⌘-chords are the ones every application has. `⌦` rather than `⌫` for `rm` is
 * TRE-67's decision: forward delete is `fn`+`⌫` on a Mac keyboard, which is
 * exactly the amount of deliberate a destructive default should cost.
 */
export const KEYS = {
  // The pane's own keys, unmodified, as a file manager writes them.
  open: { key: "Enter" },
  newDir: { key: "F7" },
  rename: { key: "F2" },
  download: { key: "F3" },
  copyTo: { key: "F5" },
  moveTo: { key: "F6" },
  rm: { key: "Delete" },

  // The chords, which reach the same operations from inside a text field or
  // from nowhere in particular.
  selectAll: { key: "a", meta: true },
  cut: { key: "x", meta: true },
  copy: { key: "c", meta: true },
  paste: { key: "v", meta: true },
  duplicate: { key: "d", meta: true },
  inspector: { key: "i", meta: true },
  palette: { key: "k", meta: true },

  // And the one that carries ⌥, which is why it needs a listener of its own:
  // the pane's keys are unmodified ones and both hooks stand down on `altKey`.
  terminal: { key: "Enter", alt: true },
} as const satisfies Readonly<Partial<Record<CommandId, Chord>>>;

/** Read-only view of the table, for the lookups that take any `CommandId`. */
const TABLE: Readonly<Partial<Record<CommandId, Chord>>> = KEYS;

/**
 * The keys with no glyph on them.
 *
 * `⌫` and `⌦` are here even though nothing maps to `Backspace` today, because
 * the mockup writes both and the pair is only legible together — one of them
 * appearing alone would read as "the delete key" rather than as which one.
 */
const GLYPH: Readonly<Record<string, string>> = {
  Enter: "↩",
  Delete: "⌦",
  Backspace: "⌫",
  Escape: "⎋",
  Tab: "⇥",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * A chord, as a person reads it.
 *
 * Modifiers in Apple's order — ⌃ ⌥ ⇧ ⌘ — which is what a Mac menu prints and
 * what anyone reading `⌥⌘K` expects to see. There are no ⌃ chords here; the
 * order is stated anyway so the next one added lands in the right place.
 */
export function writeChord(chord: Chord): string {
  const key = GLYPH[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.meta ? "⌘" : ""}${key}`;
}

/** What to draw beside a command, or nothing when no key reaches it. */
export function hintFor(id: CommandId): string | undefined {
  const chord = TABLE[id];
  return chord === undefined ? undefined : writeChord(chord);
}

/**
 * Whether an event is this chord.
 *
 * Every modifier is checked, including the ones the chord does not want: `⌘X`
 * must not fire on `⌥⌘X`, and `F5` must not fire on `⇧F5`, which is a
 * different key to anyone who has bound it to something.
 */
export function matches(event: KeyLike, chord: Chord): boolean {
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
  if (event.metaKey || event.ctrlKey) {
    if (chord.meta !== true) return false;
  } else if (chord.meta === true) {
    return false;
  }
  if (Boolean(event.altKey) !== (chord.alt === true)) return false;
  return Boolean(event.shiftKey) === (chord.shift === true);
}

/**
 * The table walked backwards: which command, if any, this event is.
 *
 * One pass over a table of fifteen, on a keypress. There is nothing to index
 * here — the cost of an index would be keeping it in step with the table it
 * indexes, which is the thing this file exists to avoid.
 */
export function commandFor(event: KeyLike): CommandId | null {
  for (const [id, chord] of Object.entries(TABLE) as ReadonlyArray<[CommandId, Chord]>) {
    if (matches(event, chord)) return id;
  }
  return null;
}
