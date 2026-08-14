import {
  commonParent,
  conflictNote,
  creationOrder,
  decisionFor,
  destinationInsideSource,
  itemFrom,
  numberedName,
  type PlannedItem,
  settlementOrder,
  undecided,
} from "@transfers/transfer-plan";

import type { WalkedEntry } from "@fs/tree-walk";

/**
 * The decisions, without a filesystem (TRE-23 §2).
 *
 * Everything here is the part of a transfer that can be wrong while every
 * socket behaves perfectly: a name that collides, an order that puts a file
 * before its directory, a conflict nobody answered. `transfer.spec.ts` proves
 * the bytes move; this proves the arithmetic that decides where.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function walked(path: string, kind: string, size = 0, mtimeMs = 0): WalkedEntry {
  return { path, kind: kind as WalkedEntry["kind"], size, uid: 0, mode: 0o644, mtimeMs };
}

function item(name: string, kind = "file"): PlannedItem {
  return itemFrom(walked(`/src/${name}`, kind), name, null);
}

describe("where an item goes", () => {
  it("creates directories shallowest first, whatever order the walk gave them", () => {
    // The walk is post-order because a delete needs children before parents.
    // Creating in that order would try to make `a/b/c` before `a`.
    const items = [item("a/b/c", "directory"), item("a", "directory"), item("a/b", "directory"), item("a/b/f.txt")];

    expect(creationOrder(items).map((entry) => entry.name)).toEqual(["a", "a/b", "a/b/c"]);
  });

  it("settles directories deepest first, so a parent's mtime is stamped last", () => {
    // Writing into a directory updates its mtime. Stamping `a` before `a/b` is
    // written would have the write undo the stamp.
    const items = [item("a", "directory"), item("a/b/c", "directory"), item("a/b", "directory")];

    expect(settlementOrder(items).map((entry) => entry.name)).toEqual(["a/b/c", "a/b", "a"]);
  });

  it("counts depth in segments, not characters", () => {
    // `/aaa` and `/a/b` are the same length and not the same depth. Sorting by
    // string length would interleave them and occasionally get it right, which
    // is the worst way for this to be wrong.
    const items = [item("a/b", "directory"), item("aaa", "directory")];
    expect(creationOrder(items).map((entry) => entry.name)).toEqual(["aaa", "a/b"]);
  });

  it("leaves files out of both orderings", () => {
    const items = [item("a", "directory"), item("a/f.txt")];
    expect(creationOrder(items)).toHaveLength(1);
    expect(settlementOrder(items)).toHaveLength(1);
  });
});

describe("what a directory contributes", () => {
  it("counts no bytes for a directory, whatever its inode says", () => {
    // A directory's own size is not data crossing the wire, and counting it
    // would make a transfer's total larger than the bytes it moves — so the
    // progress bar would stop short of 100% on every job with a folder in it.
    const entry = itemFrom(walked("/src/a", "directory", 4096, 0), "a", null);
    expect(entry.bytes).toBe(0);
  });

  it("keeps a file's size", () => {
    const entry = itemFrom(walked("/src/a.txt", "file", 4096, 0), "a.txt", null);
    expect(entry.bytes).toBe(4096);
  });

  it("reads a mode of zero as unknown rather than as 0o000", () => {
    // `describeRoot` in the walk returns `mode: 0` for an entry it could not
    // stat. Stamping that literally would make the copy unreadable to its owner.
    const entry = itemFrom({ ...walked("/src/a.txt", "file"), mode: 0 }, "a.txt", null);
    expect(entry.mode).toBeNull();
  });
});

describe("a directory arriving on something", () => {
  const dir = (target: { size: number; mtimeMs: number; kind?: string } | null) =>
    itemFrom(walked("/src/tree", "directory", 96, 1_000), "tree", target);

  it("merges into a directory rather than asking about it", () => {
    // Every answer would be wrong. "Overwrite" a folder would have to mean
    // deleting its contents; "keep both" would have to rename it, and every
    // path underneath was decided before the question was asked. The files
    // inside it are the real questions and each gets its own row.
    const entry = dir({ size: 128, mtimeMs: 2_000, kind: "directory" });
    expect(entry.conflict).toBe(false);
    expect(entry.note).toBe("already there — its contents merge, file by file");
  });

  it("still reports what is there, so a client is not told the folder is absent", () => {
    expect(dir({ size: 128, mtimeMs: 2_000, kind: "directory" }).target).not.toBeNull();
  });

  it("does conflict with a file of the same name", () => {
    const entry = dir({ size: 12, mtimeMs: 2_000, kind: "file" });
    expect(entry.conflict).toBe(true);
    expect(entry.note).toBe("a file of that name is in the way");
  });

  it("never compares sizes or ages, which mean nothing about a folder", () => {
    // It rendered "identical size · target is 20 min newer" on a directory
    // before this, which is two facts about two inodes and no help to anybody.
    expect(dir({ size: 96, mtimeMs: 1_000, kind: "directory" }).note).not.toContain("size");
    expect(dir(null).note).toBe("");
  });
});

describe("the conflict line", () => {
  const now = 1_700_000_000_000;

  it("says nothing when there is nothing at the destination", () => {
    expect(conflictNote({ size: 10, mtimeMs: now }, null)).toBe("");
  });

  it("names an identical size", () => {
    expect(conflictNote({ size: 10, mtimeMs: now }, { size: 10, mtimeMs: now })).toBe("identical size");
  });

  it("names the difference and which way it goes", () => {
    const bigger = conflictNote({ size: 2 * 1024 ** 2, mtimeMs: now }, { size: 1024 ** 2, mtimeMs: now });
    const smaller = conflictNote({ size: 1024 ** 2, mtimeMs: now }, { size: 2 * 1024 ** 2, mtimeMs: now });

    expect(bigger).toBe("+1.0 MB vs target");
    // A minus sign, not a hyphen: this is a number, and the row is read.
    expect(smaller).toBe("−1.0 MB vs target");
  });

  it("compares the two ages against each other, not against now", () => {
    // "target is 3 d old" describes the file. "target is 3 d older" describes
    // the choice, and the choice is what the row exists to help with.
    expect(conflictNote({ size: 1, mtimeMs: now }, { size: 1, mtimeMs: now - 3 * DAY })).toContain(
      "target is 3 d older",
    );
    expect(conflictNote({ size: 1, mtimeMs: now }, { size: 1, mtimeMs: now + 3 * DAY })).toContain(
      "target is 3 d newer",
    );
  });

  it("says nothing about an age difference under a minute", () => {
    // Two files written in the same minute are the same age, and a row saying
    // "target is 0 min older" is noise on the line that matters most.
    expect(conflictNote({ size: 1, mtimeMs: now }, { size: 1, mtimeMs: now - 30_000 })).toBe("identical size");
  });
});

describe("the answers", () => {
  it("leaves a non-conflicting item undecided, whatever the strategy says", () => {
    // ASK means "nobody was asked", and nobody was: there is nothing there.
    for (const strategy of ["ask", "overwrite", "skip", "keepBoth"] as const) {
      expect(decisionFor(strategy, undefined, false)).toBe("ASK");
    }
  });

  it("maps each strategy to its decision", () => {
    expect(decisionFor("overwrite", undefined, true)).toBe("OVERWRITE");
    expect(decisionFor("skip", undefined, true)).toBe("SKIP");
    expect(decisionFor("keepBoth", undefined, true)).toBe("RENAME");
    expect(decisionFor("ask", undefined, true)).toBe("ASK");
  });

  it("lets a row override the blanket answer in both directions", () => {
    expect(decisionFor("overwrite", "skip", true)).toBe("SKIP");
    expect(decisionFor("skip", "overwrite", true)).toBe("OVERWRITE");
    // The case the modal's "ask" default is for: one row answered, the rest not.
    expect(decisionFor("ask", "keepBoth", true)).toBe("RENAME");
  });

  it("finds exactly the conflicting rows nobody answered", () => {
    const items = [
      itemFrom(walked("/src/a", "file", 1), "a", { size: 1, mtimeMs: 0 }),
      itemFrom(walked("/src/b", "file", 1), "b", null),
      itemFrom(walked("/src/c", "file", 1), "c", { size: 1, mtimeMs: 0 }),
    ];

    // `b` carries ASK because it does not conflict, and must not be counted.
    expect(undecided(items, ["ASK", "ASK", "OVERWRITE"]).map((entry) => entry.name)).toEqual(["a"]);
    expect(undecided(items, ["OVERWRITE", "ASK", "SKIP"])).toEqual([]);
  });
});

describe("keeping both", () => {
  it("numbers before the extension, so the file still opens", () => {
    expect(numberedName("report.txt", 2)).toBe("report (2).txt");
  });

  it("leaves a dotfile's leading dot alone", () => {
    expect(numberedName(".bashrc", 2)).toBe(".bashrc (2)");
  });
});

describe("what a transfer refuses before it starts", () => {
  it("insists everything comes from one directory", () => {
    expect(commonParent(["/a/x", "/a/y"])).toBe("/a");
    // Two directories have no common root that is not `/`, and rebuilding a
    // destination from `/` would recreate the whole path spine underneath it.
    expect(commonParent(["/a/x", "/b/y"])).toBeNull();
    expect(commonParent([])).toBeNull();
  });

  it("treats a top-level selection as living in the root", () => {
    expect(commonParent(["/srv"])).toBe("/");
  });

  it("spots a destination inside the source", () => {
    expect(destinationInsideSource("/a/b", "/a/b/c")).toBe(true);
    expect(destinationInsideSource("/a/b", "/a/b")).toBe(true);
    expect(destinationInsideSource("/a/b", "/a/b/")).toBe(true);
  });

  it("does not mistake a sibling with a shared prefix for a descendant", () => {
    // The `/data` versus `/database` mistake, which is the reason this is a
    // segment-wise test rather than a `startsWith`.
    expect(destinationInsideSource("/a/data", "/a/database")).toBe(false);
    expect(destinationInsideSource("/a/b", "/a/c")).toBe(false);
  });
});
