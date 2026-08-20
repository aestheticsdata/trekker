import { MAX_UNREADABLE_NAMED } from "@compare/compare-limits";
import { type CompareEntry, compareTrees, decide, hashablePaths, needsHash } from "@compare/compare-tree";

import type { FileEntry } from "@hosts/drivers/host-driver";

/**
 * The paired walk and its verdicts (TRE-28 §1).
 *
 * What makes this worth testing exhaustively is that every wrong answer here is
 * a *confident* one. "These two directories match" is the sentence somebody
 * reads before deleting the second copy, or before deciding a deploy landed —
 * so the case that matters most is not the one where it reports a difference
 * that is not there, but the one where it reports agreement it never checked.
 *
 * Hence the shape of half of these: a bound that bit, a directory that could
 * not be listed, a pair only a checksum could separate. Each has to be visible
 * in the answer rather than rounded down to "no differences found".
 */

/** A host as a path → children map. A path missing from it cannot be listed. */
type Tree = Record<string, FileEntry[]>;

function file(name: string, size = 10, mtimeMs = 1_000): FileEntry {
  return { name, kind: "file", size, mode: 0o644, uid: 0, gid: 0, mtimeMs };
}

function dir(name: string): FileEntry {
  return { name, kind: "directory", size: 4096, mode: 0o755, uid: 0, gid: 0, mtimeMs: 1_000 };
}

function link(name: string, linkTarget?: string): FileEntry {
  return {
    name,
    kind: "symlink",
    size: 8,
    mode: 0o777,
    uid: 0,
    gid: 0,
    mtimeMs: 1_000,
    ...(linkTarget ? { linkTarget } : {}),
  };
}

function listerFor(tree: Tree) {
  return (path: string): Promise<FileEntry[]> => {
    const children = tree[path];
    if (!children) return Promise.reject(new Error(`cannot list ${path}`));
    return Promise.resolve(children);
  };
}

function run(a: Tree, b: Tree, options: { depth?: number; ceiling?: number } = {}) {
  return compareTrees({
    rootA: "/a",
    rootB: "/b",
    listA: listerFor(a),
    listB: listerFor(b),
    depth: options.depth ?? 3,
    ceiling: options.ceiling ?? 100,
  });
}

/** The row for one relative path, or undefined. */
function at(entries: readonly CompareEntry[], path: string): CompareEntry | undefined {
  return entries.find((entry) => entry.path === path);
}

describe("level 1: a name on one side", () => {
  it("reports what only the left root holds", async () => {
    const walk = await run({ "/a": [file("kept"), file("extra")] }, { "/b": [file("kept")] });

    expect(at(walk.entries, "extra")).toMatchObject({ verdict: "onlyA", reason: "name" });
  });

  it("reports what only the right root holds", async () => {
    const walk = await run({ "/a": [file("kept")] }, { "/b": [file("kept"), file("extra")] });

    expect(at(walk.entries, "extra")).toMatchObject({ verdict: "onlyB", reason: "name" });
  });

  it("carries the facts of whichever side has it", async () => {
    // The modal shows both sides' size and date, and the missing side has to be
    // visibly missing rather than zero.
    const walk = await run({ "/a": [file("extra", 4_096, 900)] }, { "/b": [] });

    expect(at(walk.entries, "extra")).toMatchObject({
      a: { kind: "file", size: 4_096, mtimeMs: 900 },
      b: null,
    });
  });

  it("does not descend into a directory only one side has", async () => {
    // Everything under it is only on that side too, so listing it would be one
    // row per file saying the same thing the directory's row already says —
    // and "copy A→B" on that one row is the whole subtree, which is right.
    const walk = await run({ "/a": [dir("only")], "/a/only": [file("one"), file("two")] }, { "/b": [] });

    expect(walk.entries).toHaveLength(1);
    expect(walk.entries[0]).toMatchObject({ path: "only", verdict: "onlyA" });
  });
});

describe("level 2: what a listing already knows", () => {
  it("calls a different size a difference", async () => {
    const walk = await run({ "/a": [file("x", 10)] }, { "/b": [file("x", 20)] });

    expect(at(walk.entries, "x")).toMatchObject({ verdict: "differs", reason: "size" });
  });

  it("calls a different mtime a difference, and says that is what it was", async () => {
    // The reason is the useful half. "Differs" on its own reads as drift; "the
    // mtime differs" reads as a copy somebody made without preserving it, which
    // is a different thing to do about.
    const walk = await run({ "/a": [file("x", 10, 1_000)] }, { "/b": [file("x", 10, 2_000)] });

    expect(at(walk.entries, "x")).toMatchObject({ verdict: "differs", reason: "mtime" });
  });

  it("calls a file against a directory a difference of kind", async () => {
    const walk = await run({ "/a": [file("x")] }, { "/b": [dir("x")], "/b/x": [] });

    expect(at(walk.entries, "x")).toMatchObject({ verdict: "differs", reason: "kind" });
  });

  it("never descends into a name that is a directory on one side only", async () => {
    const walk = await run({ "/a": [file("x")] }, { "/b": [dir("x")], "/b/x": [file("inside")] });

    expect(walk.entries.map((entry) => entry.path)).toEqual(["x"]);
  });
});

describe("symlinks", () => {
  it("compares two links by what they point at, never by following them", async () => {
    // Following would compare whatever is at the other end — which may be
    // outside the roots the guard validated, and may be a different file on
    // each host under the same link.
    const walk = await run({ "/a": [link("l", "/etc/hosts")] }, { "/b": [link("l", "/etc/hosts")] });

    expect(at(walk.entries, "l")).toMatchObject({ verdict: "identical", reason: "link" });
  });

  it("reports two links pointing elsewhere as differing", async () => {
    const walk = await run({ "/a": [link("l", "/one")] }, { "/b": [link("l", "/two")] });

    expect(at(walk.entries, "l")).toMatchObject({ verdict: "differs", reason: "link" });
  });

  it("will not claim two links match when it could not read one of them", async () => {
    const walk = await run({ "/a": [link("l", "/one")] }, { "/b": [link("l")] });

    expect(at(walk.entries, "l")).toMatchObject({ verdict: "inconclusive", reason: "link" });
  });
});

describe("level 3: what only a checksum can settle", () => {
  it("will not call two files identical on size and mtime alone", async () => {
    // The claim this whole verdict exists to avoid. Two files agreeing about
    // everything a listing knows are *probably* the same, and "probably" is not
    // what somebody deleting the second copy is reading.
    const walk = await run({ "/a": [file("x", 10, 1_000)] }, { "/b": [file("x", 10, 1_000)] });

    expect(at(walk.entries, "x")).toMatchObject({ verdict: "inconclusive", reason: "hash" });
  });

  it("marks exactly those rows as worth hashing", async () => {
    const walk = await run(
      { "/a": [file("same", 10, 1), file("bigger", 10, 1), file("later", 10, 1)] },
      { "/b": [file("same", 10, 1), file("bigger", 20, 1), file("later", 10, 9)] },
    );

    // Only the pair nothing cheap could separate. A row that differs by mtime
    // is already settled, and hashing it would spend a host's disk re-answering
    // a question the listing answered for free.
    expect(walk.entries.filter(needsHash).map((entry) => entry.path)).toEqual(["same"]);
  });

  it("offers the two absolute paths a hash pass would ask for, in step", async () => {
    const walk = await run(
      { "/a": [dir("sub")], "/a/sub": [file("x")] },
      { "/b": [dir("sub")], "/b/sub": [file("x")] },
    );

    expect(hashablePaths(walk.entries, "/a", "/b")).toEqual({ a: ["/a/sub/x"], b: ["/b/sub/x"] });
  });

  it("does not offer a directory to be hashed", async () => {
    const walk = await run({ "/a": [dir("only")], "/a/only": [] }, { "/b": [] });

    expect(hashablePaths(walk.entries, "/a", "/b")).toEqual({ a: [], b: [] });
  });
});

describe("recursion", () => {
  it("descends into directories both sides have, and names rows by relative path", async () => {
    const walk = await run(
      { "/a": [dir("sub")], "/a/sub": [file("deep", 1)] },
      { "/b": [dir("sub")], "/b/sub": [file("deep", 2)] },
    );

    expect(at(walk.entries, "sub/deep")).toMatchObject({ verdict: "differs", reason: "size", depth: 2 });
  });

  it("gives a shared directory no row of its own", async () => {
    // Its own row would be a verdict about a name rather than about anything
    // inside it, and the rows underneath say what actually differs.
    const walk = await run(
      { "/a": [dir("sub")], "/a/sub": [file("deep")] },
      { "/b": [dir("sub")], "/b/sub": [file("deep")] },
    );

    expect(walk.entries.map((entry) => entry.path)).toEqual(["sub/deep"]);
  });

  it("stops at the depth bound and says a directory went unopened", async () => {
    // The failure this prevents: a subtree nothing looked at, reported as no
    // differences found.
    const walk = await run(
      { "/a": [dir("one")], "/a/one": [dir("two")], "/a/one/two": [file("deep", 1)] },
      { "/b": [dir("one")], "/b/one": [dir("two")], "/b/one/two": [file("deep", 2)] },
      { depth: 2 },
    );

    expect(at(walk.entries, "one/two")).toMatchObject({ verdict: "inconclusive", reason: "depth" });
    expect(walk.truncated).toBe(true);
  });

  it("orders rows by name within each directory", async () => {
    const walk = await run({ "/a": [file("b"), file("a"), dir("c")], "/a/c": [file("z")] }, { "/b": [], "/b/c": [] });

    expect(walk.entries.map((entry) => entry.path)).toEqual(["a", "b", "c"]);
  });
});

describe("the bounds", () => {
  it("stops at the entry ceiling and says so", async () => {
    const many = Array.from({ length: 50 }, (_, index) => file(`f${index}`));
    const walk = await run({ "/a": many }, { "/b": [] }, { ceiling: 10 });

    expect(walk.entries).toHaveLength(10);
    expect(walk.truncated).toBe(true);
  });

  it("does not claim truncation when everything fitted", async () => {
    const walk = await run({ "/a": [file("x", 1)] }, { "/b": [file("x", 2)] });

    expect(walk.truncated).toBe(false);
  });
});

describe("a directory that will not open", () => {
  it("records the side that refused and keeps going", async () => {
    // A tree with one closed subdirectory still has a useful answer, and
    // refusing to give one would make this unusable on the machines it is most
    // wanted on.
    const walk = await run(
      { "/a": [dir("closed"), file("fine", 1)], "/a/closed": [file("hidden")] },
      { "/b": [dir("closed"), file("fine", 2)] },
    );

    expect(walk.unreadableCount).toBe(1);
    expect(walk.unreadable).toEqual(["closed"]);
    expect(at(walk.entries, "fine")).toMatchObject({ verdict: "differs" });
  });

  it("treats one unreadable side as everything being only on the other", async () => {
    const walk = await run({ "/a": [dir("d")], "/a/d": [file("x")] }, { "/b": [dir("d")] });

    expect(at(walk.entries, "d/x")).toMatchObject({ verdict: "onlyA" });
  });

  it("counts every refusal but names only the first few", async () => {
    // Four hundred closed directories have one useful fact in them — the
    // number — and four hundred paths is not a second one.
    const children = Array.from({ length: MAX_UNREADABLE_NAMED + 5 }, (_, index) => dir(`d${index}`));
    const walk = await run({ "/a": [...children] }, { "/b": [...children] }, { ceiling: 500 });

    expect(walk.unreadableCount).toBe((MAX_UNREADABLE_NAMED + 5) * 2);
    expect(walk.unreadable).toHaveLength(MAX_UNREADABLE_NAMED);
  });

  it("says nothing at all about a directory neither side would list", async () => {
    const walk = await run({ "/a": [dir("d")] }, { "/b": [dir("d")] });

    expect(walk.entries).toEqual([]);
    expect(walk.unreadableCount).toBe(2);
  });
});

describe("the pair rule on its own", () => {
  const cases: Array<[string, FileEntry | null, FileEntry | null, string, string]> = [
    ["only A", file("x"), null, "onlyA", "name"],
    ["only B", null, file("x"), "onlyB", "name"],
    ["kind", file("x"), dir("x"), "differs", "kind"],
    ["size", file("x", 1), file("x", 2), "differs", "size"],
    ["mtime", file("x", 1, 5), file("x", 1, 6), "differs", "mtime"],
    ["nothing cheap left", file("x", 1, 5), file("x", 1, 5), "inconclusive", "hash"],
  ];

  it.each(cases)("decides %s", (_label, a, b, verdict, reason) => {
    expect(decide(a, b)).toEqual({ verdict, reason });
  });

  it("applies the levels in order, cheapest first", () => {
    // A pair that differs in size *and* mtime is reported on the size: it is
    // the difference that no amount of copying flags can explain away.
    expect(decide(file("x", 1, 5), file("x", 2, 6))).toEqual({ verdict: "differs", reason: "size" });
  });
});
