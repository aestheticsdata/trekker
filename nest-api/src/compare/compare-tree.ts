import { posix } from "node:path";
import { MAX_UNREADABLE_NAMED } from "@compare/compare-limits";

import type { FileEntry, FileKind } from "@hosts/drivers/host-driver";

/**
 * The paired walk, and the verdicts it reaches (TRE-28 §1).
 *
 * Pure but for the two `list` functions it is handed, which is what makes the
 * whole of the interesting part testable without two machines: the pairing, the
 * recursion, the bounds, and every rule about what "these two are different"
 * means. `compare.service.ts` supplies the listings and the digests and does
 * nothing else.
 *
 * **The levels are cheap to expensive, and each one only sees what the last
 * could not settle.**
 *
 *   1. A name on one side only — free, it falls out of the pairing.
 *   2. A different size, a different mtime, or a different kind — free, the
 *      listing already carries all three.
 *   3. A checksum — minutes of somebody's disk, so it is opt-in and is asked
 *      for only where 1 and 2 came back with nothing.
 *
 * Level 3 does not happen here. This walk marks those rows `inconclusive` and
 * `compare.service.ts` fills in whatever `FileHashes` already holds; asking for
 * the rest is TRE-27's job, queued by the client through the ordinary hash
 * route so that it is rate limited and cancellable like every other hash.
 *
 * **What is never claimed: `identical` without evidence.** Two files of the
 * same size and the same mtime are *probably* the same and this will not say
 * so, because "probably" is not what somebody deleting the second copy is
 * reading. That is the whole reason `inconclusive` is a verdict rather than an
 * optimistic `identical`.
 */

export type Verdict =
  /** A name only the left root holds. */
  | "onlyA"
  /** A name only the right root holds. */
  | "onlyB"
  /** Settled, and no checksum can change it. */
  | "differs"
  /** Settled by something that actually looked at the bytes. */
  | "identical"
  /** Nothing cheap could tell them apart, and nothing expensive was run. */
  | "inconclusive";

/**
 * Which level reached the verdict.
 *
 * On screen it is the difference between "these differ" and "these differ *by
 * one second of mtime*", which is the difference between a real drift and a
 * copy somebody made without `-p`.
 */
export type Reason =
  /** Present on one side only. */
  | "name"
  /** A file on one side and a directory on the other. */
  | "kind"
  | "size"
  | "mtime"
  /** Symlinks, compared by what they point at. */
  | "link"
  /** A checksum said so, or a checksum is what it would take. */
  | "hash"
  /** A shared directory the depth bound stopped the walk from opening. */
  | "depth";

export interface SideFacts {
  kind: FileKind;
  size: number;
  mtimeMs: number;
  /** Only for a symlink, and only when the driver could read it. */
  linkTarget?: string;
}

export interface CompareEntry {
  /** Relative to both roots, so one string names the same thing on both sides. */
  path: string;
  /** Levels below the roots. 1 for a direct child. */
  depth: number;
  a: SideFacts | null;
  b: SideFacts | null;
  verdict: Verdict;
  reason: Reason;
}

export interface CompareWalk {
  entries: CompareEntry[];
  /** A bound bit: the entry ceiling, or a shared directory left unopened. */
  truncated: boolean;
  /** Directories one side could not list. Counted in full, named up to a cap. */
  unreadable: string[];
  unreadableCount: number;
}

export interface CompareDeps {
  rootA: string;
  rootB: string;
  listA: (path: string) => Promise<FileEntry[]>;
  listB: (path: string) => Promise<FileEntry[]>;
  /** Levels below the roots to descend. */
  depth: number;
  /** Rows to produce before the walk gives up. */
  ceiling: number;
}

/**
 * Compare two trees, breadth of names first and depth second.
 *
 * Depth-first in name order, so the rows arrive grouped by directory — which
 * is how somebody reads them, and it costs nothing because the ordering is the
 * recursion's own.
 *
 * Never throws for anything a host did. A directory that cannot be listed is
 * recorded and the rest of the comparison carries on: a tree with one closed
 * subdirectory in it still has a useful answer, and refusing to give one
 * because of it would make the feature unusable on exactly the machines it is
 * most wanted on.
 */
export async function compareTrees(deps: CompareDeps): Promise<CompareWalk> {
  const walk: CompareWalk = { entries: [], truncated: false, unreadable: [], unreadableCount: 0 };

  const unreadable = (relative: string): void => {
    walk.unreadableCount += 1;
    if (walk.unreadable.length < MAX_UNREADABLE_NAMED) walk.unreadable.push(relative || ".");
  };

  const descend = async (relative: string, depth: number): Promise<void> => {
    if (walk.truncated) return;

    const [left, right] = await Promise.all([
      listOrNull(deps.listA, posix.join(deps.rootA, relative)),
      listOrNull(deps.listB, posix.join(deps.rootB, relative)),
    ]);

    // One side unreadable is still worth reporting the other side's names for:
    // "everything here is only in A" is exactly what an unreadable B looks
    // like, and is a true statement about what we could see. Both unreadable
    // is nothing at all.
    if (left === null) unreadable(relative);
    if (right === null) unreadable(relative);
    if (left === null && right === null) return;

    const byNameA = index(left ?? []);
    const byNameB = index(right ?? []);
    const names = [...new Set([...byNameA.keys(), ...byNameB.keys()])].sort();

    for (const name of names) {
      if (walk.truncated) return;

      const a = byNameA.get(name) ?? null;
      const b = byNameB.get(name) ?? null;
      const path = relative === "" ? name : `${relative}/${name}`;

      // A directory on both sides is a container, not a row: its own row would
      // be a verdict about a name rather than about anything inside it, and the
      // rows underneath say what actually differs. What *is* a row is the
      // directory the depth bound stopped us opening.
      if (a?.kind === "directory" && b?.kind === "directory") {
        if (depth >= deps.depth) {
          push(walk, deps.ceiling, {
            path,
            depth,
            a: factsOf(a),
            b: factsOf(b),
            verdict: "inconclusive",
            reason: "depth",
          });
          // Not the entry ceiling, but a bound that bit all the same. The
          // summary has to say so, or "no differences below here" reads as a
          // fact about a subtree nothing opened.
          walk.truncated = true;
          continue;
        }
        await descend(path, depth + 1);
        continue;
      }

      const decided = decide(a, b);
      push(walk, deps.ceiling, { path, depth, a: a && factsOf(a), b: b && factsOf(b), ...decided });
    }
  };

  await descend("", 1);
  return walk;
}

/**
 * One pair, at the two cheap levels.
 *
 * Order matters and is the ticket's: a name on one side settles it, then a kind
 * mismatch, then size, then mtime. Anything left is two files that agree about
 * everything a listing knows, which is precisely the question a checksum
 * exists to answer.
 */
export function decide(a: FileEntry | null, b: FileEntry | null): { verdict: Verdict; reason: Reason } {
  if (a && !b) return { verdict: "onlyA", reason: "name" };
  if (b && !a) return { verdict: "onlyB", reason: "name" };
  if (!a || !b) return { verdict: "inconclusive", reason: "name" };

  // A file where the other side has a directory. No checksum applies and no
  // copy is a simple one, so it is named as its own kind of difference.
  if (a.kind !== b.kind) return { verdict: "differs", reason: "kind" };

  // Two symlinks are compared by what they point at, never by following them.
  // Following would compare whatever is at the other end — which may be outside
  // the roots the guard validated, and may be a different file on each host
  // under the same link.
  if (a.kind === "symlink") {
    if (a.linkTarget === undefined || b.linkTarget === undefined) {
      // The driver could not read one of them. Saying "identical" here would be
      // a claim about two strings we do not have.
      return { verdict: "inconclusive", reason: "link" };
    }
    return a.linkTarget === b.linkTarget
      ? { verdict: "identical", reason: "link" }
      : { verdict: "differs", reason: "link" };
  }

  if (a.size !== b.size) return { verdict: "differs", reason: "size" };
  if (a.mtimeMs !== b.mtimeMs) return { verdict: "differs", reason: "mtime" };

  // Same name, same size, same mtime. Almost certainly the same file, and
  // "almost certainly" is not a verdict — see the header.
  return { verdict: "inconclusive", reason: "hash" };
}

/**
 * Whether a checksum could settle this row.
 *
 * Only where levels 1 and 2 came back with nothing, which is the ticket's rule
 * for what level 3 is allowed to cost. A row that differs by mtime is already
 * settled; hashing it would be spending a host's disk to re-answer a question
 * the listing answered for free.
 */
export function needsHash(entry: CompareEntry): boolean {
  return (
    entry.verdict === "inconclusive" && entry.reason === "hash" && entry.a?.kind === "file" && entry.b?.kind === "file"
  );
}

/** Rows a checksum would settle, as the paths each side would be asked for. */
export function hashablePaths(
  entries: readonly CompareEntry[],
  rootA: string,
  rootB: string,
): { a: string[]; b: string[] } {
  const hashable = entries.filter(needsHash);
  return {
    a: hashable.map((entry) => posix.join(rootA, entry.path)),
    b: hashable.map((entry) => posix.join(rootB, entry.path)),
  };
}

function push(walk: CompareWalk, ceiling: number, entry: CompareEntry): void {
  if (walk.entries.length >= ceiling) {
    walk.truncated = true;
    return;
  }
  walk.entries.push(entry);
}

function index(entries: readonly FileEntry[]): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const entry of entries) map.set(entry.name, entry);
  return map;
}

function factsOf(entry: FileEntry): SideFacts {
  return {
    kind: entry.kind,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ...(entry.linkTarget === undefined ? {} : { linkTarget: entry.linkTarget }),
  };
}

async function listOrNull(list: (path: string) => Promise<FileEntry[]>, path: string): Promise<FileEntry[] | null> {
  try {
    return await list(path);
  } catch {
    return null;
  }
}
