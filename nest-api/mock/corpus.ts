import { posix } from "node:path";
import type { DuRecord } from "../src/scans/du-parse";
import { choose, pick, seededRandom } from "./ids";
import { encodeImage, imageBytes, type ImageStyle } from "./images";

/**
 * The pure half of the fake tree (TRE-140): what the manifest's spec means as
 * bytes on disk, and how a tree on disk reads as a stream of `du` records.
 *
 * Nothing here touches a filesystem, a clock or a database. `tree.ts` writes
 * what `flatten` describes; `load.ts` feeds what `duRecords` produces to the
 * real `ScanAggregator`. Keeping both sides pure is what lets one spec assert
 * that the two halves of the manifest agree — every path a fixture names is a
 * path the tree materialises — without a disk.
 */

// ---------------------------------------------------------------- the spec

/** Milliseconds relative to the reference instant. Negative is the past. */
export type Rel = number;

export type FileSpec =
  /** A small file with its content written out in the manifest. */
  | { kind: "text"; content: string; mtime: Rel; mode?: number }
  /** A large-ish text file produced by a seeded generator — logs, a CSV. */
  | {
      kind: "generated";
      generator: GeneratorName;
      lines: number;
      mtime: Rel;
      mode?: number;
    }
  /**
   * A big file that costs no disk: `truncate` to the size, every byte reads
   * as zero. `du` on the materialised tree reports it as nearly nothing; the
   * fixture scan reports the apparent size, which is what the listing shows.
   */
  | { kind: "sparse"; bytes: number; mtime: Rel; mode?: number }
  /**
   * A picture: a real PNG, painted from the file's own path, then extended to
   * `bytes` with a sparse tail — see `images.ts`. The inspector's preview
   * shows it; a sparse file showed nothing.
   */
  | { kind: "image"; style: ImageStyle; width: number; height: number; bytes: number; mtime: Rel; mode?: number }
  /** A symlink with a relative target, so the tree relocates as a whole. */
  | { kind: "symlink"; target: string; mtime: Rel }
  /** An explicit directory — for one that would otherwise be empty, or one with its own mode. */
  | { kind: "dir"; mtime: Rel; mode?: number };

export type TreeSpec = Readonly<Record<string, FileSpec>>;

export type GeneratorName =
  "nginx-access" | "nginx-error" | "app-json" | "syslog" | "auth-log" | "dpkg-log" | "mysql-error" | "csv";

// ---------------------------------------------------------------- flatten

export interface FlatDir {
  /** Relative to the tree root, `""` for the root itself. */
  rel: string;
  mtime: Rel;
  mode: number;
}

export interface FlatEntry {
  rel: string;
  spec: FileSpec;
  /** Apparent size in bytes: the content's length, or the sparse size. */
  size: number;
  mtime: Rel;
  mode: number;
}

export interface FlatTree {
  dirs: FlatDir[];
  entries: FlatEntry[];
}

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

/**
 * Every directory the spec implies, every file with its size, both sorted so
 * two machines materialise in the same order.
 *
 * A directory's mtime is its newest child's unless the spec says otherwise —
 * which is what a real directory's mtime is, give or take: the moment its
 * last entry was made.
 */
export function flatten(spec: TreeSpec): FlatTree {
  const dirs = new Map<string, FlatDir>();
  const entries: FlatEntry[] = [];

  const noteDir = (rel: string, mtime: Rel): void => {
    const existing = dirs.get(rel);
    if (existing) {
      if (mtime > existing.mtime) existing.mtime = mtime;
      return;
    }
    dirs.set(rel, { rel, mtime, mode: DEFAULT_DIR_MODE });
  };

  for (const [rawRel, file] of Object.entries(spec)) {
    const rel = normaliseRel(rawRel);
    if (rel === "") throw new Error("The tree root cannot be an entry of itself.");

    if (file.kind === "dir") {
      noteDir(rel, file.mtime);
      const explicit = dirs.get(rel) as FlatDir;
      explicit.mtime = file.mtime;
      if (file.mode !== undefined) explicit.mode = file.mode;
    } else {
      entries.push({
        rel,
        spec: file,
        size: sizeOf(file, rel),
        mtime: file.mtime,
        mode: file.kind === "symlink" ? 0o777 : (file.mode ?? DEFAULT_FILE_MODE),
      });
    }

    // Every ancestor exists, and each one is at least as new as this entry.
    for (let parent = posix.dirname(rel); ; parent = posix.dirname(parent)) {
      noteDir(parent === "." ? "" : parent, file.mtime);
      if (parent === "." || parent === "") break;
    }
  }

  // Explicit directories that hold entries: their mtime was pinned above, and
  // the ancestor walk must not have moved it. Re-apply, since `noteDir` only
  // ever raises.
  for (const [rawRel, file] of Object.entries(spec)) {
    if (file.kind !== "dir") continue;
    const dir = dirs.get(normaliseRel(rawRel));
    if (dir) dir.mtime = file.mtime;
  }

  return {
    dirs: [...dirs.values()].sort((left, right) => left.rel.localeCompare(right.rel)),
    entries: entries.sort((left, right) => left.rel.localeCompare(right.rel)),
  };
}

function normaliseRel(rel: string): string {
  return rel.split("/").filter(Boolean).join("/");
}

/** The apparent size a file will have once written. */
export function sizeOf(spec: FileSpec, rel: string): number {
  switch (spec.kind) {
    case "text":
      return Buffer.byteLength(spec.content, "utf8");
    case "generated":
      return Buffer.byteLength(generate(spec.generator, spec.lines, rel), "utf8");
    case "sparse":
      // `truncate` takes whole bytes; a manifest may say `0.8 * MB`.
      return Math.round(spec.bytes);
    case "image":
      return imageBytes(imageParams(spec, rel), spec.bytes);
    case "symlink":
      return Buffer.byteLength(spec.target, "utf8");
    case "dir":
      return 0;
  }
}

/** What gets written for a text or generated file. Null for the other kinds. */
export function contentOf(spec: FileSpec, rel: string): string | null {
  if (spec.kind === "text") return spec.content;
  if (spec.kind === "generated") return generate(spec.generator, spec.lines, rel);
  return null;
}

/** The picture's bytes for an image file — the PNG before its sparse tail. Null for the other kinds. */
export function pictureOf(spec: FileSpec, rel: string): Buffer | null {
  return spec.kind === "image" ? encodeImage(imageParams(spec, rel)) : null;
}

/** The path seeds the picture: one file, one picture, on every machine and in every tree that holds it. */
function imageParams(spec: Extract<FileSpec, { kind: "image" }>, rel: string) {
  return { style: spec.style, width: spec.width, height: spec.height, seed: normaliseRel(rel) };
}

/**
 * Two files that would be byte-identical once materialised. Every sparse file
 * is all zeroes, so two sparse files of one size are copies of each other —
 * which is true on disk, and is what a real scan would confirm.
 */
export function contentKey(spec: FileSpec, rel: string): string {
  switch (spec.kind) {
    case "sparse":
      return `zeros:${spec.bytes}`;
    case "image":
      // Seeded by its own path: no two image files are copies of each other.
      return `image:${normaliseRel(rel)}`;
    case "text":
    case "generated":
      return `text:${contentOf(spec, rel) ?? ""}`;
    case "symlink":
      return `link:${spec.target}`;
    case "dir":
      return "dir";
  }
}

// ---------------------------------------------------------------- du records

/** One entry as a walk of the materialised tree reports it. */
export interface WalkedEntry {
  /** Absolute path on disk. */
  path: string;
  kind: "file" | "directory" | "symlink";
  /** Apparent size for a file, the target's length for a symlink, 0 for a directory. */
  size: number;
  mtimeMs: number;
}

/**
 * What `du` charges a directory for its own inode. 4096 on ext4 and the
 * number every Linux `du -a` prints for an empty directory, which is where
 * this tree pretends to live.
 */
export const DIR_BLOCK = 4096;

/**
 * A walk, replayed in the order `du -a` prints it: every child before its
 * parent, the root last, and siblings by name.
 *
 * The aggregator leans on that order twice — the last record is the total,
 * and a record is a directory exactly when the record before it was one of
 * its children — so the order is not cosmetic. Directory sizes are the sum of
 * what is under them plus one block for the directory itself, which is what
 * makes an `OTHER` remainder appear at every level the way it does on a real
 * scan.
 */
export function duRecords(root: string, walked: readonly WalkedEntry[]): DuRecord[] {
  const byParent = new Map<string, WalkedEntry[]>();
  const known = new Map<string, WalkedEntry>();
  for (const entry of walked) {
    known.set(entry.path, entry);
    if (entry.path === root) continue;
    const parent = posix.dirname(entry.path);
    const siblings = byParent.get(parent) ?? [];
    siblings.push(entry);
    byParent.set(parent, siblings);
  }

  const records: DuRecord[] = [];

  const visit = (path: string): bigint => {
    const entry = known.get(path);
    const children = (byParent.get(path) ?? []).sort((left, right) => left.path.localeCompare(right.path));
    let bytes = BigInt(DIR_BLOCK);
    for (const child of children) {
      if (child.kind === "directory") {
        bytes += visit(child.path);
      } else {
        records.push({
          bytes: BigInt(child.size),
          mtimeMs: child.mtimeMs,
          path: child.path,
        });
        bytes += BigInt(child.size);
      }
    }
    records.push({ bytes, mtimeMs: entry?.mtimeMs ?? null, path });
    return bytes;
  };

  visit(root);
  return records;
}

// ---------------------------------------------------------------- generators

/**
 * Log lines that read as a server's. Deterministic: the seed is the file's
 * own path, so `var/log/nginx/access.log` is the same file on every machine
 * and `access.log.1` is a different one.
 *
 * Every address is from the RFC 5737 documentation ranges, every host is
 * under `example.com`, and no line carries a key, a token or a fingerprint —
 * these files are committed as source and the repository is public.
 */
export function generate(name: GeneratorName, lines: number, seed: string): string {
  const random = seededRandom(`${name}:${seed}`);
  const out: string[] = [];
  for (let index = 0; index < lines; index += 1) out.push(GENERATORS[name](random, index, lines));
  return `${out.join("\n")}\n`;
}

const IPS = [
  "203.0.113.5",
  "203.0.113.17",
  "203.0.113.42",
  "203.0.113.88",
  "198.51.100.7",
  "198.51.100.23",
  "198.51.100.61",
  "192.0.2.10",
  "192.0.2.33",
  "192.0.2.77",
] as const;

const ROUTES: ReadonlyArray<readonly [string, number]> = [
  ["/", 30],
  ["/api/health", 25],
  ["/api/session", 12],
  ["/api/orders", 10],
  ["/api/orders/8814", 6],
  ["/assets/app.js", 14],
  ["/assets/app.css", 9],
  ["/favicon.ico", 5],
  ["/login", 4],
  ["/robots.txt", 2],
  ["/wp-login.php", 1],
];

const STATUSES: ReadonlyArray<readonly [number, number]> = [
  [200, 80],
  [304, 8],
  [301, 3],
  [404, 5],
  [403, 1],
  [500, 2],
  [502, 1],
];

const AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "curl/8.7.1",
  "Uptime-Probe/2.1 (+https://status.example.com)",
] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A timestamp for line `index` of `lines`, spread over the day and a half
 * before the file's nominal end. Written against the reference instant, not
 * the clock: the file's *content* is the same on every run, only its mtime
 * moves with the anchor.
 */
const CORPUS_END_MS = Date.UTC(2026, 8, 1, 11, 58, 0);
const CORPUS_SPAN_MS = 36 * 60 * 60 * 1000;

function lineDate(index: number, lines: number): Date {
  return new Date(CORPUS_END_MS - CORPUS_SPAN_MS + Math.floor((CORPUS_SPAN_MS * index) / Math.max(1, lines)));
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `01/Sep/2026:11:58:00 +0000` */
function clfDate(date: Date): string {
  return (
    `${pad(date.getUTCDate())}/${MONTHS[date.getUTCMonth()]}/${date.getUTCFullYear()}` +
    `:${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** `Sep  1 11:58:00` */
function syslogDate(date: Date): string {
  return `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** `2026/09/01 11:58:00` */
function nginxDate(date: Date): string {
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

type Generator = (random: () => number, index: number, lines: number) => string;

const GENERATORS: Record<GeneratorName, Generator> = {
  "nginx-access": (random, index, lines) => {
    const ip = IPS[pick(random, 0, IPS.length - 1)];
    const route = choose(random, ROUTES);
    const status = route === "/wp-login.php" ? 404 : choose(random, STATUSES);
    const bytes = status === 304 ? 0 : pick(random, 180, 48_000);
    const agent = AGENTS[pick(random, 0, AGENTS.length - 1)];
    const method = route.startsWith("/api/orders") && random() < 0.3 ? "POST" : "GET";
    return `${ip} - - [${clfDate(lineDate(index, lines))}] "${method} ${route} HTTP/1.1" ${status} ${bytes} "-" "${agent}"`;
  },

  "nginx-error": (random, index, lines) => {
    const date = nginxDate(lineDate(index, lines));
    const ip = IPS[pick(random, 0, IPS.length - 1)];
    const kind = choose(random, [
      ["upstream", 5],
      ["notfound", 4],
      ["limit", 1],
    ] as const);
    if (kind === "upstream") {
      return `${date} [error] 1187#1187: *${pick(random, 1000, 99_999)} upstream prematurely closed connection while reading response header from upstream, client: ${ip}, server: app.example.com, request: "GET /api/orders HTTP/1.1", upstream: "http://127.0.0.1:6800/api/orders", host: "app.example.com"`;
    }
    if (kind === "limit") {
      return `${date} [warn] 1187#1187: *${pick(random, 1000, 99_999)} limiting requests, excess: 10.520 by zone "api", client: ${ip}, server: app.example.com, request: "POST /api/session HTTP/1.1", host: "app.example.com"`;
    }
    return `${date} [error] 1187#1187: *${pick(random, 1000, 99_999)} open() "/var/www/app/current/public/${choose(
      random,
      [
        ["wp-login.php", 3],
        [".env", 2],
        ["xmlrpc.php", 1],
      ] as const,
    )}" failed (2: No such file or directory), client: ${ip}, server: app.example.com, request: "GET /${"wp-login.php"} HTTP/1.1", host: "app.example.com"`;
  },

  "app-json": (random, index, lines) => {
    const date = lineDate(index, lines).toISOString();
    const level = choose(random, [
      ["info", 80],
      ["warn", 12],
      ["error", 6],
      ["debug", 2],
    ] as const);
    const route = choose(random, ROUTES);
    const ms = level === "warn" ? pick(random, 900, 4_800) : pick(random, 3, 240);
    const status = level === "error" ? 500 : route === "/wp-login.php" ? 404 : 200;
    const message =
      level === "error"
        ? "unhandled: ECONNRESET on mysql pool"
        : level === "warn"
          ? "slow query"
          : level === "debug"
            ? "cache miss"
            : "request";
    return JSON.stringify({
      "@timestamp": date,
      level,
      message,
      req: { method: "GET", route, status, ms },
      trace: pick(random, 100_000, 999_999).toString(16),
    });
  },

  syslog: (random, index, lines) => {
    const date = syslogDate(lineDate(index, lines));
    const unit = choose(random, [
      ["systemd[1]: Started Session 1204 of user deploy.", 6],
      ["systemd[1]: Starting Daily apt download activities...", 2],
      ["systemd[1]: apt-daily.service: Succeeded.", 2],
      ["CRON[21877]: (deploy) CMD (/opt/tools/healthcheck.sh >/dev/null 2>&1)", 8],
      ["CRON[21901]: (root) CMD (/usr/local/bin/backup-db >/dev/null 2>&1)", 1],
      ["nginx[1187]: signal process started", 1],
      ["kernel: [1284002.113201] TCP: request_sock_TCP: Possible SYN flooding on port 443. Sending cookies.", 1],
      ["dhclient[612]: bound to 192.0.2.10 -- renewal in 42133 seconds.", 1],
      ["systemd-logind[540]: New session 1204 of user deploy.", 4],
      ["systemd-logind[540]: Removed session 1203.", 4],
    ] as const);
    return `${date} web01 ${unit}`;
  },

  "auth-log": (random, index, lines) => {
    const date = syslogDate(lineDate(index, lines));
    const ip = IPS[pick(random, 0, IPS.length - 1)];
    const port = pick(random, 40_000, 65_000);
    const line = choose(random, [
      [`sshd[${pick(random, 1000, 9999)}]: Accepted publickey for deploy from ${ip} port ${port} ssh2`, 4],
      [`sshd[${pick(random, 1000, 9999)}]: Disconnected from user deploy ${ip} port ${port}`, 4],
      [`sshd[${pick(random, 1000, 9999)}]: Invalid user admin from ${ip} port ${port}`, 5],
      [`sshd[${pick(random, 1000, 9999)}]: Connection closed by invalid user admin ${ip} port ${port} [preauth]`, 5],
      [`sudo:   deploy : TTY=pts/0 ; PWD=/var/www/app ; USER=root ; COMMAND=/usr/bin/systemctl restart app`, 2],
      [`systemd-logind[540]: New session 1204 of user deploy.`, 2],
    ] as const);
    return `${date} web01 ${line}`;
  },

  "dpkg-log": (random, index, lines) => {
    const date = lineDate(index, lines);
    const stamp = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    const pkg = choose(random, [
      ["nginx-common:all 1.26.2-1", 3],
      ["libc6:amd64 2.40-3", 2],
      ["openssl:amd64 3.3.2-1", 2],
      ["curl:amd64 8.9.1-2", 1],
      ["mariadb-server-core:amd64 1:11.4.3-1", 1],
    ] as const);
    const verb = choose(random, [
      ["status half-configured", 1],
      ["status unpacked", 1],
      ["status installed", 2],
      ["configure", 1],
      ["upgrade", 1],
    ] as const);
    return `${stamp} ${verb} ${pkg}`;
  },

  "mysql-error": (random, index, lines) => {
    const date = lineDate(index, lines)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    return choose(random, [
      [`${date} 0 [Note] InnoDB: Buffer pool(s) load completed at ${date}`, 3],
      [
        `${date} 0 [Warning] Aborted connection ${pick(random, 1000, 99_999)} to db: 'app' user: 'app' host: 'localhost' (Got an error reading communication packets)`,
        4,
      ],
      [`${date} 0 [Note] Event Scheduler: Loaded 0 events`, 1],
      [`${date} 0 [Warning] InnoDB: A long semaphore wait: ${pick(random, 240, 900)} seconds`, 1],
    ] as const);
  },

  csv: (random, index) => {
    if (index === 0) return "id,region,sku,units,unit_price,order_date";
    const region = choose(random, [
      ["EMEA", 5],
      ["NA", 4],
      ["APAC", 3],
    ] as const);
    const day = pick(random, 1, 28);
    return `${10_000 + index},${region},SKU-${pick(random, 100, 999)},${pick(random, 1, 40)},${(pick(random, 199, 9_999) / 100).toFixed(2)},2026-08-${pad(day)}`;
  },
};
