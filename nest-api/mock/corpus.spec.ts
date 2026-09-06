import { ScanAggregator } from "../src/scans/scan-aggregator";
import { contentKey, contentOf, DIR_BLOCK, duRecords, flatten, generate, sizeOf, type WalkedEntry } from "./corpus";
import { allActivity, transferItems, transferTotals, treeReferences } from "./fixtures";
import { ACTIVITY, BOOKMARKS, HASHES, REFERENCE_MS, SCANS, TRANSFERS, TREE_SPEC, VIEWS, VOLUMES } from "./manifest";

/**
 * The manifest's two halves agree, and the pure helpers behave (TRE-140).
 *
 * The one-source check is the point of this file: a treemap rectangle has to
 * land on a listing that holds that file, and the only way to promise that
 * from a spec is to refuse a fixture naming a path the tree does not make.
 */

const flat = flatten(TREE_SPEC);
const entryRels = new Set(flat.entries.map((entry) => entry.rel));
const dirRels = new Set(flat.dirs.map((directory) => directory.rel));
const exists = (rel: string): boolean => rel === "" || entryRels.has(rel) || dirRels.has(rel);

describe("flatten", () => {
  it("implies every ancestor directory and the root", () => {
    expect(dirRels.has("")).toBe(true);
    expect(dirRels.has("var")).toBe(true);
    expect(dirRels.has("var/www/app/releases/2026-08-30-1730/dist")).toBe(true);
  });

  it("gives an implied directory its newest child's mtime", () => {
    const nginx = flat.dirs.find((directory) => directory.rel === "var/log/nginx");
    const newest = Math.max(
      ...flat.entries.filter((entry) => entry.rel.startsWith("var/log/nginx/")).map((entry) => entry.mtime),
    );
    expect(nginx?.mtime).toBe(newest);
  });

  it("sizes text by its bytes, sparse by its declared size, and never fractionally", () => {
    for (const entry of flat.entries) {
      expect(Number.isInteger(entry.size)).toBe(true);
      expect(entry.size).toBeGreaterThanOrEqual(0);
      if (entry.spec.kind === "text") expect(entry.size).toBe(Buffer.byteLength(entry.spec.content));
    }
  });

  it("leaves no directory empty, so the aggregator never mistakes one for a file", () => {
    for (const directory of flat.dirs) {
      const prefix = directory.rel === "" ? "" : `${directory.rel}/`;
      const holdsSomething =
        flat.entries.some((entry) => entry.rel.startsWith(prefix)) ||
        flat.dirs.some((other) => other.rel !== directory.rel && other.rel.startsWith(prefix));
      expect({ rel: directory.rel, holdsSomething }).toEqual({
        rel: directory.rel,
        holdsSomething: true,
      });
    }
  });
});

describe("generate", () => {
  it("is deterministic per name and seed, and different per seed", () => {
    expect(generate("nginx-access", 50, "a")).toBe(generate("nginx-access", 50, "a"));
    expect(generate("nginx-access", 50, "a")).not.toBe(generate("nginx-access", 50, "b"));
  });

  it("writes only documentation addresses and example hosts", () => {
    for (const name of ["nginx-access", "nginx-error", "app-json", "syslog", "auth-log", "mysql-error"] as const) {
      const text = generate(name, 300, "check");
      for (const ip of text.match(/\b(\d{1,3}\.){3}\d{1,3}\b/g) ?? []) {
        expect(ip).toMatch(/^(127\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/);
      }
      for (const host of text.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\.(com|io|net|org)\b/g) ?? []) {
        expect(host).toMatch(/example\.com$/);
      }
    }
  });

  it("is what contentOf returns, and sizeOf measures", () => {
    const spec = TREE_SPEC["var/log/nginx/error.log"];
    const content = contentOf(spec, "var/log/nginx/error.log") as string;
    expect(content.endsWith("\n")).toBe(true);
    expect(sizeOf(spec, "var/log/nginx/error.log")).toBe(Buffer.byteLength(content));
  });
});

describe("duRecords", () => {
  const root = "/tree";
  const walk: WalkedEntry[] = [
    { path: "/tree", kind: "directory", size: 0, mtimeMs: 5 },
    { path: "/tree/b", kind: "directory", size: 0, mtimeMs: 4 },
    { path: "/tree/b/x.bin", kind: "file", size: 1_000, mtimeMs: 1 },
    { path: "/tree/b/y.bin", kind: "file", size: 2_000, mtimeMs: 2 },
    { path: "/tree/a.txt", kind: "file", size: 100, mtimeMs: 3 },
    { path: "/tree/link", kind: "symlink", size: 7, mtimeMs: 3 },
  ];

  it("prints every child before its parent and the root last, siblings by name", () => {
    const records = duRecords(root, walk);
    expect(records.map((record) => record.path)).toEqual([
      "/tree/a.txt",
      "/tree/b/x.bin",
      "/tree/b/y.bin",
      "/tree/b",
      "/tree/link",
      "/tree",
    ]);
  });

  it("charges a directory its children plus one block, so a level has a remainder", () => {
    const records = duRecords(root, walk);
    const byPath = new Map(records.map((record) => [record.path, record.bytes]));
    expect(byPath.get("/tree/b")).toBe(BigInt(3_000 + DIR_BLOCK));
    expect(byPath.get("/tree")).toBe(BigInt(3_000 + DIR_BLOCK + 100 + 7 + DIR_BLOCK));
  });

  it("is a stream the real aggregator folds into levels that sum to their parent", () => {
    const now = REFERENCE_MS;
    const walked: WalkedEntry[] = [
      { path: "/t", kind: "directory", size: 0, mtimeMs: now },
      ...flat.dirs
        .filter((directory) => directory.rel !== "")
        .map((directory) => ({
          path: `/t/${directory.rel}`,
          kind: "directory" as const,
          size: 0,
          mtimeMs: now + directory.mtime,
        })),
      ...flat.entries.map((entry) => ({
        path: `/t/${entry.rel}`,
        kind: entry.spec.kind === "symlink" ? ("symlink" as const) : ("file" as const),
        size: entry.size,
        mtimeMs: now + entry.mtime,
      })),
    ];
    const aggregator = new ScanAggregator({
      root: "/t",
      depth: 3,
      hasTime: true,
      hasFiles: true,
      now,
    });
    for (const record of duRecords("/t", walked)) aggregator.add(record);
    const result = aggregator.finish();

    expect(result.totalBytes).not.toBeNull();
    expect(result.truncated).toBe(false);
    expect(result.largest?.path).toBe("/t/var/lib/mysql/app/orders.ibd");
    expect(result.oldFileCount).toBeGreaterThan(0n);

    const byParent = new Map<string, bigint>();
    for (const entry of result.entries) {
      if (entry.depth === 0) continue;
      byParent.set(entry.parentPath, (byParent.get(entry.parentPath) ?? 0n) + entry.bytes);
    }
    const own = new Map(
      result.entries.filter((entry) => entry.kind !== "OTHER").map((entry) => [entry.path, entry.bytes]),
    );
    for (const [parent, sum] of byParent) {
      expect({ parent, sum }).toEqual({ parent, sum: own.get(parent) });
    }
  });
});

describe("one source: every fixture names a path the tree makes", () => {
  it("bookmarks, views and volumes point inside the tree", () => {
    // Volumes too: a mount point is what the rail opens on a click, so each one
    // has to be a directory the tree makes (TRE-148).
    for (const rel of treeReferences([BOOKMARKS, VIEWS, VOLUMES])) {
      expect({ rel, ok: exists(rel) }).toEqual({ rel, ok: true });
    }
  });

  it("hashes name regular files that will be written", () => {
    for (const hash of HASHES) {
      const entry = flat.entries.find((candidate) => candidate.rel === hash.path);
      expect({ path: hash.path, kind: entry?.spec.kind }).toMatchObject({
        path: hash.path,
      });
      expect(entry && entry.spec.kind !== "symlink").toBe(true);
    }
  });

  it("dates every cached checksum after the file it describes was last written", () => {
    for (const hash of HASHES) {
      const entry = flat.entries.find((candidate) => candidate.rel === hash.path);
      expect({
        path: hash.path,
        later: entry !== undefined && hash.computedAt > entry.mtime,
      }).toEqual({
        path: hash.path,
        later: true,
      });
    }
  });

  it("sizes a hand-written transfer item from the tree when it names a file the tree makes", () => {
    const move = TRANSFERS.find((transfer) => transfer.key === "remote-exports-move");
    const csv = flat.entries.find((entry) => entry.rel === "home/alice/projects/sales-2026-07.csv");
    const items = transferItems(move as (typeof TRANSFERS)[number], flat);
    expect(items[0].bytes).toBe(csv?.size);

    const failed = TRANSFERS.find((transfer) => transfer.key === "backups-to-media-failed");
    const readme = flat.entries.find((entry) => entry.rel === "opt/backups/README.md");
    const item = transferItems(failed as (typeof TRANSFERS)[number], flat).find(
      (row) => row.name === "backups/README.md",
    );
    expect(item?.bytes).toBe(readme?.size);
  });

  it("scan roots are directories of the tree", () => {
    for (const scan of SCANS)
      expect({ root: scan.root, ok: dirRels.has(scan.root) }).toEqual({
        root: scan.root,
        ok: true,
      });
  });

  it("transfers that enumerate the tree name a directory in it, and the rest name what they carry", () => {
    for (const transfer of TRANSFERS) {
      if (!Array.isArray(transfer.items)) {
        expect({
          key: transfer.key,
          ok: dirRels.has(transfer.items.fromTree),
        }).toEqual({
          key: transfer.key,
          ok: true,
        });
      }
      const items = transferItems(transfer, flat);
      expect(items.length).toBeGreaterThan(0);
      const totals = transferTotals(items);
      expect(totals.itemsTotal).toBe(items.length);
      if (transfer.status === "DONE") expect(totals.failed).toBe(0);
    }
  });

  it("undo snapshots name files that exist, so the undo button has something to restore", () => {
    for (const row of ACTIVITY) {
      for (const snapshot of row.snapshots ?? []) {
        for (const rel of treeReferences(snapshot.path))
          expect({ rel, ok: entryRels.has(rel) }).toEqual({ rel, ok: true });
      }
    }
  });

  it("sparse files of one size are byte-identical, which is what a duplicate is", () => {
    const a = TREE_SPEC["opt/backups/db-2026-08-28.sql.gz"];
    const b = TREE_SPEC["opt/backups/db-2026-08-29.sql.gz"];
    expect(contentKey(a, "x")).toBe(contentKey(b, "y"));
  });
});

describe("the activity log", () => {
  const rows = allActivity(flat);
  const KIND = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
  const DAY = 24 * 60 * 60 * 1000;

  it("uses the audit vocabulary and fits the column", () => {
    for (const row of rows) {
      expect(row.kind).toMatch(KIND);
      expect(row.kind.length).toBeLessThanOrEqual(32);
      expect(row.summary.length).toBeLessThanOrEqual(255);
      if (row.tag !== undefined) expect(row.tag.length).toBeLessThanOrEqual(32);
      if (row.detail !== undefined) expect(row.detail.length).toBeLessThanOrEqual(255);
    }
  });

  it("dates every row inside the retention window it will be pruned by", () => {
    for (const row of rows) {
      const days = -row.at / DAY;
      expect(days).toBeGreaterThanOrEqual(0);
      expect({
        key: row.key,
        days,
        inside: days < (row.destructive ? 365 : 90) - 5,
      }).toMatchObject({ inside: true });
    }
  });

  it("is sorted oldest first with unique keys, and is well stocked", () => {
    const keys = new Set(rows.map((row) => row.key));
    expect(keys.size).toBe(rows.length);
    for (let index = 1; index < rows.length; index += 1)
      expect(rows[index].at).toBeGreaterThanOrEqual(rows[index - 1].at);
    expect(rows.length).toBeGreaterThan(60);
    expect(new Set(rows.map((row) => row.kind)).size).toBeGreaterThan(25);
  });

  it("keeps the undo snapshots inside their own thirty days", () => {
    for (const row of rows) {
      if (!row.snapshots) continue;
      expect(-row.at / DAY).toBeLessThan(30 - 2);
    }
  });
});
