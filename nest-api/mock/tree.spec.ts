import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flatten } from "./corpus";
import { installRoot, mockHome, treeRoot } from "./env";
import { REFERENCE_MS, TREE_SPEC } from "./manifest";
import {
  fixturesMatchTree,
  manifestDigest,
  materialise,
  readFixturesStamp,
  readStamp,
  snapToSecond,
  stampPath,
  treeIsCurrent,
  writeFixturesStamp,
} from "./tree";

/**
 * The materialiser, against a real filesystem in a temporary home (TRE-140).
 *
 * Real, because the claims are about `truncate`, `utimes` and `lutimes` on
 * this machine's filesystem — that a sparse file costs no blocks, that a
 * whole-second mtime reads back exactly, that a symlink is a symlink.
 */

let home: string;
const saved = process.env.TREKKER_MOCK_HOME;
const ANCHOR = REFERENCE_MS + 17 * 24 * 60 * 60 * 1000 + 123;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "trekker-mock-"));
  process.env.TREKKER_MOCK_HOME = home;
});

afterAll(() => {
  if (saved === undefined) delete process.env.TREKKER_MOCK_HOME;
  else process.env.TREKKER_MOCK_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("materialise", () => {
  it("writes the whole manifest under the mock home, and stamps it", () => {
    const result = materialise({ now: ANCHOR });
    const flat = flatten(TREE_SPEC);

    expect(result.written).toBe(true);
    expect(result.root).toBe(join(home, "tree"));
    expect(result.files).toBe(flat.entries.length);
    expect(readStamp()?.manifest).toBe(manifestDigest());
    expect(readStamp()?.anchorMs).toBe(ANCHOR);
    expect(treeIsCurrent()).toBe(true);

    for (const entry of flat.entries) {
      const info = lstatSync(join(result.root, entry.rel));
      if (entry.spec.kind === "symlink") {
        expect(info.isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(result.root, entry.rel))).toBe(entry.spec.target);
      } else {
        expect(info.isFile()).toBe(true);
        expect(info.size).toBe(entry.size);
        expect(info.mode & 0o7777).toBe(entry.mode);
      }
    }
  });

  it("makes the big files sparse: the size is apparent, the blocks are not there", () => {
    const info = statSync(join(treeRoot(), "var/lib/mysql/app/orders.ibd"));
    expect(info.size).toBe(2_140 * 1024 * 1024);
    expect(info.blocks).toBe(0);
  });

  it("writes real, readable text where the manifest gives content", () => {
    const access = readFileSync(join(treeRoot(), "var/log/nginx/access.log"), "utf8");
    expect(access.split("\n").filter(Boolean)).toHaveLength(4_000);
    expect(access).toMatch(/"GET \/api\/health HTTP\/1.1" 200/);
    expect(readFileSync(join(treeRoot(), "etc/hostname"), "utf8")).toBe("web01\n");
  });

  it("stamps every mtime on a whole second, shifted from the manifest by the anchor", () => {
    const flat = flatten(TREE_SPEC);
    for (const entry of flat.entries) {
      const info = lstatSync(join(treeRoot(), entry.rel));
      const expected = snapToSecond(ANCHOR, entry.mtime);
      expect(expected % 1000).toBe(0);
      // Exactly, not approximately: the hash cache compares this number for
      // equality against a fresh stat, and a millisecond off is a cache miss.
      expect({ rel: entry.rel, mtimeMs: Math.trunc(info.mtimeMs) }).toEqual({
        rel: entry.rel,
        mtimeMs: expected,
      });
    }
    for (const directory of flat.dirs) {
      const info = statSync(directory.rel === "" ? treeRoot() : join(treeRoot(), directory.rel));
      expect(Math.trunc(info.mtimeMs)).toBe(snapToSecond(ANCHOR, directory.mtime));
    }
  });

  it("leaves a current tree alone, so a second run reproduces the first", () => {
    const marker = join(treeRoot(), "etc", "hostname");
    const before = statSync(marker).mtimeMs;
    const result = materialise({ now: ANCHOR + 86_400_000 });
    expect(result.written).toBe(false);
    expect(result.anchorMs).toBe(ANCHOR);
    expect(statSync(marker).mtimeMs).toBe(before);
  });

  it("rewrites on --force, and on a manifest change, from a fresh anchor", () => {
    const stray = join(treeRoot(), "tmp", "left-behind.txt");
    writeFileSync(stray, "not in the manifest\n");
    const result = materialise({ now: ANCHOR + 86_400_000, force: true });
    expect(result.written).toBe(true);
    expect(existsSync(stray)).toBe(false);
    expect(readStamp()?.anchorMs).toBe(ANCHOR + 86_400_000);
  });

  it("refuses to remove a directory it did not make", () => {
    rmSync(stampPath(), { force: true });
    expect(() => materialise({ now: ANCHOR })).toThrow(/carries no stamp/);
    // And leaves it standing.
    expect(existsSync(join(treeRoot(), "etc", "hostname"))).toBe(true);
  });

  it("lives in the repository's own .mock folder unless moved", () => {
    const moved = process.env.TREKKER_MOCK_HOME;
    delete process.env.TREKKER_MOCK_HOME;
    expect(mockHome()).toBe(join(installRoot(), ".mock"));
    process.env.TREKKER_MOCK_HOME = moved;
  });

  it("fingerprints the generated bytes, not only the spec", () => {
    // Two spec objects that stringify the same would hash the same; the
    // digest also covers what the generators write for them, so a changed
    // log line format changes it. Proven the cheap way: the digest is not
    // the hash of the spec alone.
    const specOnly = createHash("sha256").update("1\n").update(JSON.stringify(TREE_SPEC)).digest("hex");
    expect(manifestDigest()).not.toBe(specOnly);
  });

  it("records what the fixtures were loaded against, and notices a rewrite", () => {
    rmSync(stampPath(), { force: true });
    rmSync(treeRoot(), { recursive: true, force: true });
    const made = materialise({ now: ANCHOR });
    writeFixturesStamp({
      treeAnchorMs: made.anchorMs,
      loadedAt: new Date(ANCHOR).toISOString(),
      hostId: "x",
    });
    expect(readFixturesStamp()?.treeAnchorMs).toBe(ANCHOR);
    expect(fixturesMatchTree()).toBe(true);

    materialise({ now: ANCHOR + 1_000, force: true });
    expect(fixturesMatchTree()).toBe(false);
  });
});
