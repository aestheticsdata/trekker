import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { contentOf, type FlatTree, flatten, pictureOf, type TreeSpec } from "./corpus";
import { guardDevelopmentDatabase, MockRefusal, mockHome, treeRoot } from "./env";
import { resolveTree } from "./fixtures";
import {
  REMOTE_HOSTS,
  REMOTE_TREES,
  REMOTE_VOLUMES,
  type RemoteSlug,
  TREE_SPEC,
  VOLUMES,
  type VolumeSpec,
} from "./manifest";

/**
 * The materialiser (TRE-140): the manifest's tree, as real files on disk.
 *
 *   pnpm --filter ./nest-api mock:tree          # make it, or leave it alone
 *   pnpm --filter ./nest-api mock:tree --force  # make it again
 *
 * Real files, because nothing in the API is faked: the drivers, `du`, the
 * tail and the treemap run their production code on this directory. The big
 * files are sparse — `truncate` to the size, no blocks allocated — so a
 * fifteen-gigabyte server layout costs a few megabytes of disk, and the
 * listing shows the sizes the manifest declares.
 *
 * Deterministic. The tree is a function of the manifest and of one anchor
 * instant: every mtime is the manifest's relative time added to the anchor
 * and snapped to a whole second, because the filesystem stores fractional
 * milliseconds it cannot give back exactly. A stamp file beside the tree
 * records which manifest made it, so a second run without a manifest change
 * touches nothing — that is what "reproduces the tree identically" means for
 * a tree whose timestamps are meant to read as recent.
 */

/** Bumped when the writing changes in a way the stamp cannot see. 2: the fake `df`; 3: mounts inside the tree; 4: the remote machines' trees (TRE-148). */
export const MATERIALISER_VERSION = 4;

export interface Stamp {
  version: number;
  manifest: string;
  /** The instant the manifest's reference was mapped onto, in epoch ms. */
  anchorMs: number;
  writtenAt: string;
}

export interface MaterialiseOptions {
  /** Rewrite even when the stamp says the tree is current. */
  force?: boolean;
  /** The anchor. Defaults to the clock; the specs pin it. */
  now?: number;
  log?: (line: string) => void;
}

export interface MaterialiseResult {
  root: string;
  /** False when the stamp matched and nothing was touched. */
  written: boolean;
  /** Kestrel's tree. */
  files: number;
  directories: number;
  apparentBytes: number;
  /** The three remote machines' trees, together. */
  remoteFiles: number;
  anchorMs: number;
}

/**
 * A fingerprint of everything that decides what gets written: the spec, and
 * the bytes the generators produce for it. The generators live in
 * `corpus.ts`, outside the spec, so hashing the spec alone would call a tree
 * current after a log format changed under it.
 */
export function manifestDigest(): string {
  const hash = createHash("sha256").update(`${MATERIALISER_VERSION}\n`);
  for (const [name, spec] of [["kestrel", TREE_SPEC], ...Object.entries(REMOTE_TREES)] as const) {
    hash.update(`\n== ${name}\n`).update(JSON.stringify(spec));
    for (const entry of flatten(spec).entries) {
      const content = contentOf(entry.spec, entry.rel);
      if (content !== null) hash.update(`\n${entry.rel}\n`).update(content);
    }
  }
  return hash.digest("hex");
}

/**
 * Where a remote machine's half of the mock lives: `<mock home>/hosts/<slug>/`.
 * `tree/` is what its sshd serves as `/`, rewritten with the rest; `keys/` its
 * host key, made once by `sshd.ts` and kept, because the row in the database
 * accepts that key and a running server holds it.
 */
export function remoteHome(slug: RemoteSlug): string {
  return join(mockHome(), "hosts", slug);
}

export function remoteRoot(slug: RemoteSlug): string {
  return join(remoteHome(slug), "tree");
}

/** A remote machine's `df`: `<mock home>/hosts/<slug>/bin/df`, run by its sshd. */
export function remoteDfShimPath(slug: RemoteSlug): string {
  return join(remoteHome(slug), "bin", "df");
}

// ---------------------------------------------------------------- the fixtures' stamp

/**
 * What the loader last wrote the fixtures against. Beside the tree's own
 * stamp, so `dev-up` can tell a tree rewritten since the last load — by
 * `mock:tree --force`, or by a delete and a fresh `pnpm dev` — from one the
 * rows still describe. The cached checksums carry the tree's mtimes, and a
 * rewritten tree has new ones.
 */
export interface FixturesStamp {
  /** The `anchorMs` of the tree the fixtures were loaded against. */
  treeAnchorMs: number;
  loadedAt: string;
  hostId: string;
}

export function fixturesStampPath(): string {
  return join(mockHome(), "fixtures.stamp.json");
}

export function readFixturesStamp(): FixturesStamp | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fixturesStampPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const stamp = parsed as Partial<FixturesStamp>;
    if (typeof stamp.treeAnchorMs !== "number" || typeof stamp.hostId !== "string") return null;
    return stamp as FixturesStamp;
  } catch {
    return null;
  }
}

export function writeFixturesStamp(stamp: FixturesStamp): void {
  mkdirSync(dirname(fixturesStampPath()), { recursive: true });
  writeFileSync(fixturesStampPath(), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
}

/** Whether the rows in the database were loaded against the tree that is on disk. */
export function fixturesMatchTree(): boolean {
  const tree = readStamp();
  const fixtures = readFixturesStamp();
  return tree !== null && fixtures !== null && fixtures.treeAnchorMs === tree.anchorMs && existsSync(treeRoot());
}

export function stampPath(): string {
  return join(mockHome(), "tree.stamp.json");
}

export function readStamp(): Stamp | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stampPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const stamp = parsed as Partial<Stamp>;
    if (typeof stamp.manifest !== "string" || typeof stamp.anchorMs !== "number") return null;
    return stamp as Stamp;
  } catch {
    return null;
  }
}

/** Whether the tree on disk was made from this manifest. */
export function treeIsCurrent(): boolean {
  const stamp = readStamp();
  return stamp !== null && stamp.manifest === manifestDigest() && existsSync(treeRoot());
}

/** A file's mtime, from the manifest's relative time and the anchor: whole seconds. */
export function snapToSecond(anchorMs: number, rel: number): number {
  return Math.round((anchorMs + rel) / 1000) * 1000;
}

export function materialise(options: MaterialiseOptions = {}): MaterialiseResult {
  const root = treeRoot();
  const home = mockHome();
  const log = options.log ?? (() => undefined);
  const flat = flatten(TREE_SPEC);
  const remoteFiles = REMOTE_HOSTS.reduce((sum, host) => sum + flatten(REMOTE_TREES[host.slug]).entries.length, 0);

  if (!options.force && treeIsCurrent()) {
    const stamp = readStamp() as Stamp;
    return {
      root,
      written: false,
      files: flat.entries.length,
      directories: flat.dirs.length,
      apparentBytes: apparentBytes(flat),
      remoteFiles,
      anchorMs: stamp.anchorMs,
    };
  }

  // The one destructive step, and the one place it can go wrong: a root that
  // exists without a stamp beside it is a directory this code did not make.
  // The remotes' trees are not checked: `<mock home>/hosts/<slug>/tree` is a
  // path nothing but this code makes, and they are rewritten with the stamp.
  if (existsSync(root) && readStamp() === null) {
    throw new MockRefusal(
      `${root} exists and carries no stamp, so it was not made by this materialiser. ` +
        "Remove it yourself, or point TREKKER_MOCK_HOME somewhere else.",
    );
  }

  const anchorMs = options.now ?? Date.now();
  // The old stamp goes first. A rewrite interrupted halfway must leave a root
  // with no stamp — which the refusal above reports, with its remedy — and
  // never a half-written tree that the next run calls current.
  rmSync(stampPath(), { force: true });

  const written = writeTree(TREE_SPEC, root, anchorMs);
  // Beside the tree, before the stamp: a `df` that answers for Kestrel.
  writeDfShim(dfShimPath(), dfShim());

  // The three remote machines: a tree each, served by the mock's own sshd
  // (`sshd.ts`), and a `df` each — the same generated script, which the sshd
  // runs when the API asks the machine for its disks. The keys directory
  // beside a tree is left alone — see `remoteHome`.
  for (const host of REMOTE_HOSTS) {
    writeTree(REMOTE_TREES[host.slug], remoteRoot(host.slug), anchorMs);
    writeDfShim(remoteDfShimPath(host.slug), dfShim(REMOTE_VOLUMES[host.slug], "/"));
  }

  const stamp: Stamp = {
    version: MATERIALISER_VERSION,
    manifest: manifestDigest(),
    anchorMs,
    writtenAt: new Date(anchorMs).toISOString(),
  };
  mkdirSync(dirname(stampPath()), { recursive: true });
  writeFileSync(stampPath(), `${JSON.stringify(stamp, null, 2)}\n`, "utf8");

  log(`tree written under ${home}`);
  return {
    root,
    written: true,
    files: flat.entries.length,
    directories: flat.dirs.length,
    apparentBytes: written,
    remoteFiles,
    anchorMs,
  };
}

/** One tree, from one spec, under one root: removed and rewritten whole. Returns the apparent bytes. */
function writeTree(spec: TreeSpec, root: string, anchorMs: number): number {
  const flat = flatten(spec);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  for (const directory of flat.dirs) {
    if (directory.rel === "") continue;
    mkdirSync(join(root, directory.rel), {
      recursive: true,
      mode: directory.mode,
    });
    chmodSync(join(root, directory.rel), directory.mode);
  }

  let bytes = 0;
  for (const entry of flat.entries) {
    const path = join(root, entry.rel);
    const when = new Date(snapToSecond(anchorMs, entry.mtime));

    if (entry.spec.kind === "symlink") {
      symlinkSync(entry.spec.target, path);
      lutimesSync(path, when, when);
      continue;
    }

    const content = contentOf(entry.spec, entry.rel);
    const picture = pictureOf(entry.spec, entry.rel);
    if (content !== null) {
      writeFileSync(path, content, "utf8");
    } else if (picture !== null) {
      // The PNG, then the file extended to its declared size: the tail after
      // IEND is a hole, and the picture stays the picture.
      writeFileSync(path, picture);
      if (entry.size > picture.length) truncateSync(path, entry.size);
    } else {
      // Open, close, truncate: the file is created empty and then extended to
      // its size with no blocks behind it. Every read of it yields zeroes.
      closeSync(openSync(path, "w"));
      truncateSync(path, entry.size);
    }
    // After the write, and explicitly: `writeFileSync`'s mode is subject to
    // the umask, and a script that should be 755 must be 755.
    chmodSync(path, entry.mode);
    utimesSync(path, when, when);
    bytes += entry.size;
  }

  // Directories last and deepest first: creating an entry updates the mtime
  // of the directory holding it, so the directory's own time has to be
  // written after everything under it has been.
  const deepestFirst = [...flat.dirs].sort((left, right) => depth(right.rel) - depth(left.rel));
  for (const directory of deepestFirst) {
    const when = new Date(snapToSecond(anchorMs, directory.mtime));
    utimesSync(directory.rel === "" ? root : join(root, directory.rel), when, when);
  }
  return bytes;
}

function depth(rel: string): number {
  return rel === "" ? 0 : rel.split("/").length;
}

function apparentBytes(flat: FlatTree): number {
  return flat.entries.reduce((sum, entry) => (entry.spec.kind === "symlink" ? sum : sum + entry.size), 0);
}

// ---------------------------------------------------------------- the command

if (require.main === module) {
  try {
    // The tree touches no database, and is refused on the same terms anyway:
    // a materialised tree on the production box is a thing nobody asked for,
    // and one rule for both commands is one rule to remember.
    guardDevelopmentDatabase();
    const force = process.argv.includes("--force");
    const result = materialise({ force, log: (line) => console.log(line) });
    const gib = (result.apparentBytes / 1024 ** 3).toFixed(1);
    if (result.written) {
      console.log(
        `Materialised ${result.files} files in ${result.directories} directories (${gib} GiB apparent, mostly sparse), and ${result.remoteFiles} more for the three remote machines.`,
      );
      // Every mtime moved with the anchor, so the cached checksums and the
      // scans in the database now describe the previous tree.
      console.log("The fixtures in the database describe the tree this replaced: run `pnpm mock` to reload them.");
    } else {
      console.log(`The tree already matches the manifest; nothing was touched. Use --force to rewrite it.`);
    }
    console.log(`\n  ${result.root}\n`);
  } catch (error) {
    if (error instanceof MockRefusal) {
      console.error(`\nmock:tree refused: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

// ---------------------------------------------------------------- the fake df

/**
 * Where the fake `df` lives: `<mock home>/bin/df`. An API started with that
 * directory first on its PATH reads the manifest's `VOLUMES` wherever it would
 * have read the machine's — the disks service, the mount table, the upload
 * fit check — through the same `execFile("df", …)` and the same parsers.
 * Nothing else on the machine sees it: PATH is the API process's own.
 */
export function dfShimPath(): string {
  return join(mockHome(), "bin", "df");
}

/**
 * The script itself, generated from `VOLUMES` so the rail and the manifest
 * cannot disagree. Node, not sh: the API is node, so node is on its PATH; and
 * `df -Pk /some/path` has to pick the volume that holds the path, which is a
 * longest-prefix walk that sh would make unreadable.
 *
 * Three shapes, the ones `host-disks.service.ts` and `mount-table.ts` ask for:
 * `-P -k -T` (typed), `-P -k` / `-Pk` / `-P` (plain), `-P -i` (inodes). The
 * capacity column is used over total, which is what the parsers recompute
 * anyway; a filesystem without an inode count prints zeros, which the disks
 * service reads as "keeps none".
 */
export function dfShim(volumes: readonly VolumeSpec[] = VOLUMES, root: string = treeRoot()): string {
  const rows = volumes.map((volume) => ({
    // `$TREE` in a mount point is the tree's root: the volumes are directories
    // the rail can open, and only the machine doing the writing knows where.
    mountPoint: resolveTree(volume.mountPoint, root),
    device: volume.device,
    type: volume.type,
    totalKib: Math.round(volume.totalBytes / 1024),
    usedKib: Math.round(volume.usedBytes / 1024),
    inodes: volume.inodes,
  }));
  return `#!/usr/bin/env node
// Generated by nest-api/mock/tree.ts from the manifest's VOLUMES (TRE-148) — Kestrel's \`df\`, for
// an API started with this directory first on its PATH. Not hand-edited: \`pnpm mock\` rewrites it.
"use strict";
const ROWS = ${JSON.stringify(rows)};
const args = process.argv.slice(2);
let typed = false;
let inodes = false;
const paths = [];
for (const arg of args) {
  if (arg.startsWith("-")) {
    if (arg.includes("T")) typed = true;
    if (arg.includes("i")) inodes = true;
  } else paths.push(arg);
}
const holder = (path) => {
  let best = null;
  for (const row of ROWS) {
    const mount = row.mountPoint;
    const holds = mount === "/" ? path.startsWith("/") : path === mount || path.startsWith(mount + "/");
    if (holds && (best === null || mount.length > best.mountPoint.length)) best = row;
  }
  return best;
};
const rows = paths.length === 0 ? ROWS : paths.map(holder).filter(Boolean);
const pct = (used, total) => (total > 0 ? Math.round((used / total) * 100) + "%" : "-");
const lines = [];
if (inodes) {
  lines.push("Filesystem Inodes IUsed IFree IUse% Mounted on");
  for (const row of rows) {
    const total = row.inodes ? row.inodes.total : 0;
    const used = row.inodes ? row.inodes.used : 0;
    lines.push([row.device, total, used, total - used, pct(used, total), row.mountPoint].join(" "));
  }
} else if (typed) {
  lines.push("Filesystem Type 1024-blocks Used Available Capacity Mounted on");
  for (const row of rows) {
    lines.push([row.device, row.type, row.totalKib, row.usedKib, row.totalKib - row.usedKib, pct(row.usedKib, row.totalKib), row.mountPoint].join(" "));
  }
} else {
  lines.push("Filesystem 1024-blocks Used Available Capacity Mounted on");
  for (const row of rows) {
    lines.push([row.device, row.totalKib, row.usedKib, row.totalKib - row.usedKib, pct(row.usedKib, row.totalKib), row.mountPoint].join(" "));
  }
}
process.stdout.write(lines.join("\\n") + "\\n");
`;
}

function writeDfShim(path: string, script: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
}
