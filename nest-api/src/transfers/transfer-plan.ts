/**
 * Everything a transfer decides before it moves a byte (TRE-23 §2).
 *
 * Pure, and its own file for the reason `delete-plan.ts` and `upload-name.ts`
 * are: these are the decisions, and decisions are what is worth testing
 * exhaustively without a filesystem or a socket underneath. What is left in
 * `transfer.service.ts` is the walking and the writing.
 *
 * The shape of the whole feature is here: a plan is computed once, the operator
 * answers the conflicts once, and the answers are written onto the job. Nothing
 * downstream asks again. A copy that stops to ask a question ten minutes in is
 * a copy that sits half-finished in a tab nobody has open.
 */

import { numberedName } from "@fs/upload-name";

import type { WalkedEntry } from "@fs/tree-walk";

export type TransferOperation = "copy" | "move";

/**
 * The blanket answer, chosen above the list and overridable per row.
 *
 * `ask` is the absence of an answer rather than a fourth behaviour: it means
 * the operator has decided nothing yet, and a job carrying it for an item that
 * genuinely conflicts is refused at creation rather than started and stalled.
 */
export type ConflictStrategy = "ask" | "overwrite" | "skip" | "keepBoth";

/** How the decision is stored. Mirrors the `ConflictDecision` enum in Prisma. */
export type ConflictDecision = "ASK" | "OVERWRITE" | "SKIP" | "RENAME";

export const CONFLICT_STRATEGIES: readonly ConflictStrategy[] = ["ask", "overwrite", "skip", "keepBoth"];

/** One side of a comparison. Null on the destination side means "not there". */
export interface EntryFacts {
  size: number;
  mtimeMs: number;
  /**
   * Only carried on the destination side, and only so a directory arriving on
   * a directory can be told from a directory arriving on a file. The source
   * side's kind is on the item itself.
   */
  kind?: string;
}

export interface PlannedItem {
  /** Path relative to the source root, so the destination can be rebuilt. */
  name: string;
  kind: string;
  bytes: number;
  mode: number | null;
  mtimeMs: number | null;
  source: EntryFacts;
  /** What is already at the destination under this name, or null. */
  target: EntryFacts | null;
  /** True when `target` is not null — the one question the operator answers. */
  conflict: boolean;
  /** The mockup's line: "identical size · target is 3 d older". "" when no conflict. */
  note: string;
}

/**
 * A path that is not a source path but whose absence would break the tree —
 * the directories between the source root and a walked entry. There are none
 * with the current walk (it records every directory it descends through), and
 * the type exists so the runner's ordering does not have to assume that.
 */
export function creationOrder(items: readonly PlannedItem[]): PlannedItem[] {
  // Shallowest first: `a` must exist before `a/b`, and the walk hands back the
  // opposite order because a delete needs children before their parent. Sorting
  // by segment count rather than by string length — `/aaa` and `/a/b` are the
  // same number of characters and not the same depth.
  return items.filter((item) => item.kind === "directory").sort((left, right) => depth(left.name) - depth(right.name));
}

/**
 * The order directories are stamped and removed in: deepest first.
 *
 * Both operations need it and for the same reason read two ways. Writing a file
 * into a directory updates that directory's mtime, so the stamp has to happen
 * after everything underneath is in place. Removing a directory needs it empty,
 * so the removal has to happen after everything underneath is gone.
 */
export function settlementOrder(items: readonly PlannedItem[]): PlannedItem[] {
  return items.filter((item) => item.kind === "directory").sort((left, right) => depth(right.name) - depth(left.name));
}

function depth(name: string): number {
  return name.split("/").filter(Boolean).length;
}

/**
 * The decision an item carries into the job.
 *
 * An item with nothing at the destination gets `ASK`, which reads as
 * "undecided" and is correct: nobody was asked, because there was nothing to
 * ask about. The runner treats it as a skip *if a conflict has appeared since*,
 * which is the only way that state can turn out to matter.
 */
export function decisionFor(
  strategy: ConflictStrategy,
  override: ConflictStrategy | undefined,
  conflict: boolean,
): ConflictDecision {
  if (!conflict) return "ASK";
  switch (override ?? strategy) {
    case "overwrite":
      return "OVERWRITE";
    case "skip":
      return "SKIP";
    case "keepBoth":
      return "RENAME";
    default:
      return "ASK";
  }
}

/** Items still undecided after the strategy and the overrides have been applied. */
export function undecided(items: readonly PlannedItem[], decisions: readonly ConflictDecision[]): PlannedItem[] {
  return items.filter((item, index) => item.conflict && decisions[index] === "ASK");
}

/**
 * The line under a conflicting row, in the mockup's words.
 *
 * Only what differs. A row that says "identical size · same age" has spent two
 * facts telling the reader there is nothing to weigh, and the rows worth
 * reading are the ones where something does.
 */
export function conflictNote(source: EntryFacts, target: EntryFacts | null): string {
  if (target === null) return "";

  const parts: string[] = [];
  const delta = source.size - target.size;
  parts.push(delta === 0 ? "identical size" : `${delta > 0 ? "+" : "−"}${formatBytes(Math.abs(delta))} vs target`);

  // Ages relative to each other, not to now. "3 d old" describes the target and
  // "3 d older" describes the choice, and the choice is what the row is for.
  const ageMs = source.mtimeMs - target.mtimeMs;
  const age = describeSpan(Math.abs(ageMs));
  if (age !== null) parts.push(`target is ${age} ${ageMs > 0 ? "older" : "newer"}`);

  return parts.join(" · ");
}

/**
 * How many `keepBoth` candidates are tried before giving up. A thousand copies
 * of one name is not a conflict, it is a loop somewhere.
 *
 * The candidates themselves come from `numberedName`, shared with the upload
 * path deliberately: a file that lands as `report (2).txt` when dropped on a
 * pane and as `report.txt.1` when copied between them would be two conventions
 * for one situation.
 */
export const MAX_KEEP_BOTH_ATTEMPTS = 1000;

/** `report.txt` → `report (2).txt`. Re-exported so callers need one import. */
export { numberedName };

/**
 * The directory a selection was made in, and the proof that it was one.
 *
 * Every source path must share a parent, which is what a pane selection always
 * is. It is not a restriction so much as the definition of `TransferItems.name`
 * being relative to something: two paths in different directories have no
 * common root that is not `/`, and rebuilding the destination from `/` would
 * recreate the whole path spine under it.
 */
export function commonParent(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;

  const parents = new Set(paths.map(parentOf));
  return parents.size === 1 ? [...parents][0] : null;
}

/**
 * Whether the destination sits inside the source — the copy that eats the disk.
 *
 * `cp -r /a /a/b` writes into the tree it is reading, and the walk that was
 * taken before it started keeps this one from looping forever. It would still
 * be wrong: the copy would contain a directory the operator never asked for and
 * the source would no longer be what they selected. Refused rather than
 * tolerated, on the same host only — two hosts may have identical paths and
 * they are different machines.
 */
export function destinationInsideSource(sourcePath: string, destinationPath: string): boolean {
  const source = normalise(sourcePath);
  const destination = normalise(destinationPath);
  return destination === source || destination.startsWith(source === "/" ? "/" : `${source}/`);
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function joinPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

function normalise(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Whether an entry landing on what is already there is a question for anybody.
 *
 * **A directory arriving on a directory is a merge, not a conflict**, which is
 * what every file manager does and the only answer that survives contact with
 * the three options. "Overwrite" a directory would have to mean deleting its
 * contents, which nobody asked for; "keep both" would have to rename it, and
 * every path underneath was decided before the question was asked. The
 * per-file conflicts inside it are the real questions and they are each asked
 * on their own row.
 *
 * A directory arriving on a *file* is a genuine conflict and is left as one —
 * but with no answer that can be given, because all three would mean removing
 * a file to make room for a folder. It refuses at the item and says why, which
 * is the safe direction for a case this rare.
 */
export function isConflict(sourceKind: string, target: EntryFacts | null): boolean {
  if (target === null) return false;
  return !(sourceKind === "directory" && target.kind === "directory");
}

/** The walk's entry, as an item. The relative name is the caller's to supply. */
export function itemFrom(entry: WalkedEntry, name: string, target: EntryFacts | null): PlannedItem {
  const source: EntryFacts = { size: entry.size, mtimeMs: entry.mtimeMs };
  const conflict = isConflict(entry.kind, target);

  return {
    name,
    kind: entry.kind,
    // Directories carry their own inode size, which is not data being moved and
    // would make a transfer's total larger than the bytes that cross the wire.
    bytes: entry.kind === "directory" ? 0 : entry.size,
    mode: entry.mode === 0 ? null : entry.mode,
    mtimeMs: entry.mtimeMs === 0 ? null : entry.mtimeMs,
    source,
    // Kept even when this is not a conflict: a merging directory *is* there,
    // and a client deciding what to draw from `target === null` would say it is
    // not. `conflict` is the flag that decides whether anybody is asked.
    target,
    conflict,
    // Sizes and ages are a file's question. A directory's inode size compares
    // two numbers that mean nothing to anybody, and it was rendering
    // "identical size · target is 20 min newer" on a folder before this.
    note: entry.kind === "directory" ? directoryNote(target) : conflictNote(source, target),
  };
}

function directoryNote(target: EntryFacts | null): string {
  if (target === null) return "";
  return target.kind === "directory"
    ? "already there — its contents merge, file by file"
    : "a file of that name is in the way";
}

const SPANS: ReadonlyArray<{ ms: number; unit: string }> = [
  { ms: 86_400_000, unit: "d" },
  { ms: 3_600_000, unit: "h" },
  { ms: 60_000, unit: "min" },
];

/** Null below a minute: two files written in the same minute are the same age. */
function describeSpan(ms: number): string | null {
  for (const span of SPANS) {
    if (ms >= span.ms) return `${Math.floor(ms / span.ms)} ${span.unit}`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}
