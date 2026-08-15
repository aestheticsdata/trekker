import { posix } from "node:path";
import type { DuRecord } from "@scans/du-parse";
import {
  MAX_ENTRIES,
  MAX_PARENTS,
  MAX_PATHS_PER_SIZE,
  MAX_SIZE_KEYS,
  MIN_CHILD_SHARE,
  MIN_DUP_BYTES,
  OLD_FILE_AGE_MS,
  TOP_PER_PARENT,
} from "@scans/scan-limits";

/**
 * A stream of `du` records, folded into a treemap and three facts (TRE-32).
 *
 * No driver, no Prisma, no clock of its own — everything it needs arrives
 * through `add()` or the constructor. That is what makes the one part of this
 * ticket with real arithmetic in it testable against a synthetic ten-million
 * record stream in a unit spec, rather than only against a real filesystem.
 *
 * **Post-order is the whole design.** `du` prints every child before the
 * directory that holds it, and the root last. Three things follow, and the
 * aggregator would need a completely different shape without any of them:
 *
 *   1. The last record is the authoritative total — the number `du -sh` prints.
 *      Success is "the root record arrived", never an exit code.
 *   2. A directory's own record arriving means its children are all in, so a
 *      parent can be closed the moment it is seen.
 *   3. A record is a directory exactly when the record before it was one of its
 *      children. That is an O(1) test on the previous path and needs no set of
 *      every directory in the tree.
 *
 * The exception to (3) is an **empty** directory, which prints alone and is
 * therefore taken for a file. Left alone deliberately: it reports zero or one
 * block, so it can never be the largest file, it is below the duplicate
 * threshold by three orders of magnitude, and `sha256sum` refuses a directory
 * anyway. It contributes one entry to the old-file count when it is old, which
 * is the entire consequence and is not worth a round trip per empty directory
 * to prevent.
 *
 * **Every bound reports itself.** A tree that outgrew one of them sets
 * `truncated`, and the panel says so. A treemap silently missing its tail is a
 * treemap that answers "what is eating the disk" with a shrug.
 */

export interface AggregatedEntry {
  path: string;
  bytes: bigint;
  parentPath: string;
  depth: number;
  kind: "DIRECTORY" | "FILE" | "OTHER";
}

export interface LargestFile {
  path: string;
  bytes: bigint;
}

export interface DuplicateCandidate {
  bytes: bigint;
  paths: string[];
}

export interface AggregateResult {
  /** Null when no record for the root ever arrived — an incomplete walk. */
  totalBytes: bigint | null;
  /** Inodes `du` counted, or null on a rung that prints only directories. */
  inodes: bigint | null;
  entries: AggregatedEntry[];
  largest: LargestFile | null;
  oldFileCount: bigint;
  oldFileBytes: bigint;
  /** The cutoff the count was taken against. */
  oldFileBefore: Date;
  /** Groups of files sharing a size, worth hashing. Ranked, not yet confirmed. */
  duplicateCandidates: DuplicateCandidate[];
  /** Candidate groups a bound stopped us from even considering. */
  duplicatesDropped: number;
  truncated: boolean;
}

interface Parent {
  bytes: bigint;
  depth: number;
  /** Descending by bytes, at most TOP_PER_PARENT. */
  top: AggregatedEntry[];
}

export interface AggregatorOptions {
  root: string;
  /** Levels of tree to keep. See `DiskScans.depth`. */
  depth: number;
  /** Records carry an mtime, so the age fact can be gathered. */
  hasTime: boolean;
  /** Records exist for files, so the facts and the inode count mean something. */
  hasFiles: boolean;
  /** The scan's own "now", so "older than a year" is a year before this scan. */
  now: number;
}

export class ScanAggregator {
  private readonly root: string;
  private readonly options: AggregatorOptions;
  private readonly oldest: number;

  /** Parents at depth < `depth`, which are the only ones that get a level. */
  private readonly parents = new Map<string, Parent>();

  private previousPath: string | null = null;
  private rootBytes: bigint | null = null;
  private inodes = 0n;
  private truncated = false;

  private largest: LargestFile | null = null;
  private oldFileCount = 0n;
  private oldFileBytes = 0n;

  private readonly bySize = new Map<bigint, string[]>();
  private duplicatesDropped = 0;

  constructor(options: AggregatorOptions) {
    this.options = options;
    // Normalised once so every depth and parent comparison below is a plain
    // string operation against the same shape `du` prints.
    this.root = normalise(options.root);
    this.oldest = options.now - OLD_FILE_AGE_MS;
  }

  /**
   * One record. Called millions of times, so it holds nothing per record and
   * allocates nothing it does not keep.
   */
  add(record: DuRecord): void {
    const path = normalise(record.path);
    const directory = this.isDirectory(path);
    this.previousPath = path;
    this.inodes += 1n;

    if (path === this.root) {
      this.rootBytes = record.bytes;
      this.closeParent(this.root, record.bytes, 0);
      return;
    }

    const depth = this.depthOf(path);
    // Outside the tree we were asked about. `du -x` should make this
    // impossible, but a record that is not under the root is not something to
    // fold into a total we are going to present as that root's.
    if (depth < 0) return;

    if (!directory) this.recordFacts(path, record);

    // A directory at a depth we keep is a parent whose own level is now
    // complete: its children have all been seen.
    if (directory && depth < this.options.depth) {
      this.closeParent(path, record.bytes, depth);
    }

    // Offered to its parent's level, if that level is one we keep. Deeper
    // records need nothing here — their bytes are already inside an ancestor's
    // subtotal, which is the number the treemap draws.
    if (depth <= this.options.depth) {
      this.offer(posix.dirname(path), depth - 1, {
        path,
        bytes: record.bytes,
        parentPath: posix.dirname(path),
        depth,
        kind: directory ? "DIRECTORY" : "FILE",
      });
    }
  }

  /**
   * The record before this one was one of its children, so this one is a
   * directory. See the header for the empty-directory exception.
   */
  private isDirectory(path: string): boolean {
    if (path === this.root) return true;
    if (this.previousPath === null) return false;
    return posix.dirname(this.previousPath) === path;
  }

  /**
   * Depth below the root: 0 is the root, 1 its children. Negative when the path
   * is not under the root at all.
   */
  private depthOf(path: string): number {
    if (path === this.root) return 0;
    const prefix = this.root === "/" ? "/" : `${this.root}/`;
    if (!path.startsWith(prefix)) return -1;
    const rest = path.slice(prefix.length);
    if (rest.length === 0) return 0;
    let depth = 1;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest.charCodeAt(index) === 47) depth += 1;
    }
    return depth;
  }

  /**
   * Note a parent's own subtotal. Its children may already have been offered —
   * post-order guarantees they were — so this only fills in the number `other`
   * will be computed against.
   */
  private closeParent(path: string, bytes: bigint, depth: number): void {
    const existing = this.parents.get(path);
    if (existing) {
      existing.bytes = bytes;
      return;
    }
    // A childless directory still gets a parent record, so a client that drills
    // into it is told "nothing here" rather than being handed no level at all.
    if (this.parents.size >= MAX_PARENTS) {
      this.truncated = true;
      return;
    }
    this.parents.set(path, { bytes, depth, top: [] });
  }

  /** Offer a child to its parent's top-K. The hot path, and mostly one compare. */
  private offer(parentPath: string, parentDepth: number, entry: AggregatedEntry): void {
    if (parentDepth < 0) return;

    let parent = this.parents.get(parentPath);
    if (!parent) {
      if (this.parents.size >= MAX_PARENTS) {
        this.truncated = true;
        return;
      }
      // Bytes filled in when the parent's own record arrives, which post-order
      // guarantees comes after every one of these.
      parent = { bytes: 0n, depth: parentDepth, top: [] };
      this.parents.set(parentPath, parent);
    }

    const top = parent.top;
    if (top.length >= TOP_PER_PARENT) {
      if (entry.bytes <= top[top.length - 1].bytes) return;
      top.pop();
    }

    let index = top.length;
    while (index > 0 && top[index - 1].bytes < entry.bytes) index -= 1;
    top.splice(index, 0, entry);
  }

  /** The three facts, from a record that is a file. */
  private recordFacts(path: string, record: DuRecord): void {
    if (!this.options.hasFiles) return;

    if (this.largest === null || record.bytes > this.largest.bytes) {
      this.largest = { path, bytes: record.bytes };
    }

    if (this.options.hasTime && record.mtimeMs !== null && record.mtimeMs < this.oldest) {
      this.oldFileCount += 1n;
      this.oldFileBytes += record.bytes;
    }

    if (record.bytes < MIN_DUP_BYTES) return;

    const paths = this.bySize.get(record.bytes);
    if (paths) {
      // A size shared by thousands of files is a build artefact, not a find.
      if (paths.length < MAX_PATHS_PER_SIZE) paths.push(path);
      else this.duplicatesDropped += 1;
      return;
    }
    if (this.bySize.size >= MAX_SIZE_KEYS) {
      // Never evict: dropping a key that already has one member turns a group
      // we would have found into a silent miss, which is worse than a reported
      // one we did not look at.
      this.duplicatesDropped += 1;
      this.truncated = true;
      return;
    }
    this.bySize.set(record.bytes, [path]);
  }

  /**
   * Close the walk and produce the rows.
   *
   * Everything that needs the total happens here, because the total is the last
   * record `du` prints. That includes `MIN_CHILD_SHARE`, which is a fraction of
   * a number nothing knew until now.
   */
  finish(): AggregateResult {
    const total = this.rootBytes;
    const entries: AggregatedEntry[] = [];

    if (total !== null) {
      entries.push({ path: this.root, bytes: total, parentPath: "", depth: 0, kind: "DIRECTORY" });
      this.emitLevels(entries, total);
    }

    return {
      totalBytes: total,
      inodes: this.options.hasFiles ? this.inodes : null,
      entries,
      largest: this.largest,
      oldFileCount: this.oldFileCount,
      oldFileBytes: this.oldFileBytes,
      oldFileBefore: new Date(this.oldest),
      duplicateCandidates: this.rankCandidates(),
      duplicatesDropped: this.duplicatesDropped,
      truncated: this.truncated,
    };
  }

  /**
   * Levels, breadth-first from the root.
   *
   * Breadth-first because that is the order the entry ceiling should bite in:
   * running out of rows must cost the deepest level, never half of a shallow
   * one. A level is emitted whole or not at all, so every level the client
   * receives sums to its parent exactly — a half-emitted level would be a set
   * of rectangles that do not tile, which is the one thing a treemap must not
   * be handed.
   */
  private emitLevels(entries: AggregatedEntry[], total: bigint): void {
    // An index rather than `shift()`: the queue holds up to MAX_PARENTS entries
    // and shifting an array of twenty thousand is quadratic for no reason.
    const queue: string[] = [this.root];
    for (let head = 0; head < queue.length; head += 1) {
      const parentPath = queue[head];
      const parent = this.parents.get(parentPath);
      if (!parent) continue;

      const level = this.levelOf(parent, parentPath, total);
      if (entries.length + level.length > MAX_ENTRIES) {
        this.truncated = true;
        return;
      }

      for (const entry of level) {
        entries.push(entry);
        if (entry.kind === "DIRECTORY" && entry.depth < this.options.depth) queue.push(entry.path);
      }
    }
  }

  /**
   * One parent's rectangles, plus the remainder.
   *
   * **`other` is `du`'s own subtotal minus what we kept, never the sum of what
   * we dropped.** That single choice is what makes a level add up to its parent
   * by construction, and it absorbs — with no special case for any of them —
   * the pruned tail, the children past the top-K, the files sitting directly in
   * the parent, the parent's own directory inode, and any subtree `du` counted
   * as zero because it could not read it.
   */
  private levelOf(parent: Parent, parentPath: string, total: bigint): AggregatedEntry[] {
    const floor = total > 0n ? BigInt(Math.floor(Number(total) * MIN_CHILD_SHARE)) : 0n;
    // Deliberately not `truncated`. Pruning a child into `other` loses nothing:
    // the level still sums to the parent, because `other` is computed by
    // subtraction from the parent's own subtotal. `truncated` is reserved for
    // the bounds that genuinely drop information — MAX_PARENTS, MAX_ENTRIES,
    // MAX_SIZE_KEYS — because a flag that is true for every real tree tells a
    // reader nothing.
    const kept = parent.top.filter((entry) => entry.bytes >= floor);

    let keptBytes = 0n;
    for (const entry of kept) keptBytes += entry.bytes;

    const remainder = parent.bytes - keptBytes;
    // Clamped rather than emitted negative. It should not happen — `du` counts
    // a hardlinked inode once, at its first encounter, so a parent's subtotal
    // is consistent with the children as printed — but a rectangle with
    // negative area is not a thing to hand a client on a maybe.
    if (remainder < 0n) {
      this.truncated = true;
      return kept;
    }
    if (remainder === 0n) return kept;

    return [
      ...kept,
      {
        // No path on the host: this rectangle is an arithmetic result, and the
        // parent's path is what a client needs to label it with.
        path: parentPath,
        bytes: remainder,
        parentPath,
        depth: parent.depth + 1,
        kind: "OTHER",
      },
    ];
  }

  /**
   * Sizes shared by two or more files, best first.
   *
   * Ranked by what confirming them could give back — size times one fewer than
   * the member count — because the hash budget runs out and the groups it
   * spends itself on should be the ones worth reading.
   */
  private rankCandidates(): DuplicateCandidate[] {
    const groups: DuplicateCandidate[] = [];
    for (const [bytes, paths] of this.bySize) {
      if (paths.length < 2) continue;
      groups.push({ bytes, paths });
    }

    groups.sort((left, right) => {
      const gain = right.bytes * BigInt(right.paths.length - 1) - left.bytes * BigInt(left.paths.length - 1);
      return gain > 0n ? 1 : gain < 0n ? -1 : 0;
    });
    return groups;
  }
}

/** `du` prints no trailing slash except on `/` itself; normalise anyway. */
function normalise(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "") || "/";
}
