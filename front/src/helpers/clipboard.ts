import type { TransferOperation } from "@lib/api/transfers";

/**
 * The clipboard's arithmetic (TRE-71).
 *
 * The two-pane model answers "copy these to the place already on screen". This
 * is the other one: take a selection here, go somewhere the second pane is not
 * pointing — another directory, another host — and put it down. Everything
 * underneath already exists, so what is left is deciding what a `⌘V` means
 * given what is held and where it landed.
 *
 * Kept pure and kept away from React because those decisions have checkable
 * answers, and the ones that go wrong go wrong quietly: a paste that moves
 * nothing, a cut re-pasted onto itself, a name held from before something was
 * deleted. `scripts/verify-clipboard.ts` tables all of them.
 */

export type ClipboardMode = "cut" | "copy";

/**
 * What `⌘X` or `⌘C` is holding.
 *
 * Names and a directory rather than whole paths, for the reason the pane's
 * selection is names (TRE-16 §3): the two are asked different questions. The
 * directory is what a paste compares against to know it is being put back where
 * it came from, and the names are what gets re-checked against a fresh listing
 * before anything moves.
 */
export interface Clipboard {
  mode: ClipboardMode;
  hostId: string;
  directory: string;
  names: readonly string[];
}

/** Where `⌘V` was pressed: the active pane's host and the directory it shows. */
export interface PasteDestination {
  hostId: string | null;
  path: string;
}

export type PasteDecision =
  /** Nothing is held. `⌘V` does nothing, and says nothing about it. */
  | { kind: "empty" }
  /** The pane has no host, so there is nowhere for the bytes to land. */
  | { kind: "unbound" }
  /** A cut, put back in the directory it was taken from. */
  | { kind: "sameDirectory" }
  /** Carries what it decided about, so the caller needs no second null check. */
  | { kind: "transfer"; operation: TransferOperation; source: Clipboard };

/**
 * What a paste into this destination means.
 *
 * `sameDirectory` is only ever a **cut**. A copy pasted where it came from is a
 * real request — it is what `duplicate` is, and the server's own `keepBoth`
 * answers it — whereas a move onto its own directory has nothing to do and
 * nothing to report, so it is caught here rather than sent to a server that
 * would plan zero items and a modal that would show them.
 */
export function resolvePaste(clip: Clipboard | null, destination: PasteDestination): PasteDecision {
  if (clip === null || clip.names.length === 0) return { kind: "empty" };
  if (destination.hostId === null) return { kind: "unbound" };
  if (clip.mode === "cut" && clip.hostId === destination.hostId && clip.directory === destination.path) {
    return { kind: "sameDirectory" };
  }
  return { kind: "transfer", operation: clip.mode === "cut" ? "move" : "copy", source: clip };
}

/**
 * The held names split by whether they are still there.
 *
 * A clipboard survives navigation, which means it survives whatever happened in
 * between — including the entry being renamed from another machine. Trusting
 * the names as taken would hand the transfer a source path that no longer
 * resolves, and the server would refuse the whole job over one of them. So the
 * ones that are gone are dropped and named, and the rest still move.
 *
 * Order follows what was held, not what the listing happens to be sorted by:
 * the toast names them back in the order they were taken.
 */
export function splitHeld(
  names: readonly string[],
  existing: readonly string[],
): { present: string[]; missing: string[] } {
  const there = new Set(existing);
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of names) (there.has(name) ? present : missing).push(name);
  return { present, missing };
}

/**
 * The held names a pane should draw dimmed, or null when it should draw none.
 *
 * Only a cut dims, and only in a pane standing where the cut was taken — which
 * is what makes the dim survive navigating away and back, and what puts it in
 * both panes when both are showing that directory. A copy dims nothing: those
 * files are not going anywhere.
 */
export function cutNamesIn(clip: Clipboard | null, hostId: string | null, path: string): ReadonlySet<string> | null {
  if (clip === null || clip.mode !== "cut") return null;
  if (hostId === null || clip.hostId !== hostId || clip.directory !== path) return null;
  return new Set(clip.names);
}

/**
 * What the status bar says while something is held (TRE-71 §3).
 *
 * How many, and from where — because the alternative is an app that is holding
 * three files and looks exactly like an app holding nothing, which is what
 * makes a `⌘V` twenty minutes later a surprise. The host is named whenever it
 * is known, since the whole point of the clipboard is that the source is
 * somewhere you are no longer looking.
 */
export function describeClipboard(clip: Clipboard, hostLabel: string | null): string {
  const what = clip.names.length === 1 ? "1 entry" : `${clip.names.length} entries`;
  const verb = clip.mode === "cut" ? "cut" : "copied";
  const from = hostLabel === null ? clip.directory : `${hostLabel}:${clip.directory}`;
  return `${what} ${verb} from ${from}`;
}

/**
 * A few names, and a count for the rest.
 *
 * A toast naming two hundred deleted entries is a toast nobody reads and one
 * that covers the status bar while they do not.
 */
export function nameList(names: readonly string[], limit = 3): string {
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`;
}
