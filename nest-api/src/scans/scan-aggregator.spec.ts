import type { DuRecord } from "@scans/du-parse";
import { type AggregatedEntry, type AggregateResult, ScanAggregator } from "@scans/scan-aggregator";
import { MAX_PARENTS, MIN_DUP_BYTES, OLD_FILE_AGE_MS, TOP_PER_PARENT } from "@scans/scan-limits";

/**
 * The treemap's arithmetic (TRE-32).
 *
 * This is the one part of the ticket where being wrong is invisible. A parsing
 * mistake shows up as an empty panel; a mistake here shows up as a perfectly
 * drawn treemap whose rectangles do not add up to the disk — and nobody
 * checks, because checking means adding up twenty rectangles by hand.
 *
 * So the property nearly every case below asserts is the same one: **each
 * level sums to its parent's own subtotal, `other` included**. That is what
 * makes the picture true, and it is what "the treemap aggregation sums to the
 * scanned total" means in the ticket's Done list.
 */

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const OLD = NOW - OLD_FILE_AGE_MS - 86_400_000;
const RECENT = NOW - 86_400_000;

/**
 * Records as `du` emits them: **post-order**, children before the directory
 * that holds them, root last. Every fixture here keeps that order because the
 * aggregator's directory detection depends on it, and a fixture in a different
 * order would be testing something no `du` produces.
 */
function record(path: string, bytes: number | bigint, mtimeMs: number | null = RECENT): DuRecord {
  return { path, bytes: BigInt(bytes), mtimeMs };
}

function aggregate(records: readonly DuRecord[], options: Partial<{ root: string; depth: number }> = {}) {
  const aggregator = new ScanAggregator({
    root: options.root ?? "/srv",
    depth: options.depth ?? 3,
    hasTime: true,
    hasFiles: true,
    now: NOW,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

/** Every entry whose parent is `at`, which is one treemap level. */
function level(result: AggregateResult, at: string): AggregatedEntry[] {
  return result.entries.filter((entry) => entry.parentPath === at);
}

function sum(entries: readonly AggregatedEntry[]): bigint {
  return entries.reduce((total, entry) => total + entry.bytes, 0n);
}

function byPath(result: AggregateResult, path: string): AggregatedEntry | undefined {
  return result.entries.find((entry) => entry.path === path && entry.kind !== "OTHER");
}

/**
 * A small tree, in the exact shape and order `du -a` prints it. Verified
 * against a real BSD `du` before being written down:
 *
 *   0   /srv/empty
 *   8   /srv/a/deep/f3        4   /srv/a/deep
 *   16  /srv/a/f1             24  /srv/a
 *   8   /srv/top.txt
 *   16  /srv/b/f2             16  /srv/b
 *   48  /srv
 */
const SMALL: DuRecord[] = [
  record("/srv/empty", 0),
  record("/srv/a/deep/f3", 100),
  record("/srv/a/deep", 100),
  record("/srv/a/f1", 5_000),
  record("/srv/a", 5_100),
  record("/srv/top.txt", 20),
  record("/srv/b/f2", 5_000),
  record("/srv/b", 5_000),
  record("/srv", 10_200),
];

describe("the total", () => {
  it("is the root's own record, which du prints last", () => {
    expect(aggregate(SMALL).totalBytes).toBe(10_200n);
  });

  it("is null when the walk never reached the root", () => {
    // A cancelled or truncated walk. Nothing may be presented as a finished
    // scan, because the number that would head it never arrived.
    const partial = aggregate(SMALL.slice(0, 4));
    expect(partial.totalBytes).toBeNull();
    expect(partial.entries).toEqual([]);
  });
});

describe("a level", () => {
  it("sums to its parent, other included", () => {
    const result = aggregate(SMALL);
    expect(sum(level(result, "/srv"))).toBe(10_200n);
  });

  it("sums to its parent at every depth", () => {
    const result = aggregate(SMALL);
    for (const entry of result.entries) {
      if (entry.kind !== "DIRECTORY") continue;
      const children = level(result, entry.path);
      if (children.length === 0) continue;
      expect(sum(children)).toBe(entry.bytes);
    }
  });

  it("takes other from du's subtotal, not from the children it dropped", () => {
    // `/srv` holds 10_200 and its four children account for 10_120 — the
    // remaining 80 is the directory's own inode, which no child record
    // describes. Summing the children we dropped would report 0 for `other`
    // and leave the level 80 bytes short of the disk, drawn as a treemap that
    // looks entirely fine.
    const result = aggregate(SMALL);
    const other = level(result, "/srv").find((entry) => entry.kind === "OTHER");
    expect(other?.bytes).toBe(80n);
  });

  it("omits other entirely when the children account for all of it", () => {
    const exact: DuRecord[] = [record("/srv/a/f1", 900), record("/srv/a", 900), record("/srv", 900)];
    const result = aggregate(exact);
    expect(level(result, "/srv").some((entry) => entry.kind === "OTHER")).toBe(false);
    expect(sum(level(result, "/srv"))).toBe(900n);
  });
});

describe("directory detection", () => {
  it("reads post-order rather than statting anything", () => {
    const result = aggregate(SMALL);
    expect(byPath(result, "/srv/a")?.kind).toBe("DIRECTORY");
    expect(byPath(result, "/srv/b")?.kind).toBe("DIRECTORY");
    expect(byPath(result, "/srv/a/f1")?.kind).toBe("FILE");
    expect(byPath(result, "/srv/top.txt")?.kind).toBe("FILE");
  });

  it("takes an empty directory for a file", () => {
    // Documented behaviour, asserted so that changing the rule is a deliberate
    // act. An empty directory prints alone, so nothing in the stream says it
    // was a directory — the record before it is not one of its children,
    // because it has none.
    //
    // On ext4 that is one block rather than the nothing APFS reports, which is
    // why the fixture uses 4096: the consequence is real but small. It cannot
    // be confirmed as a duplicate (`sha256sum` refuses a directory) and it
    // loses the largest-file comparison to any actual large file.
    const tree: DuRecord[] = [record("/srv/hollow", 4_096), record("/srv/real.bin", 900_000), record("/srv", 908_192)];
    const result = aggregate(tree);

    expect(byPath(result, "/srv/hollow")?.kind).toBe("FILE");
    expect(result.largest).toEqual({ path: "/srv/real.bin", bytes: 900_000n });
  });
});

describe("depth", () => {
  it("keeps levels down to the cap and no further", () => {
    const deep: DuRecord[] = [
      record("/srv/a/b/c/d/deep.bin", 4_000),
      record("/srv/a/b/c/d", 4_000),
      record("/srv/a/b/c", 4_000),
      record("/srv/a/b", 4_000),
      record("/srv/a", 4_000),
      record("/srv", 4_000),
    ];
    const result = aggregate(deep, { depth: 2 });

    expect(result.entries.map((entry) => entry.path)).toEqual(["/srv", "/srv/a", "/srv/a/b"]);
    expect(result.entries.every((entry) => entry.depth <= 2)).toBe(true);
  });

  it("still counts what it does not store", () => {
    // The bytes under the cap are inside their ancestor's subtotal, which is
    // the number the rectangle is drawn from. Depth bounds the rows, never the
    // arithmetic.
    const deep: DuRecord[] = [
      record("/srv/a/b/c/big.bin", 9_000),
      record("/srv/a/b/c", 9_000),
      record("/srv/a/b", 9_000),
      record("/srv/a", 9_000),
      record("/srv", 9_000),
    ];
    expect(aggregate(deep, { depth: 1 }).totalBytes).toBe(9_000n);
    expect(byPath(aggregate(deep, { depth: 1 }), "/srv/a")?.bytes).toBe(9_000n);
  });
});

describe("top-K per parent", () => {
  it("keeps the biggest, not the first seen", () => {
    const children: DuRecord[] = [];
    let total = 0n;
    // Ascending, so arrival order is the exact reverse of size order.
    for (let index = 1; index <= TOP_PER_PARENT + 10; index += 1) {
      const bytes = BigInt(index) * 1_000_000n;
      children.push(record(`/srv/d${String(index).padStart(3, "0")}`, bytes));
      total += bytes;
    }
    children.push(record("/srv", total));

    const result = aggregate(children);
    const kept = level(result, "/srv").filter((entry) => entry.kind !== "OTHER");

    expect(kept).toHaveLength(TOP_PER_PARENT);
    expect(kept[0].bytes).toBe(BigInt(TOP_PER_PARENT + 10) * 1_000_000n);
    // And the level still closes: everything not kept is in `other`.
    expect(sum(level(result, "/srv"))).toBe(total);
  });
});

describe("the three facts", () => {
  it("finds the largest file, never a directory", () => {
    const result = aggregate(SMALL);
    // `/srv/a` holds 5_100 and is bigger than any file in the tree; the largest
    // *file* is `/srv/a/f1` at 5_000.
    expect(result.largest).toEqual({ path: "/srv/a/f1", bytes: 5_000n });
  });

  it("counts files older than a year, by the scan's own clock", () => {
    const tree: DuRecord[] = [
      record("/srv/old.bin", 3_000, OLD),
      record("/srv/new.bin", 4_000, RECENT),
      record("/srv/older.bin", 1_000, OLD),
      record("/srv", 8_000),
    ];
    const result = aggregate(tree);

    expect(result.oldFileCount).toBe(2n);
    expect(result.oldFileBytes).toBe(4_000n);
    // The cutoff is stored, so "older than a year" keeps meaning a year before
    // this scan rather than a year before somebody opening the panel.
    expect(result.oldFileBefore.getTime()).toBe(NOW - OLD_FILE_AGE_MS);
  });

  it("groups duplicate candidates by size and ignores the small ones", () => {
    const big = MIN_DUP_BYTES * 2n;
    const tree: DuRecord[] = [
      record("/srv/a.iso", big),
      record("/srv/b.iso", big),
      record("/srv/c.iso", big + 1n),
      // Two identical small files: below the threshold, so not worth a hash.
      record("/srv/x.txt", 4_096),
      record("/srv/y.txt", 4_096),
      record("/srv", big * 3n),
    ];
    const result = aggregate(tree);

    expect(result.duplicateCandidates).toHaveLength(1);
    expect(result.duplicateCandidates[0]).toEqual({ bytes: big, paths: ["/srv/a.iso", "/srv/b.iso"] });
  });

  it("ranks candidates by what confirming them would give back", () => {
    const small = MIN_DUP_BYTES;
    const large = MIN_DUP_BYTES * 10n;
    const tree: DuRecord[] = [
      // Three copies of a small file: 2 × 1 MiB reclaimable.
      record("/srv/s1", small),
      record("/srv/s2", small),
      record("/srv/s3", small),
      // Two copies of a large one: 1 × 10 MiB reclaimable, so this ranks first.
      record("/srv/l1", large),
      record("/srv/l2", large),
      record("/srv", small * 3n + large * 2n),
    ];
    const result = aggregate(tree);

    expect(result.duplicateCandidates.map((group) => group.bytes)).toEqual([large, small]);
  });
});

describe("the bounds", () => {
  it("says so when it ran out of parents", () => {
    const records: DuRecord[] = [];
    let total = 0n;
    // Each directory is its own parent, so this outgrows MAX_PARENTS directly.
    for (let index = 0; index < MAX_PARENTS + 50; index += 1) {
      records.push(record(`/srv/d${index}/f`, 1_000));
      records.push(record(`/srv/d${index}`, 1_000));
      total += 1_000n;
    }
    records.push(record("/srv", total));

    const result = aggregate(records, { depth: 3 });
    expect(result.truncated).toBe(true);
    // And the level it did produce still closes against the root.
    expect(sum(level(result, "/srv"))).toBe(total);
  });

  it("is not truncated by ordinary pruning", () => {
    // Dropping a child into `other` loses nothing — the level still sums — so a
    // flag that fired on it would be true for every real tree and worth nothing.
    const children: DuRecord[] = [];
    let total = 0n;
    for (let index = 1; index <= TOP_PER_PARENT + 40; index += 1) {
      const bytes = BigInt(index) * 1_000_000n;
      children.push(record(`/srv/d${index}`, bytes));
      total += bytes;
    }
    children.push(record("/srv", total));

    expect(aggregate(children).truncated).toBe(false);
  });
});

describe("the root", () => {
  it("is its own row, parented to nothing", () => {
    const result = aggregate(SMALL);
    const root = result.entries[0];
    expect(root).toMatchObject({ path: "/srv", parentPath: "", depth: 0, kind: "DIRECTORY" });
    // Empty string rather than "/srv": parenting the root to itself would have
    // the level query return it as its own child.
    expect(level(result, "/srv").some((entry) => entry.path === "/srv" && entry.kind === "DIRECTORY")).toBe(false);
  });

  it("works when the root is / itself", () => {
    const tree: DuRecord[] = [record("/etc/hosts", 2_000), record("/etc", 2_000), record("/", 3_000)];
    const result = aggregate(tree, { root: "/" });

    expect(result.totalBytes).toBe(3_000n);
    expect(byPath(result, "/etc")?.depth).toBe(1);
    expect(sum(level(result, "/"))).toBe(3_000n);
  });

  it("ignores a record that is not under the root at all", () => {
    const tree: DuRecord[] = [record("/other/thing", 9_999), record("/srv/a", 1_000), record("/srv", 1_000)];
    const result = aggregate(tree);

    expect(result.totalBytes).toBe(1_000n);
    expect(byPath(result, "/other/thing")).toBeUndefined();
  });
});

describe("inodes", () => {
  it("counts every record the walk produced", () => {
    expect(aggregate(SMALL).inodes).toBe(BigInt(SMALL.length));
  });

  it("is null on a rung that prints no files, where the count would mean directories", () => {
    const aggregator = new ScanAggregator({ root: "/srv", depth: 3, hasTime: false, hasFiles: false, now: NOW });
    for (const item of SMALL) aggregator.add(item);
    const result = aggregator.finish();

    expect(result.inodes).toBeNull();
    expect(result.largest).toBeNull();
    expect(result.oldFileCount).toBe(0n);
  });
});
