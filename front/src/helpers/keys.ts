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
  /**
   * A `KeyboardEvent.code` — the physical key — where `key` cannot be trusted.
   *
   * Only the ⌥-digit chords need this, and they need it badly: on a Mac, ⌥1 is
   * not `"1"`. The layout decides what it is (`¡` on US, `„` on German), so a
   * chord matched on `key` alone would work on nobody's keyboard but the one it
   * was written on. `Digit1` is the same key everywhere.
   *
   * Absent on every other chord, because `key` is the right question for them:
   * `⌘X` should be the key that says X, wherever the layout has put it.
   */
  code?: string;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/** As much of a `KeyboardEvent` as matching needs, so a test can make one. */
export interface KeyLike {
  key: string;
  /** Absent in a hand-made event, which is why `matches` falls back to `key`. */
  code?: string;
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
  // The physical key wins where the chord names one and the event reports one,
  // and only then: a synthetic event carries no `code`, and refusing those
  // would mean the chord could be checked by nothing but a browser.
  if (chord.code !== undefined && event.code !== undefined) {
    if (event.code !== chord.code) return false;
  } else if (event.key.toLowerCase() !== chord.key.toLowerCase()) {
    return false;
  }
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

// ------------------------------------------------------------- saved views

/**
 * The nine chords a saved view can claim (TRE-37 §1).
 *
 * Not in `KEYS`, and the distinction matters. That table maps a *command* — a
 * fixed thing this app does — to a chord. These nine reach whatever the account
 * has decided they should reach, and on a fresh install they reach nothing at
 * all. Putting them in the same table would mean inventing nine `CommandId`s
 * for operations that do not exist, and `commandFor` would then answer `view3`
 * for a key that runs nothing.
 *
 * They are still built out of the same `Chord`, matched by the same `matches`
 * and spelled by the same `writeChord`, which is the part that has to hold:
 * `⌥3` is written in one place whether it is drawn in the top bar, listed in
 * the palette, or pressed.
 *
 * ⌥ rather than ⌘, and that is not the mockup being decorative. ⌘1–⌘9 is how
 * every browser switches tabs and the page never sees it — the same reason
 * TRE-69 gave up `⇧⌘N` and TRE-36 gave up `⌘⇧D`.
 */
export const VIEW_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export type ViewSlot = (typeof VIEW_SLOTS)[number];

/** The chord that restores whatever is in this slot. */
export function viewChord(slot: ViewSlot): Chord {
  return { key: String(slot), code: `Digit${slot}`, alt: true };
}

/** `⌥3`, for the strip, the sidebar, the palette and the picker alike. */
export function writeViewSlot(slot: ViewSlot): string {
  return writeChord(viewChord(slot));
}

/** Which slot this event is, or null when it is not one of the nine. */
export function viewSlotFor(event: KeyLike): ViewSlot | null {
  for (const slot of VIEW_SLOTS) {
    if (matches(event, viewChord(slot))) return slot;
  }
  return null;
}

/** Whether a number off the wire is one of the nine, and not a 0 or a 47. */
export function isViewSlot(value: unknown): value is ViewSlot {
  return typeof value === "number" && (VIEW_SLOTS as readonly number[]).includes(value);
}
