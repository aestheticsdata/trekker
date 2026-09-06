import type { FileSpec, Rel, TreeSpec } from "./corpus";
import { pick, seededRandom } from "./ids";

/**
 * The one source (TRE-140): a believable small web server, and everything the
 * database says about it. The tree below is materialised on disk by `tree.ts`;
 * the fixtures below it are loaded by `load.ts`. Both read this file and
 * nothing else, which is what makes a treemap rectangle land on a listing that
 * really holds that file at that size.
 *
 * Every time here is relative to one fixed instant, `REFERENCE`, and negative:
 * "three days before the reference". Materialising and loading shift all of
 * them by one delta so the newest thing lands on now. The content of the
 * generated logs is written against the reference too, so a file is the same
 * bytes on every machine and only its mtime moves.
 *
 * Nothing in here is real. Addresses come from the RFC 5737 documentation
 * ranges, hosts are under `example.com`, and there is no key, token or
 * password anywhere — this file is committed to a public repository.
 */

export const REFERENCE_ISO = "2026-09-01T12:00:00.000Z";
export const REFERENCE_MS = Date.parse(REFERENCE_ISO);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const TB = 1024 * GB;

/** `days(3)` is three days before the reference; `days(3, 4)` three days and four hours. */
const days = (count: number, hours = 0, minutes = 0): Rel => -(count * DAY + hours * HOUR + minutes * MINUTE);
const hours = (count: number, minutes = 0): Rel => -(count * HOUR + minutes * MINUTE);
const minutes = (count: number): Rel => -(count * MINUTE);

// ---------------------------------------------------------------- the hosts

/**
 * Four machines, all invented (TRE-148). One is the dev LOCAL host — the fake
 * tree, and the only one that answers. Three are SSH placeholders that cannot
 * connect: no credential, ever, and an address under `example.com`, which RFC
 * 2606 reserves for exactly this. They exist so that the SERVERS rail, the host
 * manager, the saved views and the transfer history describe a small fleet
 * rather than a demo — and so the chip in the path row carries a name, not
 * "This machine".
 *
 * The LOCAL host is pinned: `Views` blobs and `hostLabels` carry host ids, so
 * the id has to be the same on every load — and it is uuid-shaped because the
 * front's parser refuses anything else.
 */
export const LOCAL_HOST = {
  id: "01990000-c0de-7000-8000-000000000001",
  slug: "kestrel",
  label: "Kestrel",
  colour: "#7fa8c9",
} as const;

export type RemoteSlug = "marlow" | "sable" | "tundra";

export interface RemoteHostSpec {
  slug: RemoteSlug;
  label: string;
  address: string;
  /** Where the machine's sshd listens on the loopback: one port per machine, all above 1024. */
  port: number;
  username: string;
  /** What `id -u` answers, and who the files belong to in a listing. */
  uid: number;
  homePath: string;
  /** The allowlist: what a pane may list on it. The home, plus whatever a bookmark points at outside it. */
  roots: readonly string[];
  colour: string;
  bookmarks: readonly BookmarkSpec[];
}

/**
 * Three machines that ANSWER (TRE-148, second pass: "à aucun moment il n'y a
 * un des panes sur un autre server"). Each is an SSH server the mock runs
 * itself, in Node, from `pnpm mock:hosts` (`mock/sshd.ts`): ssh2's server
 * half, speaking SFTP over the machine's tree (`REMOTE_TREES` below) and
 * answering the handful of commands the driver runs — `df` from
 * `REMOTE_VOLUMES`, `du`, `tail` of `/proc`, `id`, `sha256sum` — the way a
 * Linux box would. Nothing to install, nothing outside this repository's
 * process tree. The API talks to them exactly as it talks to a server. Their
 * addresses stay names under `example.com`; the mock resolves those names to
 * the loopback for the API's process alone (`mock/example-dns.cjs`), so the
 * host manager and the activity log print `deploy@marlow.example.com`, never
 * an IP.
 *
 * The seed makes them and the loader looks them up by slug — making any that
 * are missing, keeping a found one's own credential if a developer stored one,
 * and otherwise sealing the demo password and the machine's host key onto it.
 *
 * Bookmark labels are unique across the four hosts, on purpose: the FAVOURITES
 * rail is addressed by label (`favourite-row[data-label]`), and a second
 * "Backups" made the storyboard's selector ambiguous.
 */
export const REMOTE_HOSTS: readonly RemoteHostSpec[] = [
  {
    slug: "marlow",
    label: "Marlow",
    address: "marlow.example.com",
    port: 2221,
    username: "deploy",
    uid: 501,
    homePath: "/srv/backups",
    roots: ["/srv/backups"],
    colour: "#c9a05a",
    bookmarks: [{ path: "/srv/backups", label: "Off-site copy", hint: "nightly, from Kestrel" }],
  },
  {
    slug: "sable",
    label: "Sable",
    address: "sable.example.com",
    port: 2222,
    username: "dba",
    uid: 501,
    homePath: "/home/dba",
    roots: ["/home/dba", "/var/lib/mysql"],
    colour: "#9fbf8a",
    bookmarks: [{ path: "/var/lib/mysql", label: "Replica data", hint: "MySQL, read-only" }],
  },
  {
    slug: "tundra",
    label: "Tundra",
    address: "tundra.example.com",
    port: 2223,
    username: "media",
    uid: 501,
    homePath: "/srv/media",
    roots: ["/srv/media"],
    colour: "#c98a7f",
    bookmarks: [{ path: "/srv/media", label: "Media origin", hint: "what the CDN pulls" }],
  },
];

/** The password every demo machine accepts for its user. Loopback only; never an app's name. */
export const REMOTE_PASSWORD = "off-site nightly";

// ---------------------------------------------------------------- the volumes

/**
 * What `df` says about Kestrel (TRE-148).
 *
 * The VOLUMES rail, the DISK USAGE strip's "of …" and the path-row badge all
 * read the host's `df`, and a LOCAL host's `df` is the machine the API runs
 * on — which on a laptop is a rail of `/System/Volumes/…` rows on camera: the
 * film machine's own disks, repeated. So `tree.ts` writes a `df` of its own
 * beside the tree (`<mock home>/bin/df`) that prints these rows in the three
 * shapes the API asks for, and the API is started with that directory first on
 * its PATH (`pnpm dev` does it through `df-on-path.ts`). Nothing in the API is
 * faked: the same parser reads the same columns.
 *
 * Diverse on purpose: a root, a fat MySQL volume past the warning line, an XFS
 * media volume, an LVM backups volume that is nearly full, a small `/boot`, an
 * NFS archive that keeps no inode count, and one tmpfs the default view hides.
 * The root is big enough to hold the tree with room to spare.
 */
export interface VolumeSpec {
  mountPoint: string;
  device: string;
  type: string;
  totalBytes: number;
  usedBytes: number;
  /** Null where the filesystem keeps no inode count — NFS and vfat here, as btrfs would. */
  inodes: { total: number; used: number } | null;
}

/**
 * Kestrel's disks, mounted INSIDE the tree.
 *
 * A mount point is a directory, and the VOLUMES rail opens it in the active
 * pane on a click. The fake `df` used to name `/srv/media` and `/var/lib/mysql`
 * as a Linux box would, and a click on either landed on "permission denied":
 * neither is a path inside the one root the dev LOCAL host is allowed to list.
 * Mock data has no business being less usable than the real thing, so every
 * mount point is now the tree's own directory of that name — `$TREE` is the
 * root, `$TREE/boot`, `$TREE/mnt/archive` — and `tree.ts` writes the real root
 * into the shim. The rail shortens a long mount point from the front
 * (`…/tree/srv/media`) and the tooltip carries it whole. Written as literal
 * `$TREE` strings rather than `tree()` calls only because that helper is
 * defined further down.
 */
export const VOLUMES: readonly VolumeSpec[] = [
  {
    // Big enough for the whole tree: the root scan walks every volume below
    // (the loaded scan does not stop at a mount), and the strip reads "N of
    // TOTAL" against this row, so a root smaller than the tree would read as
    // "131 GB of 69 GB". The used figure leaves the rail at two-thirds.
    mountPoint: "$TREE",
    device: "/dev/vda1",
    type: "ext4",
    totalBytes: 256 * GB,
    usedBytes: 171 * GB + 300 * MB,
    inodes: { total: 16_777_216, used: 1_412_880 },
  },
  {
    mountPoint: "$TREE/boot",
    device: "/dev/vda15",
    type: "vfat",
    totalBytes: 512 * MB,
    usedBytes: 171 * MB,
    inodes: null,
  },
  {
    mountPoint: "$TREE/var/lib/mysql",
    device: "/dev/vdb",
    type: "ext4",
    totalBytes: 200 * GB,
    usedBytes: 157 * GB,
    inodes: { total: 13_107_200, used: 9_412 },
  },
  {
    mountPoint: "$TREE/srv/media",
    device: "/dev/vdc1",
    type: "xfs",
    totalBytes: 2 * TB,
    usedBytes: 870 * GB,
    inodes: { total: 104_857_600, used: 1_284_006 },
  },
  {
    mountPoint: "$TREE/opt/backups",
    device: "/dev/mapper/vg0-backups",
    type: "ext4",
    totalBytes: 500 * GB,
    usedBytes: 441 * GB,
    inodes: { total: 32_768_000, used: 2_218 },
  },
  {
    mountPoint: "$TREE/mnt/archive",
    device: "archive.example.com:/export/archive",
    type: "nfs4",
    totalBytes: 8 * TB,
    usedBytes: 4_180 * GB,
    inodes: null,
  },
  {
    mountPoint: "$TREE/run",
    device: "tmpfs",
    type: "tmpfs",
    totalBytes: 320 * MB,
    usedBytes: 11 * MB,
    inodes: { total: 819_200, used: 940 },
  },
];

/**
 * Paths in the fixtures are written with this prefix in place of the tree's
 * root, which is only known on the machine doing the loading. `load.ts`
 * substitutes the real root; `corpus.spec.ts` checks every such path exists.
 */
export const TREE = "$TREE";
const tree = (rel: string): string => (rel === "" ? TREE : `${TREE}/${rel}`);

// ---------------------------------------------------------------- the tree

const RELEASE_FILES = (stamp: string, when: Rel, version: string, main: number, vendor: number): TreeSpec => ({
  [`var/www/app/releases/${stamp}/package.json`]: {
    kind: "text",
    mtime: when,
    content: `{\n  "name": "app",\n  "version": "${version}",\n  "private": true,\n  "scripts": {\n    "start": "node dist/main.js"\n  }\n}\n`,
  },
  [`var/www/app/releases/${stamp}/README.md`]: {
    kind: "text",
    mtime: when,
    content: `# app ${version}\n\nBuilt from \`main\` and deployed by \`home/deploy/scripts/deploy.sh\`.\nThe live release is whatever \`var/www/app/current\` points at.\n`,
  },
  [`var/www/app/releases/${stamp}/dist/main.js`]: {
    kind: "sparse",
    bytes: main,
    mtime: when,
  },
  [`var/www/app/releases/${stamp}/dist/vendor.js`]: {
    kind: "sparse",
    bytes: vendor,
    mtime: when,
  },
  [`var/www/app/releases/${stamp}/dist/styles.css`]: {
    kind: "text",
    mtime: when,
    content: `:root{--ink:#e6edf3;--ground:#0d1117}\nbody{margin:0;background:var(--ground);color:var(--ink);font:14px/1.5 system-ui}\n.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh}\n`,
  },
  [`var/www/app/releases/${stamp}/public/index.html`]: {
    kind: "text",
    mtime: when,
    content: `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>app ${version}</title><link rel="stylesheet" href="/assets/app.css"></head>\n<body><div id="root" class="app"></div><script src="/assets/app.js"></script></body>\n</html>\n`,
  },
  [`var/www/app/releases/${stamp}/public/robots.txt`]: {
    kind: "text",
    mtime: when,
    content: "User-agent: *\nDisallow: /api/\n",
  },
});

const API_RELEASE = (stamp: string, when: Rel, version: string, main: number): TreeSpec => ({
  [`var/www/api/releases/${stamp}/package.json`]: {
    kind: "text",
    mtime: when,
    content: `{\n  "name": "api",\n  "version": "${version}",\n  "private": true,\n  "scripts": {\n    "start": "node dist/main.js"\n  }\n}\n`,
  },
  [`var/www/api/releases/${stamp}/README.md`]: {
    kind: "text",
    mtime: when,
    content: `# api ${version}\n\nListens on 127.0.0.1:6800 behind nginx. Health at /api/health.\n`,
  },
  [`var/www/api/releases/${stamp}/dist/main.js`]: {
    kind: "sparse",
    bytes: main,
    mtime: when,
  },
});

// ---------------------------------------------------------------- the crowd

/**
 * The directories that are crowded on a real machine (TRE-148).
 *
 * The first cut of this tree held a hundred and fifty files, and every
 * listing fitted on one screen: a file manager filmed on it never scrolled,
 * never showed a page of one kind of thing, never had a directory worth a
 * treemap band. These families are the crowd — a catalogue of product images,
 * one event's gallery, a year of avatars, a month of nightly dumps, a
 * fortnight of rotated logs, an InnoDB data directory, an apt cache. Each is
 * written once as a rule and spelled out by a seeded generator, so the sizes
 * and dates are the same on every machine and the manifest stays readable.
 *
 * Nothing in a family is referenced by a fixture: the views, hashes and
 * transfers point at the hand-written entries above, and `corpus.spec.ts`
 * keeps `orders.ibd` the largest file — so every size here stays under it.
 */

/** One family: `count` entries into one rule, from one seeded generator. */
const crowd = (
  seed: string,
  count: number,
  entry: (random: () => number, index: number) => readonly [rel: string, spec: FileSpec],
): TreeSpec => {
  const random = seededRandom(`crowd:${seed}`);
  const out: Record<string, FileSpec> = {};
  for (let index = 0; index < count; index += 1) {
    const [rel, spec] = entry(random, index);
    out[rel] = spec;
  }
  return out;
};

/** A name per item, sized in kilobytes by a range, dated by a range of days back. */
const filesOf = (
  seed: string,
  dir: string,
  names: readonly string[],
  kb: readonly [min: number, max: number],
  ago: readonly [min: number, max: number],
): TreeSpec =>
  crowd(seed, names.length, (random, index) => [
    `${dir}/${names[index]}`,
    {
      kind: "sparse",
      bytes: pick(random, kb[0], kb[1]) * KB,
      mtime: days(pick(random, ago[0], ago[1]), pick(random, 0, 23)),
    },
  ]);

/** `YYYY-MM`, `back` months before the reference month (September 2026). */
const month = (back: number): string => {
  const index = 9 - 1 - back;
  const year = 2026 + Math.floor(index / 12);
  const mm = (((index % 12) + 12) % 12) + 1;
  return `${year}-${String(mm).padStart(2, "0")}`;
};

const two = (value: number): string => String(value).padStart(2, "0");

/** A logrotate run: `<name>.<n>.gz` for `n` in `[from, to]`, one a day back. */
const rotated = (dir: string, name: string, from: number, to: number, kb: readonly [number, number]): TreeSpec =>
  crowd(`rotated:${dir}/${name}`, to - from + 1, (random, index) => {
    const n = from + index;
    return [`${dir}/${name}.${n}.gz`, { kind: "sparse", bytes: pick(random, kb[0], kb[1]) * KB, mtime: days(n) }];
  });

// ---- srv/media: the catalogue, the gallery, the cuts of every video

const PRODUCT_IMAGES = crowd("products", 120, (random, index) => [
  `srv/media/images/products/sku-${10_021 + index * 3}.${random() < 0.6 ? "jpg" : "png"}`,
  {
    kind: "image",
    style: "product",
    width: 640,
    height: 480,
    bytes: pick(random, 80, 1_400) * KB,
    mtime: days(pick(random, 15, 400), pick(random, 0, 23)),
  },
]);

/** One event, straight off the camera: two frames a minute for over two hours. */
const GALLERY = crowd("gallery", 72, (random, index) => [
  `srv/media/images/gallery/2026-08-summit/IMG_${String(412 + index * 2).padStart(4, "0")}.jpg`,
  {
    kind: "image",
    style: "photo",
    width: 800,
    height: 533,
    bytes: pick(random, 1_100, 6_400) * KB,
    mtime: days(19, 3) + index * 2 * MINUTE,
  },
]);

const BANNERS = crowd("banners", 12, (random, index) => [
  `srv/media/images/banner-${month(index)}.jpg`,
  {
    kind: "image",
    style: "banner",
    width: 1200,
    height: 400,
    bytes: pick(random, 300, 900) * KB,
    mtime: days(index * 30 + 4, 10),
  },
]);

const PRODUCT_SHOTS = crowd("product-shots", 23, (random, index) => [
  `srv/media/images/product-${String.fromCharCode(100 + index)}.png`,
  {
    kind: "image",
    style: "product",
    width: 640,
    height: 480,
    bytes: pick(random, 140, 320) * KB,
    mtime: days(pick(random, 15, 120)),
  },
]);

const ICONS = crowd("icons", 10, (_random, index) => {
  const name = ["cart", "user", "search", "menu", "close", "check", "arrow-left", "arrow-right", "star", "heart"][
    index
  ];
  return [
    `srv/media/images/icon-${name}.svg`,
    {
      kind: "text",
      mtime: days(200),
      content: `<svg viewBox="0 0 24 24" aria-label="${name}"><path d="M4 12h16" stroke="currentColor" stroke-width="2" fill="none"/></svg>\n`,
    },
  ];
});

const VIDEO_CUTS = filesOf(
  "video-cuts",
  "srv/media/videos",
  ["launch-1080p.mp4", "launch-720p.mp4", "launch-480p.mp4", "tour-480p.mp4", "teaser.mp4", "teaser.webm"],
  [38_000, 1_240_000],
  [44, 48],
);

const PODCAST = crowd("podcast", 8, (random, index) => [
  `srv/media/videos/podcast-ep-${two(index + 1)}.m4a`,
  { kind: "sparse", bytes: pick(random, 40_000, 72_000) * KB, mtime: days(120 - index * 14, 8) },
]);

const CLIPS = crowd("clips", 12, (random, index) => {
  const topic = [
    "opening",
    "keynote",
    "panel",
    "demo",
    "workshop",
    "lightning",
    "interview",
    "roundtable",
    "fireside",
    "tour",
    "q-and-a",
    "closing",
  ][index];
  return [
    `srv/media/videos/clips/2026-08-15-${two(index + 1)}-${topic}.mp4`,
    { kind: "sparse", bytes: pick(random, 40_000, 900_000) * KB, mtime: days(16, 2) + index * 25 * MINUTE },
  ];
});

// ---- srv/uploads: what people sent in

const UPLOADS = {
  ...crowd("invoices", 7, (random, index) => [
    `srv/uploads/invoice-2026-${two(index + 1)}.pdf`,
    { kind: "sparse", bytes: pick(random, 180, 260) * KB, mtime: days((7 - index) * 30 + 4, 9) },
  ]),
  "srv/uploads/contract-dovetail-2026.pdf": { kind: "sparse", bytes: 1_4 * 100 * KB, mtime: days(63, 4) },
  "srv/uploads/quote-4471.pdf": { kind: "sparse", bytes: 96 * KB, mtime: days(2, 6) },
  "srv/uploads/signed-nda.pdf": { kind: "sparse", bytes: 310 * KB, mtime: days(9, 1) },
  "srv/uploads/photos-office-2026.zip": { kind: "sparse", bytes: 48 * MB, mtime: days(33, 5) },
} satisfies TreeSpec;

// ---- var/www: what the app keeps beside its releases

const AVATARS = crowd("avatars", 90, (random, index) => [
  `var/www/app/shared/uploads/avatars/u-${1_007 + index}.png`,
  {
    kind: "image",
    style: "avatar",
    width: 128,
    height: 128,
    bytes: pick(random, 2, 180) * KB,
    mtime: days(pick(random, 1, 365), pick(random, 0, 23)),
  },
]);

const EXPORTS = crowd("exports", 11, (random, index) => [
  `var/www/app/shared/uploads/exports/orders-${month(index + 1)}.csv`,
  { kind: "generated", generator: "csv", lines: pick(random, 800, 2_800), mtime: days((index + 1) * 30 + 1, 2) },
]);

const ATTACHMENTS = crowd("attachments", 40, (random, index) => [
  `var/www/app/shared/uploads/attachments/inv-2026-${two(3 + (index % 6))}-${100 + index * 7}.pdf`,
  { kind: "sparse", bytes: pick(random, 60, 2_000) * KB, mtime: days(pick(random, 1, 180), pick(random, 0, 23)) },
]);

// ---- var/log: a fortnight of logrotate

const ROTATED_LOGS = {
  ...rotated("var/log/nginx", "access.log", 5, 14, [1_400, 1_900]),
  ...rotated("var/log/nginx", "error.log", 2, 7, [20, 60]),
  ...rotated("var/log/app", "app.log", 3, 14, [700, 1_100]),
  "var/log/app/api.log.1": { kind: "generated", generator: "app-json", lines: 1_800, mtime: days(1) },
  ...rotated("var/log/app", "api.log", 2, 7, [400, 700]),
  ...rotated("var/log", "syslog", 2, 7, [90, 160]),
  ...rotated("var/log", "auth.log", 2, 4, [30, 60]),
  "var/log/kern.log.1": { kind: "generated", generator: "syslog", lines: 120, mtime: days(7) },
  "var/log/dpkg.log.1": { kind: "generated", generator: "dpkg-log", lines: 180, mtime: days(37) },
  "var/log/alternatives.log": {
    kind: "text",
    mtime: days(9),
    content:
      "update-alternatives 2026-08-23 06:25:11: run with --install /usr/bin/editor editor /usr/bin/vim.basic 30\nupdate-alternatives 2026-08-23 06:25:11: link group editor updated to point to /usr/bin/vim.basic\n",
  },
  "var/log/cloud-init.log": { kind: "sparse", bytes: 380 * KB, mtime: days(512) },
  "var/log/cloud-init-output.log": { kind: "sparse", bytes: 42 * KB, mtime: days(512) },
  "var/log/btmp": { kind: "sparse", bytes: 1_2 * 100 * KB, mtime: hours(3), mode: 0o660 },
  "var/log/wtmp": { kind: "sparse", bytes: 220 * KB, mtime: minutes(30), mode: 0o664 },
  "var/log/lastlog": { kind: "sparse", bytes: 292 * KB, mtime: minutes(30), mode: 0o664 },
  "var/log/faillog": { kind: "sparse", bytes: 32 * KB, mtime: days(90) },
  "var/log/fail2ban.log": { kind: "sparse", bytes: 640 * KB, mtime: hours(1) },
  "var/log/apt/history.log": {
    kind: "text",
    mtime: days(9),
    content:
      "Start-Date: 2026-08-23  06:25:02\nCommandline: apt-get -y upgrade\nUpgrade: nginx:amd64 (1.26.1-1, 1.26.2-1), nginx-common:amd64 (1.26.1-1, 1.26.2-1), openssl:amd64 (3.3.1-1, 3.3.2-1)\nEnd-Date: 2026-08-23  06:25:19\n",
  },
  "var/log/apt/term.log": { kind: "sparse", bytes: 80 * KB, mtime: days(9) },
  "var/log/apt/eipp.log.xz": { kind: "sparse", bytes: 30 * KB, mtime: days(9) },
  "var/log/unattended-upgrades/unattended-upgrades.log": { kind: "sparse", bytes: 12 * KB, mtime: days(1) },
  "var/log/mysql/slow.log": { kind: "sparse", bytes: 3_1 * 100 * KB, mtime: hours(2) },
} satisfies TreeSpec;

const JOURNALS = crowd("journals", 9, (random, index) => [
  `var/log/journal/7f1c2b9e4d0a4c1b9e3f8a2d5c6b7a90/system@0005b3a1-${String(index + 3).padStart(16, "0")}.journal`,
  { kind: "sparse", bytes: pick(random, 64, 128) * MB, mtime: days(9 + index * 3) },
]);

// ---- opt/backups: a month of nightly dumps, a year of monthly tarballs

const NIGHTLY_DUMPS = crowd("dumps", 24, (_random, index) => {
  const day = index + 1;
  return [
    `opt/backups/db-2026-08-${two(day)}.sql.gz`,
    { kind: "sparse", bytes: (371 + day) * MB, mtime: days(32 - day, 9, 30) },
  ];
});

const MONTHLY_TARBALLS = crowd("tarballs", 10, (random, index) => {
  const back = index + 3;
  return [
    `opt/backups/site-${month(back)}-01.tar.gz`,
    { kind: "sparse", bytes: pick(random, 1_030, 1_170) * MB, mtime: days(back * 30 + 1, 9) },
  ];
});

// ---- var/lib/mysql: the rest of the data directory

const TABLES = filesOf(
  "tables",
  "var/lib/mysql/app",
  [
    "products.ibd",
    "customers.ibd",
    "addresses.ibd",
    "invoices.ibd",
    "invoice_lines.ibd",
    "payments.ibd",
    "carts.ibd",
    "cart_items.ibd",
    "shipments.ibd",
    "coupons.ibd",
    "reviews.ibd",
    "categories.ibd",
    "inventory.ibd",
    "webhooks.ibd",
    "jobs.ibd",
    "migrations.ibd",
    "notifications.ibd",
    "api_keys.ibd",
  ],
  [96, 1_100_000],
  [0, 0],
);

const SYSTEM_TABLES = filesOf(
  "system-tables",
  "var/lib/mysql/mysql",
  [
    "global_priv.MAD",
    "db.MYD",
    "proc.MYD",
    "innodb_table_stats.ibd",
    "innodb_index_stats.ibd",
    "transaction_registry.ibd",
  ],
  [4, 128],
  [30, 30],
);

const BINLOGS = {
  ...crowd("binlogs", 12, (random, index) => [
    `var/lib/mysql/binlog.${String(121 + index).padStart(6, "0")}`,
    {
      kind: "sparse",
      bytes: index === 11 ? 37 * MB : pick(random, 99, 100) * MB + pick(random, 0, 1_023) * KB,
      mtime: days(11 - index, 3),
    },
  ]),
  "var/lib/mysql/binlog.index": {
    kind: "text",
    mtime: hours(2),
    content: `${Array.from({ length: 12 }, (_, index) => `./binlog.${String(121 + index).padStart(6, "0")}`).join("\n")}\n`,
  },
  "var/lib/mysql/app/db.opt": {
    kind: "text",
    mtime: days(512),
    content: "default-character-set=utf8mb4\ndefault-collation=utf8mb4_unicode_ci\n",
  },
} satisfies TreeSpec;

// ---- home: a year of exports, and what deploy downloaded

const SALES = crowd("sales", 10, (random, index) => {
  const back = index + 3;
  return [
    `home/alice/projects/sales-${month(back)}.csv`,
    { kind: "generated", generator: "csv", lines: pick(random, 1_500, 2_300), mtime: days(back * 30 + 6) },
  ];
});

const DOWNLOADS = filesOf(
  "downloads",
  "home/deploy/downloads",
  [
    "node-v22.12.0-linux-x64.tar.xz",
    "node-v20.18.1-linux-x64.tar.xz",
    "mariadb-11.4.3-linux-systemd-x86_64.tar.gz",
    "caddy_2.9.1_linux_amd64.tar.gz",
    "restic_0.17.3_linux_amd64.bz2",
    "promtail-linux-amd64.zip",
  ],
  [7_000, 420_000],
  [60, 300],
);

// ---- var/cache/apt: what the last upgrades pulled

const DEBS = filesOf(
  "debs",
  "var/cache/apt/archives",
  [
    "curl_8.11.1-1_amd64.deb",
    "git_2.47.1-1_amd64.deb",
    "vim_9.1.0967-1_amd64.deb",
    "htop_3.3.0-4_amd64.deb",
    "tmux_3.5a-2_amd64.deb",
    "rsync_3.3.0-1_amd64.deb",
    "zstd_1.5.6-1_amd64.deb",
    "python3_3.12.8-1_amd64.deb",
    "python3-pip_24.3.1-1_all.deb",
    "libssl3t64_3.3.2-1_amd64.deb",
    "ca-certificates_20241223_all.deb",
    "tzdata_2024b-3_all.deb",
    "logrotate_3.22.0-1_amd64.deb",
    "cron_3.0pl1-189_amd64.deb",
    "openssh-server_9.9p1-3_amd64.deb",
    "openssh-client_9.9p1-3_amd64.deb",
    "fail2ban_1.1.0-6_all.deb",
    "ufw_0.36.2-7_all.deb",
    "certbot_2.11.0-1_all.deb",
    "mariadb-client_11.4.3-1_amd64.deb",
    "mariadb-common_11.4.3-1_all.deb",
    "redis-server_7.4.1-1_amd64.deb",
    "jq_1.7.1-3_amd64.deb",
    "unzip_6.0-28_amd64.deb",
    "wget_1.25.0-1_amd64.deb",
    "less_668-1_amd64.deb",
    "sudo_1.9.16p2-1_amd64.deb",
    "systemd_257.2-3_amd64.deb",
    "libc-bin_2.40-3_amd64.deb",
    "linux-image-6.12.9-amd64_6.12.9-1_amd64.deb",
  ],
  [40, 9_000],
  [9, 60],
);

// ---- etc: the rest of what a Debian install puts there

const ETC_EXTRAS = {
  ...crowd("cron.daily", 5, (_random, index) => {
    const name = ["apt-compat", "dpkg", "logrotate", "man-db", "backup-db"][index];
    return [
      `etc/cron.daily/${name}`,
      { kind: "text", mtime: days(512), mode: 0o755, content: `#!/bin/sh\n# ${name}, run daily by cron\nexit 0\n` },
    ];
  }),
  ...crowd("logrotate.d", 4, (_random, index) => {
    const name = ["apt", "dpkg", "mysql-server", "rsyslog"][index];
    return [
      `etc/logrotate.d/${name}`,
      {
        kind: "text",
        mtime: days(512),
        content: `/var/log/${name}.log {\n  rotate 12\n  monthly\n  compress\n  missingok\n  notifempty\n}\n`,
      },
    ];
  }),
  "etc/nginx/snippets/ssl-params.conf": {
    kind: "text",
    mtime: days(61),
    content:
      "ssl_protocols TLSv1.2 TLSv1.3;\nssl_prefer_server_ciphers on;\nssl_session_timeout 1d;\nssl_session_cache shared:SSL:10m;\n",
  },
  "etc/nginx/snippets/proxy-params.conf": {
    kind: "text",
    mtime: days(61),
    content:
      "proxy_http_version 1.1;\nproxy_set_header Host $host;\nproxy_set_header X-Real-IP $remote_addr;\nproxy_set_header X-Forwarded-Proto $scheme;\n",
  },
  "etc/ssl/certs/ca-certificates.crt": { kind: "sparse", bytes: 214 * KB, mtime: days(9) },
} satisfies TreeSpec;

// ---- boot, mnt/archive, run: the partitions the VOLUMES rail opens

const BOOT = {
  ...filesOf(
    "boot",
    "boot",
    [
      "vmlinuz-6.12.9-amd64",
      "initrd.img-6.12.9-amd64",
      "config-6.12.9-amd64",
      "System.map-6.12.9-amd64",
      "vmlinuz-6.12.6-amd64",
      "initrd.img-6.12.6-amd64",
      "config-6.12.6-amd64",
      "System.map-6.12.6-amd64",
    ],
    [280, 38_000],
    [9, 60],
  ),
  "boot/grub/grub.cfg": {
    kind: "text",
    mtime: days(9),
    content:
      "# DO NOT EDIT THIS FILE — generated by grub-mkconfig\nset default=0\nset timeout=5\nmenuentry 'Debian GNU/Linux' {\n  linux /vmlinuz-6.12.9-amd64 root=UUID=3f2c1a90-0000-4d0c-8000-000000000001 ro quiet\n  initrd /initrd.img-6.12.9-amd64\n}\n",
  },
  "boot/grub/grubenv": { kind: "text", mtime: days(9), content: "# GRUB Environment Block\nsaved_entry=0\n" },
  "boot/grub/fonts/unicode.pf2": { kind: "sparse", bytes: 2_4 * 100 * KB, mtime: days(512) },
  ...filesOf(
    "grub-modules",
    "boot/grub/x86_64-efi",
    ["normal.mod", "linux.mod", "part_gpt.mod", "ext2.mod", "fat.mod", "gzio.mod", "search.mod", "efi_gop.mod"],
    [8, 120],
    [512, 512],
  ),
  "boot/efi/EFI/debian/grubx64.efi": { kind: "sparse", bytes: 1_1 * 100 * KB, mtime: days(512) },
  "boot/efi/EFI/debian/shimx64.efi": { kind: "sparse", bytes: 960 * KB, mtime: days(512) },
  "boot/efi/EFI/BOOT/BOOTX64.EFI": { kind: "sparse", bytes: 960 * KB, mtime: days(512) },
} satisfies TreeSpec;

/** The NFS archive: two years of monthly dumps and tarballs, and the photo sets nobody deletes. */
const ARCHIVE = {
  ...crowd("archive-db", 24, (random, index) => [
    `mnt/archive/db-${month(index + 12)}.sql.gz`,
    { kind: "sparse", bytes: pick(random, 900, 1_400) * MB, mtime: days((index + 12) * 30 + 1, 9, 30) },
  ]),
  ...crowd("archive-sites", 24, (random, index) => [
    `mnt/archive/site-${month(index + 12)}.tar.gz`,
    { kind: "sparse", bytes: pick(random, 600, 1_900) * MB, mtime: days((index + 12) * 30 + 1, 10) },
  ]),
  ...crowd("archive-photos", 6, (random, index) => [
    `mnt/archive/photos-${2019 + index}.tar`,
    { kind: "sparse", bytes: pick(random, 1_200, 2_000) * MB, mtime: days((7 - index) * 365 - 200, 14) },
  ]),
  "mnt/archive/README": {
    kind: "text",
    mtime: days(400),
    content:
      "Mounted read-only from archive.example.com:/export/archive.\nWhat is here was swept off /opt/backups by the quarterly job; nothing is written from this machine.\n",
  },
} satisfies TreeSpec;

/** `/run`, so the tmpfs the rail hides still has a directory behind it. */
const RUN = {
  "run/nginx.pid": { kind: "text", mtime: hours(30), content: "1187\n" },
  "run/sshd.pid": { kind: "text", mtime: days(21), content: "842\n" },
  "run/mysqld/mysqld.pid": { kind: "text", mtime: hours(2), content: "1301\n" },
  "run/utmp": { kind: "sparse", bytes: 3 * KB, mtime: minutes(30) },
} satisfies TreeSpec;

// ---- the three remote machines: what each one serves, and what its df says

/** The off-site copy: the same dumps and tarballs, pulled an hour after they are made, and the rotated logs. */
const MARLOW_TREE = {
  ...crowd("marlow-dumps", 31, (_random, index) => {
    const day = index + 1;
    const late = [396, 398, 399, 401, 401, 405, 409];
    return [
      `srv/backups/db-2026-08-${two(day)}.sql.gz`,
      { kind: "sparse", bytes: (day <= 24 ? 371 + day : late[day - 25]) * MB, mtime: days(32 - day, 8, 50) },
    ];
  }),
  ...crowd("marlow-tarballs", 14, (random, index) => [
    `srv/backups/site-${month(index + 1)}-01.tar.gz`,
    { kind: "sparse", bytes: pick(random, 1_030, 1_270) * MB, mtime: days((index + 1) * 30 + 1, 8, 20) },
  ]),
  ...rotated("srv/backups/logs", "access.log", 2, 14, [1_400, 1_900]),
  ...rotated("srv/backups/logs", "error.log", 2, 7, [20, 60]),
  ...rotated("srv/backups/logs", "app.log", 3, 14, [700, 1_100]),
  "srv/backups/README": {
    kind: "text",
    mtime: days(140),
    content:
      "Off-site copies, pulled from Kestrel by rsync at 02:30 every night.\nDumps are kept 31 days, tarballs 14 months, rotated logs a fortnight.\nNothing here is written by hand.\n",
  },
  "srv/backups/.sync-state": {
    kind: "text",
    mtime: hours(9, 30),
    content: '{"lastRun":"2026-09-01T02:30:04Z","transferred":"411.7 MB","files":3,"exit":0}\n',
  },
  "srv/backups/verify-2026-08-31.txt": {
    kind: "text",
    mtime: hours(9, 28),
    content: "db-2026-08-31.sql.gz  OK\nsite-2026-08-01.tar.gz  OK\n3 files checked, 0 mismatches\n",
  },
} satisfies TreeSpec;

/** The replica: the same data directory a step behind, and the exports the dba pulls from it. */
const SABLE_TREE = {
  ...crowd("sable-exports", 8, (random, index) => [
    `home/dba/exports/orders-${month(index)}.csv`,
    { kind: "generated", generator: "csv", lines: pick(random, 800, 2_800), mtime: days(index * 30 + 1, 3) },
  ]),
  "home/dba/exports/customers-2026-08.csv": {
    kind: "generated",
    generator: "csv",
    lines: 1_200,
    mtime: days(1, 3, 10),
  },
  "home/dba/scripts/replica-lag.sh": {
    kind: "text",
    mtime: days(120),
    mode: 0o755,
    content: "#!/usr/bin/env bash\nmysql -e 'SHOW REPLICA STATUS\\G' | grep -E 'Seconds_Behind|Running'\n",
  },
  "home/dba/scripts/dump-tables.sh": {
    kind: "text",
    mtime: days(120),
    mode: 0o755,
    content:
      '#!/usr/bin/env bash\nset -Eeuo pipefail\nfor t in orders customers; do\n  mysql app -e "SELECT * FROM $t" > "$HOME/exports/$t-$(date +%Y-%m).csv"\ndone\n',
  },
  "home/dba/notes.md": {
    kind: "text",
    mtime: days(9),
    content:
      "# replica\n\nLag is under a second except during the nightly dump on Kestrel (02:00–02:20).\nExports go to ~/exports and are pulled by alice on the 1st.\n",
  },
  "home/dba/.bashrc": {
    kind: "text",
    mtime: days(250),
    content: "# ~/.bashrc\nalias ll='ls -alF'\nexport PAGER=less\n",
  },
  "var/lib/mysql/ibdata1": { kind: "sparse", bytes: 1_210 * MB, mtime: hours(2, 1) },
  "var/lib/mysql/ib_logfile0": { kind: "sparse", bytes: 48 * MB, mtime: hours(2, 1) },
  "var/lib/mysql/ib_logfile1": { kind: "sparse", bytes: 48 * MB, mtime: hours(2, 5) },
  "var/lib/mysql/app/orders.ibd": { kind: "sparse", bytes: 2_140 * MB, mtime: hours(2, 1) },
  "var/lib/mysql/app/order_items.ibd": { kind: "sparse", bytes: 1_630 * MB, mtime: hours(2, 1) },
  "var/lib/mysql/app/users.ibd": { kind: "sparse", bytes: 380 * MB, mtime: hours(2, 1) },
  "var/lib/mysql/app/sessions.ibd": { kind: "sparse", bytes: 190 * MB, mtime: hours(2, 1) },
  "var/lib/mysql/app/audit.ibd": { kind: "sparse", bytes: 512 * MB, mtime: hours(2, 1) },
  ...filesOf(
    "sable-tables",
    "var/lib/mysql/app",
    [
      "products.ibd",
      "customers.ibd",
      "addresses.ibd",
      "invoices.ibd",
      "invoice_lines.ibd",
      "payments.ibd",
      "carts.ibd",
      "cart_items.ibd",
      "shipments.ibd",
      "coupons.ibd",
      "reviews.ibd",
      "categories.ibd",
      "inventory.ibd",
      "webhooks.ibd",
      "jobs.ibd",
      "migrations.ibd",
      "notifications.ibd",
      "api_keys.ibd",
    ],
    [96, 1_100_000],
    [0, 0],
  ),
  "var/lib/mysql/app/db.opt": {
    kind: "text",
    mtime: days(512),
    content: "default-character-set=utf8mb4\ndefault-collation=utf8mb4_unicode_ci\n",
  },
  ...crowd("sable-relay", 6, (random, index) => [
    `var/lib/mysql/relay-bin.${String(42 + index).padStart(6, "0")}`,
    { kind: "sparse", bytes: index === 5 ? 21 * MB : pick(random, 99, 100) * MB, mtime: days(5 - index, 3) },
  ]),
  "var/lib/mysql/relay-bin.index": {
    kind: "text",
    mtime: hours(2),
    content: `${Array.from({ length: 6 }, (_, index) => `./relay-bin.${String(42 + index).padStart(6, "0")}`).join("\n")}\n`,
  },
  "var/lib/mysql/auto.cnf": {
    kind: "text",
    mtime: days(512),
    content: "[auto]\nserver-uuid=2b7d0e4a-9c31-4f6e-8d25-6a1b3c9e7f40\n",
  },
} satisfies TreeSpec;

/** The media origin: what the CDN pulls, plus what arrived and is not yet sorted. */
const TUNDRA_TREE = {
  ...PRODUCT_IMAGES,
  ...GALLERY,
  ...BANNERS,
  ...PRODUCT_SHOTS,
  ...ICONS,
  ...VIDEO_CUTS,
  ...PODCAST,
  ...CLIPS,
  "srv/media/images/hero-01.jpg": {
    kind: "image",
    style: "photo",
    width: 1600,
    height: 900,
    bytes: 7_6 * 100 * KB,
    mtime: days(60),
  },
  "srv/media/images/hero-02.jpg": {
    kind: "image",
    style: "photo",
    width: 1600,
    height: 900,
    bytes: 7_1 * 100 * KB,
    mtime: days(60),
  },
  "srv/media/images/hero-03.jpg": {
    kind: "image",
    style: "photo",
    width: 1600,
    height: 900,
    bytes: 6_1 * 100 * KB,
    mtime: days(58),
  },
  "srv/media/videos/launch.mp4": { kind: "sparse", bytes: 1_820 * MB, mtime: days(48) },
  "srv/media/videos/tour.mp4": { kind: "sparse", bytes: 642 * MB, mtime: days(48) },
  "srv/media/videos/tour-720p.mp4": { kind: "sparse", bytes: 214 * MB, mtime: days(47) },
  ...crowd("tundra-incoming", 20, (random, index) => [
    `srv/media/incoming/2026-08-summit/IMG_${String(560 + index * 2).padStart(4, "0")}.jpg`,
    {
      kind: "image",
      style: "photo",
      width: 800,
      height: 533,
      bytes: pick(random, 1_100, 6_400) * KB,
      mtime: days(18, 6) + index * 2 * MINUTE,
    },
  ]),
  "srv/media/incoming/README": {
    kind: "text",
    mtime: days(200),
    content: "Drop zone. What lands here is sorted into images/ or videos/ by hand, then the CDN picks it up.\n",
  },
  ...crowd("tundra-cache", 60, (random, index) => [
    `srv/media/cache/sku-${10_021 + index * 3}-thumb.jpg`,
    {
      kind: "image",
      style: "product",
      width: 160,
      height: 120,
      bytes: pick(random, 8, 20) * KB,
      mtime: days(pick(random, 1, 60)),
    },
  ]),
  "srv/media/robots.txt": {
    kind: "text",
    mtime: days(200),
    content: "User-agent: *\nDisallow: /incoming/\nDisallow: /cache/\n",
  },
} satisfies TreeSpec;

/**
 * What each remote serves, keyed by slug. Paths are absolute on the machine
 * (`srv/backups/…` is `/srv/backups/…` there); `tree.ts` writes them under
 * `<mock home>/hosts/<slug>/tree/`, and the machine's sshd maps `/` onto that.
 */
export const REMOTE_TREES: Readonly<Record<RemoteSlug, TreeSpec>> = {
  marlow: MARLOW_TREE,
  sable: SABLE_TREE,
  tundra: TUNDRA_TREE,
};

/** Each remote's `df`, at the machine's own paths — no `$TREE`, the sshd's `/` is the tree. */
export const REMOTE_VOLUMES: Readonly<Record<RemoteSlug, readonly VolumeSpec[]>> = {
  marlow: [
    {
      mountPoint: "/",
      device: "/dev/sda1",
      type: "ext4",
      totalBytes: 40 * GB,
      usedBytes: 12 * GB + 400 * MB,
      inodes: { total: 2_621_440, used: 188_204 },
    },
    {
      mountPoint: "/srv/backups",
      device: "/dev/mapper/vg0-offsite",
      type: "ext4",
      totalBytes: 4 * TB,
      usedBytes: 2_840 * GB,
      inodes: { total: 268_435_456, used: 1_912 },
    },
    {
      mountPoint: "/run",
      device: "tmpfs",
      type: "tmpfs",
      totalBytes: 200 * MB,
      usedBytes: 4 * MB,
      inodes: { total: 512_000, used: 620 },
    },
  ],
  sable: [
    {
      mountPoint: "/",
      device: "/dev/nvme0n1p2",
      type: "ext4",
      totalBytes: 32 * GB,
      usedBytes: 14 * GB + 100 * MB,
      inodes: { total: 2_097_152, used: 210_440 },
    },
    {
      mountPoint: "/var/lib/mysql",
      device: "/dev/nvme1n1",
      type: "xfs",
      totalBytes: 400 * GB,
      usedBytes: 208 * GB,
      inodes: { total: 209_715_200, used: 8_806 },
    },
    {
      mountPoint: "/run",
      device: "tmpfs",
      type: "tmpfs",
      totalBytes: 800 * MB,
      usedBytes: 9 * MB,
      inodes: { total: 2_048_000, used: 880 },
    },
  ],
  tundra: [
    {
      mountPoint: "/",
      device: "/dev/vda1",
      type: "ext4",
      totalBytes: 20 * GB,
      usedBytes: 7 * GB + 600 * MB,
      inodes: { total: 1_310_720, used: 96_120 },
    },
    {
      mountPoint: "/srv/media",
      device: "/dev/md0",
      type: "xfs",
      totalBytes: 12 * TB,
      usedBytes: 7_560 * GB,
      inodes: { total: 1_288_490_188, used: 2_410_772 },
    },
    {
      mountPoint: "/run",
      device: "tmpfs",
      type: "tmpfs",
      totalBytes: 400 * MB,
      usedBytes: 6 * MB,
      inodes: { total: 1_024_000, used: 710 },
    },
  ],
};

export const TREE_SPEC: TreeSpec = {
  // ---- etc ------------------------------------------------------------
  "etc/hostname": { kind: "text", mtime: days(512), content: "web01\n" },
  "etc/hosts": {
    kind: "text",
    mtime: days(512),
    content:
      "127.0.0.1\tlocalhost\n127.0.1.1\tweb01.example.com web01\n192.0.2.10\tweb01\n192.0.2.20\tdb01\n\n::1\tlocalhost ip6-localhost ip6-loopback\n",
  },
  "etc/fstab": {
    kind: "text",
    mtime: days(512),
    content:
      "# <file system> <mount point> <type> <options> <dump> <pass>\nUUID=3f2c1a90-0000-4d0c-8000-000000000001 / ext4 errors=remount-ro 0 1\nUUID=3F2C-1A90 /boot vfat umask=0077 0 1\n/dev/vdb /var/lib/mysql ext4 noatime 0 2\n/dev/vdc1 /srv/media xfs noatime 0 2\n/dev/mapper/vg0-backups /opt/backups ext4 noatime 0 2\narchive.example.com:/export/archive /mnt/archive nfs4 ro,_netdev 0 0\n",
  },
  "etc/os-release": {
    kind: "text",
    mtime: days(512),
    content:
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION="12 (bookworm)"\nID=debian\n',
  },
  "etc/crontab": {
    kind: "text",
    mtime: days(90),
    content:
      "SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n25 6\t* * *\troot\ttest -x /usr/sbin/anacron || ( cd / && run-parts --report /etc/cron.daily )\n",
  },
  "etc/ssh/sshd_config": {
    kind: "text",
    mtime: days(512),
    mode: 0o600,
    content:
      "Port 22\nAddressFamily any\nPermitRootLogin no\nPasswordAuthentication no\nPubkeyAuthentication yes\nAllowUsers deploy alice\nClientAliveInterval 120\nSubsystem sftp /usr/lib/openssh/sftp-server\n",
  },
  "etc/nginx/nginx.conf": {
    kind: "text",
    mtime: days(61),
    content:
      "user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents {\n  worker_connections 1024;\n}\n\nhttp {\n  include mime.types;\n  default_type application/octet-stream;\n  sendfile on;\n  keepalive_timeout 65;\n  gzip on;\n\n  limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;\n\n  access_log /var/log/nginx/access.log;\n  error_log /var/log/nginx/error.log;\n\n  include sites-enabled/*;\n}\n",
  },
  "etc/nginx/mime.types": {
    kind: "text",
    mtime: days(512),
    content:
      "types {\n  text/html html htm;\n  text/css css;\n  application/javascript js;\n  application/json json;\n  image/png png;\n  image/jpeg jpg jpeg;\n  image/svg+xml svg;\n  video/mp4 mp4;\n  application/pdf pdf;\n  application/gzip gz;\n}\n",
  },
  "etc/nginx/sites-available/app.conf": {
    kind: "text",
    mtime: days(12),
    content:
      "server {\n  listen 443 ssl http2;\n  server_name app.example.com;\n\n  root /var/www/app/current/public;\n\n  location /assets/ {\n    expires 30d;\n  }\n\n  location / {\n    try_files $uri /index.html;\n  }\n}\n",
  },
  "etc/nginx/sites-available/api.conf": {
    kind: "text",
    mtime: days(12),
    content:
      "server {\n  listen 443 ssl http2;\n  server_name api.example.com;\n\n  location /api/ {\n    limit_req zone=api burst=20 nodelay;\n    proxy_pass http://127.0.0.1:6800;\n    proxy_set_header X-Forwarded-For $remote_addr;\n  }\n}\n",
  },
  "etc/nginx/sites-enabled/app.conf": {
    kind: "symlink",
    target: "../sites-available/app.conf",
    mtime: days(12),
  },
  "etc/nginx/sites-enabled/api.conf": {
    kind: "symlink",
    target: "../sites-available/api.conf",
    mtime: days(12),
  },
  "etc/logrotate.d/nginx": {
    kind: "text",
    mtime: days(512),
    content:
      "/var/log/nginx/*.log {\n  daily\n  missingok\n  rotate 14\n  compress\n  delaycompress\n  notifempty\n  create 0640 www-data adm\n  sharedscripts\n  postrotate\n    invoke-rc.d nginx rotate >/dev/null 2>&1\n  endscript\n}\n",
  },
  "etc/cron.d/backup": {
    kind: "text",
    mtime: days(44),
    content: "# nightly dump, kept a week; see /opt/backups/README.md\n30 2 * * * root /usr/local/bin/backup-db\n",
  },
  "etc/systemd/system/app.service": {
    kind: "text",
    mtime: days(30),
    content:
      "[Unit]\nDescription=app (front)\nAfter=network.target\n\n[Service]\nUser=deploy\nWorkingDirectory=/var/www/app/current\nExecStart=/usr/bin/node dist/main.js\nRestart=on-failure\nEnvironment=NODE_ENV=production\n\n[Install]\nWantedBy=multi-user.target\n",
  },
  "etc/systemd/system/api.service": {
    kind: "text",
    mtime: days(30),
    content:
      "[Unit]\nDescription=api\nAfter=network.target mariadb.service\n\n[Service]\nUser=deploy\nWorkingDirectory=/var/www/api/current\nExecStart=/usr/bin/node dist/main.js\nRestart=on-failure\nEnvironment=NODE_ENV=production\nEnvironment=PORT=6800\n\n[Install]\nWantedBy=multi-user.target\n",
  },

  // ---- home -----------------------------------------------------------
  "home/deploy/.bashrc": {
    kind: "text",
    mtime: days(300),
    content:
      "# ~/.bashrc\ncase $- in *i*) ;; *) return;; esac\nHISTSIZE=5000\nexport PATH=\"$HOME/.local/bin:$PATH\"\nalias ll='ls -alF'\nalias logs='tail -F /var/log/app/app.log'\n",
  },
  "home/deploy/.profile": {
    kind: "text",
    mtime: days(300),
    content: 'if [ -n "$BASH_VERSION" ]; then\n  [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\nfi\n',
  },
  "home/deploy/.ssh/config": {
    kind: "text",
    mtime: days(120),
    mode: 0o600,
    content: "Host db01\n  HostName 192.0.2.20\n  User deploy\n\nHost *\n  ServerAliveInterval 60\n",
  },
  "home/deploy/notes.md": {
    kind: "text",
    mtime: days(3),
    content:
      "# ops notes\n\n- releases live under /var/www/app/releases, `current` is a symlink — never edit a release in place\n- nightly dump at 02:30, a week kept; the monthly site tarball is in /opt/backups too\n- mysql sits on its own filesystem (see fstab); orders.ibd is the one that grows\n- rotate-logs.sh is what logrotate does not cover (the app's own JSON logs)\n",
  },
  "home/deploy/scripts/deploy.sh": {
    kind: "text",
    mtime: days(40),
    mode: 0o755,
    content:
      '#!/usr/bin/env bash\nset -Eeuo pipefail\n\nrelease="/var/www/app/releases/$(date +%Y-%m-%d-%H%M)"\nmkdir -p "$release"\ntar -xzf "$1" -C "$release"\nln -sfn "$release" /var/www/app/current\nsystemctl restart app\necho "live: $release"\n',
  },
  "home/deploy/scripts/rotate-logs.sh": {
    kind: "text",
    mtime: days(200),
    mode: 0o755,
    content:
      '#!/usr/bin/env bash\nset -Eeuo pipefail\ncd /var/log/app\nfor f in app.log api.log; do\n  [ -s "$f" ] || continue\n  mv "$f" "$f.1"\n  : > "$f"\ndone\nfind . -name "*.log.[0-9]" -mtime +1 -exec gzip {} \\;\n',
  },
  "home/deploy/downloads/node-v24.11.1-linux-x64.tar.xz": {
    kind: "sparse",
    bytes: 47_9 * 100 * KB,
    mtime: days(21),
  },
  "home/deploy/downloads/pnpm-linux-x64": {
    kind: "sparse",
    bytes: 68_3 * 100 * KB,
    mtime: days(21),
    mode: 0o755,
  },
  "home/alice/.bashrc": {
    kind: "text",
    mtime: days(250),
    content: "# ~/.bashrc\nalias ll='ls -alF'\n",
  },
  "home/alice/projects/report.md": {
    kind: "text",
    mtime: days(9),
    content:
      "# August numbers\n\nUnits are up 8% on July, mostly EMEA. The CSVs beside this file are the raw exports;\n`sales-2026-08.csv` is the one the deck was built from.\n",
  },
  "home/alice/projects/sales-2026-08.csv": {
    kind: "generated",
    generator: "csv",
    lines: 2_400,
    mtime: days(6),
  },
  "home/alice/projects/sales-2026-07.csv": {
    kind: "generated",
    generator: "csv",
    lines: 2_200,
    mtime: days(37),
  },

  // ---- opt ------------------------------------------------------------
  "opt/backups/README.md": {
    kind: "text",
    mtime: days(140),
    content:
      "# backups\n\n`db-YYYY-MM-DD.sql.gz` is the nightly dump from `/usr/local/bin/backup-db`, kept a month.\n`site-YYYY-MM-01.tar.gz` is the monthly tarball of /var/www, kept a year.\n",
  },
  "opt/backups/db-2026-08-25.sql.gz": {
    kind: "sparse",
    bytes: 396 * MB,
    mtime: days(7, 9, 30),
  },
  "opt/backups/db-2026-08-26.sql.gz": {
    kind: "sparse",
    bytes: 398 * MB,
    mtime: days(6, 9, 30),
  },
  "opt/backups/db-2026-08-27.sql.gz": {
    kind: "sparse",
    bytes: 399 * MB,
    mtime: days(5, 9, 30),
  },
  "opt/backups/db-2026-08-28.sql.gz": {
    kind: "sparse",
    bytes: 401 * MB,
    mtime: days(4, 9, 30),
  },
  "opt/backups/db-2026-08-29.sql.gz": {
    kind: "sparse",
    bytes: 401 * MB,
    mtime: days(3, 9, 30),
  },
  "opt/backups/db-2026-08-30.sql.gz": {
    kind: "sparse",
    bytes: 405 * MB,
    mtime: days(2, 9, 30),
  },
  "opt/backups/db-2026-08-31.sql.gz": {
    kind: "sparse",
    bytes: 409 * MB,
    mtime: days(1, 9, 30),
  },
  "opt/backups/site-2026-08-01.tar.gz": {
    kind: "sparse",
    bytes: 1_210 * MB,
    mtime: days(31, 9),
  },
  "opt/backups/site-2026-07-01.tar.gz": {
    kind: "sparse",
    bytes: 1_180 * MB,
    mtime: days(62, 9),
  },
  "opt/backups/site-2025-08-01.tar.gz": {
    kind: "sparse",
    bytes: 1_020 * MB,
    mtime: days(396, 9),
  },
  "opt/tools/healthcheck.sh": {
    kind: "text",
    mtime: days(88),
    mode: 0o755,
    content:
      '#!/usr/bin/env bash\ncurl -fsS --max-time 5 http://127.0.0.1:6800/api/health >/dev/null || logger -t healthcheck "api down"\n',
  },
  "opt/tools/du-report.sh": {
    kind: "text",
    mtime: days(88),
    mode: 0o755,
    content: "#!/usr/bin/env bash\ndu -xh --max-depth=2 /var /opt /srv 2>/dev/null | sort -rh | head -30\n",
  },

  // ---- srv ------------------------------------------------------------
  "srv/media/images/hero-01.jpg": {
    kind: "image",
    style: "photo",
    width: 1600,
    height: 900,
    bytes: 7_6 * 100 * KB,
    mtime: days(60),
  },
  "srv/media/images/hero-02.jpg": {
    kind: "image",
    style: "photo",
    width: 1600,
    height: 900,
    bytes: 7_1 * 100 * KB,
    mtime: days(60),
  },
  "srv/media/images/hero-03.jpg": {
    kind: "image",
    style: "photo",
    width: 1600,
    height: 900,
    bytes: 6_1 * 100 * KB,
    mtime: days(58),
  },
  "srv/media/images/team-2026.jpg": {
    kind: "image",
    style: "photo",
    width: 1200,
    height: 800,
    bytes: 4_6 * 100 * KB,
    mtime: days(33),
  },
  "srv/media/images/office.jpg": {
    kind: "image",
    style: "photo",
    width: 1200,
    height: 800,
    bytes: 3_8 * 100 * KB,
    mtime: days(33),
  },
  "srv/media/images/product-a.png": {
    kind: "image",
    style: "product",
    width: 640,
    height: 480,
    bytes: 2_2 * 100 * KB,
    mtime: days(15),
  },
  "srv/media/images/product-b.png": {
    kind: "image",
    style: "product",
    width: 640,
    height: 480,
    bytes: 2_4 * 100 * KB,
    mtime: days(15),
  },
  "srv/media/images/product-c.png": {
    kind: "image",
    style: "product",
    width: 640,
    height: 480,
    bytes: 1_9 * 100 * KB,
    mtime: days(15),
  },
  "srv/media/images/logo.svg": {
    kind: "text",
    mtime: days(200),
    content:
      '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#1f7cab"/><path d="M20 34l8 8 16-18" stroke="#fff" stroke-width="5" fill="none"/></svg>\n',
  },
  "srv/media/videos/launch.mp4": {
    kind: "sparse",
    bytes: 1_820 * MB,
    mtime: days(48),
  },
  "srv/media/videos/tour.mp4": {
    kind: "sparse",
    bytes: 642 * MB,
    mtime: days(48),
  },
  "srv/media/videos/tour-720p.mp4": {
    kind: "sparse",
    bytes: 214 * MB,
    mtime: days(47),
  },
  "srv/uploads/invoice-2026-08.pdf": {
    kind: "sparse",
    bytes: 2_1 * 100 * KB,
    mtime: days(4),
  },
  "srv/uploads/invoice-2026-08 (2).pdf": {
    kind: "sparse",
    bytes: 2_1 * 100 * KB,
    mtime: days(4, 0, 12),
  },
  "srv/uploads/brochure.pdf": {
    kind: "sparse",
    bytes: 5_6 * 100 * KB,
    mtime: days(20),
  },
  "srv/uploads/onboarding.mp4": {
    kind: "sparse",
    bytes: 96 * MB,
    mtime: days(11),
  },

  // ---- tmp, usr -------------------------------------------------------
  "tmp/build-8811.log": {
    kind: "generated",
    generator: "app-json",
    lines: 400,
    mtime: days(2),
  },
  "tmp/core.1187": { kind: "sparse", bytes: 128 * MB, mtime: days(380) },
  "tmp/.session-cache": { kind: "sparse", bytes: 3 * MB, mtime: days(1) },
  "usr/local/bin/backup-db": {
    kind: "text",
    mtime: days(140),
    mode: 0o755,
    content:
      '#!/usr/bin/env bash\nset -Eeuo pipefail\nout="/opt/backups/db-$(date +%F).sql.gz"\nmysqldump --single-transaction app | gzip -6 > "$out"\nfind /opt/backups -name "db-*.sql.gz" -mtime +31 -delete\n',
  },
  "usr/local/bin/prune-releases": {
    kind: "text",
    mtime: days(140),
    mode: 0o755,
    content:
      '#!/usr/bin/env bash\nset -Eeuo pipefail\ncd /var/www/app/releases\nls -1d */ | sort | head -n -20 | while read -r old; do rm -rf "$old"; done\n',
  },
  "usr/local/bin/tail-app": {
    kind: "text",
    mtime: days(60),
    mode: 0o755,
    content: "#!/usr/bin/env bash\nexec tail -F /var/log/app/app.log /var/log/app/api.log\n",
  },

  // ---- var/www --------------------------------------------------------
  "var/www/app/current": {
    kind: "symlink",
    target: "releases/2026-08-30-1730",
    mtime: days(2),
  },
  // Twenty kept by `prune-releases`; seventeen on disk, a fortnight to a year apart.
  ...RELEASE_FILES("2025-06-14-0912", days(444), "1.8.0", 1_1 * 100 * KB, 3_2 * 100 * KB),
  ...RELEASE_FILES("2025-07-02-1015", days(426), "1.8.1", 1_1 * 100 * KB, 3_2 * 100 * KB),
  ...RELEASE_FILES("2025-08-19-0930", days(378), "1.9.0", 1_1 * 100 * KB, 3_3 * 100 * KB),
  ...RELEASE_FILES("2025-09-30-1410", days(336), "1.9.2", 1_2 * 100 * KB, 3_3 * 100 * KB),
  ...RELEASE_FILES("2025-11-04-1120", days(301), "1.9.3", 1_2 * 100 * KB, 3_3 * 100 * KB),
  ...RELEASE_FILES("2025-12-16-0905", days(259), "1.10.0", 1_2 * 100 * KB, 3_4 * 100 * KB),
  ...RELEASE_FILES("2026-01-27-1600", days(217), "1.10.2", 1_2 * 100 * KB, 3_4 * 100 * KB),
  ...RELEASE_FILES("2026-02-18-1045", days(195), "1.11.0", 1_2 * 100 * KB, 3_4 * 100 * KB),
  ...RELEASE_FILES("2026-03-02-1100", days(183), "2.0.0", 1_2 * 100 * KB, 3_4 * 100 * KB),
  ...RELEASE_FILES("2026-04-08-1330", days(146), "2.1.0", 1_3 * 100 * KB, 3_5 * 100 * KB),
  ...RELEASE_FILES("2026-05-13-0955", days(111), "2.2.0", 1_3 * 100 * KB, 3_5 * 100 * KB),
  ...RELEASE_FILES("2026-06-03-1710", days(90), "2.2.1", 1_3 * 100 * KB, 3_5 * 100 * KB),
  ...RELEASE_FILES("2026-06-24-1150", days(69), "2.3.0", 1_3 * 100 * KB, 3_6 * 100 * KB),
  ...RELEASE_FILES("2026-07-19-1620", days(44), "2.3.1", 1_3 * 100 * KB, 3_6 * 100 * KB),
  ...RELEASE_FILES("2026-08-06-1420", days(26), "2.3.2", 1_3 * 100 * KB, 3_6 * 100 * KB),
  ...RELEASE_FILES("2026-08-21-0940", days(11), "2.4.0", 1_3 * 100 * KB, 3_7 * 100 * KB),
  ...RELEASE_FILES("2026-08-30-1730", days(2), "2.4.1", 1_4 * 100 * KB, 3_7 * 100 * KB),
  "var/www/app/releases/2026-08-30-1730/CHANGELOG.md": {
    kind: "text",
    mtime: days(2),
    content:
      "# 2.4.1\n\n- orders: the export no longer drops the last row of the month\n- session: cookies are SameSite=Lax again\n\n# 2.4.0\n\n- orders: CSV export\n- a new onboarding video on the landing page\n",
  },
  "var/www/app/shared/config/app.yml": {
    kind: "text",
    mtime: days(11),
    content:
      'app:\n  name: app\n  baseUrl: https://app.example.com\ndatabase:\n  host: 127.0.0.1\n  name: app\n  user: app\n  password: "${DB_PASSWORD}"\nuploads:\n  dir: /var/www/app/shared/uploads\n  maxBytes: 26214400\n',
  },
  "var/www/app/shared/uploads/avatars/u-1001.png": {
    kind: "image",
    style: "avatar",
    width: 128,
    height: 128,
    bytes: 84 * KB,
    mtime: days(30),
  },
  "var/www/app/shared/uploads/avatars/u-1002.png": {
    kind: "image",
    style: "avatar",
    width: 128,
    height: 128,
    bytes: 112 * KB,
    mtime: days(26),
  },
  "var/www/app/shared/uploads/avatars/u-1003.png": {
    kind: "image",
    style: "avatar",
    width: 128,
    height: 128,
    bytes: 96 * KB,
    mtime: days(19),
  },
  "var/www/app/shared/uploads/avatars/u-1004.png": {
    kind: "image",
    style: "avatar",
    width: 128,
    height: 128,
    bytes: 178 * KB,
    mtime: days(8),
  },
  "var/www/app/shared/uploads/avatars/u-1005.png": {
    kind: "image",
    style: "avatar",
    width: 128,
    height: 128,
    bytes: 41 * KB,
    mtime: days(3),
  },
  "var/www/app/shared/uploads/avatars/u-1006.png": {
    kind: "image",
    style: "avatar",
    width: 128,
    height: 128,
    bytes: 133 * KB,
    mtime: days(1),
  },
  "var/www/app/shared/uploads/exports/orders-2026-08.csv": {
    kind: "generated",
    generator: "csv",
    lines: 3_000,
    mtime: days(1, 2),
  },
  "var/www/app/shared/logs": {
    kind: "symlink",
    target: "../../../log/app",
    mtime: days(60),
  },
  "var/www/api/current": {
    kind: "symlink",
    target: "releases/2026-08-28-1015",
    mtime: days(4),
  },
  ...API_RELEASE("2026-01-20-1100", days(224), "0.8.0", 602 * KB),
  ...API_RELEASE("2026-03-11-0940", days(174), "0.9.0", 618 * KB),
  ...API_RELEASE("2026-05-06-1430", days(118), "0.9.2", 640 * KB),
  ...API_RELEASE("2026-06-17-1505", days(76), "0.9.5", 655 * KB),
  ...API_RELEASE("2026-07-09-1010", days(54), "0.9.9", 671 * KB),
  ...API_RELEASE("2026-08-02-0900", days(30), "1.0.0", 702 * KB),
  ...API_RELEASE("2026-08-14-1600", days(18), "1.0.1", 706 * KB),
  ...API_RELEASE("2026-08-28-1015", days(4), "1.0.3", 711 * KB),
  "var/www/api/shared/config/api.yml": {
    kind: "text",
    mtime: days(30),
    content:
      'port: 6800\ndatabase:\n  host: 127.0.0.1\n  name: app\n  user: app\n  password: "${DB_PASSWORD}"\ncors:\n  origin: https://app.example.com\n',
  },

  // ---- var/log --------------------------------------------------------
  "var/log/nginx/access.log": {
    kind: "generated",
    generator: "nginx-access",
    lines: 4_000,
    mtime: minutes(2),
  },
  "var/log/nginx/access.log.1": {
    kind: "generated",
    generator: "nginx-access",
    lines: 4_000,
    mtime: days(1),
  },
  "var/log/nginx/access.log.2.gz": {
    kind: "sparse",
    bytes: 1_6 * 100 * KB,
    mtime: days(2),
  },
  "var/log/nginx/access.log.3.gz": {
    kind: "sparse",
    bytes: 1_5 * 100 * KB,
    mtime: days(3),
  },
  "var/log/nginx/access.log.4.gz": {
    kind: "sparse",
    bytes: 1_7 * 100 * KB,
    mtime: days(4),
  },
  "var/log/nginx/error.log": {
    kind: "generated",
    generator: "nginx-error",
    lines: 300,
    mtime: minutes(5),
  },
  "var/log/nginx/error.log.1": {
    kind: "generated",
    generator: "nginx-error",
    lines: 260,
    mtime: days(1),
  },
  "var/log/app/app.log": {
    kind: "generated",
    generator: "app-json",
    lines: 2_500,
    mtime: minutes(1),
  },
  "var/log/app/app.log.1": {
    kind: "generated",
    generator: "app-json",
    lines: 2_500,
    mtime: days(1),
  },
  "var/log/app/app.log.2.gz": {
    kind: "sparse",
    bytes: 900 * KB,
    mtime: days(2),
  },
  "var/log/app/api.log": {
    kind: "generated",
    generator: "app-json",
    lines: 1_800,
    mtime: minutes(1),
  },
  "var/log/syslog": {
    kind: "generated",
    generator: "syslog",
    lines: 1_500,
    mtime: minutes(3),
  },
  "var/log/syslog.1": {
    kind: "generated",
    generator: "syslog",
    lines: 1_500,
    mtime: days(1),
  },
  "var/log/auth.log": {
    kind: "generated",
    generator: "auth-log",
    lines: 900,
    mtime: minutes(4),
  },
  "var/log/auth.log.1": {
    kind: "generated",
    generator: "auth-log",
    lines: 900,
    mtime: days(1),
  },
  "var/log/dpkg.log": {
    kind: "generated",
    generator: "dpkg-log",
    lines: 220,
    mtime: days(6),
  },
  "var/log/kern.log": {
    kind: "generated",
    generator: "syslog",
    lines: 120,
    mtime: hours(7),
  },
  "var/log/mysql/error.log": {
    kind: "generated",
    generator: "mysql-error",
    lines: 140,
    mtime: hours(2),
  },
  "var/log/journal/7f1c2b9e4d0a4c1b9e3f8a2d5c6b7a90/system.journal": {
    kind: "sparse",
    bytes: 128 * MB,
    mtime: hours(1),
  },
  "var/log/journal/7f1c2b9e4d0a4c1b9e3f8a2d5c6b7a90/system@0005b3a1-0000000000000001.journal": {
    kind: "sparse",
    bytes: 96 * MB,
    mtime: days(3),
  },
  "var/log/journal/7f1c2b9e4d0a4c1b9e3f8a2d5c6b7a90/system@0005b3a1-0000000000000002.journal": {
    kind: "sparse",
    bytes: 112 * MB,
    mtime: days(6),
  },

  // ---- var/lib, var/cache, var/spool, var/tmp -------------------------
  "var/lib/mysql/ibdata1": {
    kind: "sparse",
    bytes: 1_210 * MB,
    mtime: hours(2),
  },
  "var/lib/mysql/ib_logfile0": {
    kind: "sparse",
    bytes: 48 * MB,
    mtime: hours(2),
  },
  "var/lib/mysql/ib_logfile1": {
    kind: "sparse",
    bytes: 48 * MB,
    mtime: hours(2, 4),
  },
  "var/lib/mysql/undo_001": { kind: "sparse", bytes: 16 * MB, mtime: hours(2) },
  "var/lib/mysql/undo_002": {
    kind: "sparse",
    bytes: 16 * MB,
    mtime: hours(2, 1),
  },
  "var/lib/mysql/app/orders.ibd": {
    kind: "sparse",
    bytes: 2_140 * MB,
    mtime: hours(2),
  },
  "var/lib/mysql/app/order_items.ibd": {
    kind: "sparse",
    bytes: 1_630 * MB,
    mtime: hours(2),
  },
  "var/lib/mysql/app/users.ibd": {
    kind: "sparse",
    bytes: 380 * MB,
    mtime: hours(2),
  },
  "var/lib/mysql/app/sessions.ibd": {
    kind: "sparse",
    bytes: 190 * MB,
    mtime: hours(2),
  },
  "var/lib/mysql/app/audit.ibd": {
    kind: "sparse",
    bytes: 512 * MB,
    mtime: hours(2),
  },
  "var/lib/mysql/mysql/user.MYD": {
    kind: "sparse",
    bytes: 12 * KB,
    mtime: days(30),
  },
  "var/lib/mysql/mysql/general_log.CSV": {
    kind: "sparse",
    bytes: 0,
    mtime: days(512),
  },
  "var/lib/mysql/auto.cnf": {
    kind: "text",
    mtime: days(512),
    content: "[auto]\nserver-uuid=7f1c2b9e-4d0a-4c1b-9e3f-8a2d5c6b7a90\n",
  },
  "var/cache/apt/archives/nginx-common_1.26.2-1_all.deb": {
    kind: "sparse",
    bytes: 0.8 * MB,
    mtime: days(9),
  },
  "var/cache/apt/archives/nginx_1.26.2-1_amd64.deb": {
    kind: "sparse",
    bytes: 1.2 * MB,
    mtime: days(9),
  },
  "var/cache/apt/archives/libc6_2.40-3_amd64.deb": {
    kind: "sparse",
    bytes: 2.9 * MB,
    mtime: days(9),
  },
  "var/cache/apt/archives/openssl_3.3.2-1_amd64.deb": {
    kind: "sparse",
    bytes: 1.4 * MB,
    mtime: days(9),
  },
  "var/cache/apt/archives/mariadb-server-core_11.4.3-1_amd64.deb": {
    kind: "sparse",
    bytes: 31 * MB,
    mtime: days(9),
  },
  "var/cache/apt/archives/nodejs_24.11.1-1nodesource1_amd64.deb": {
    kind: "sparse",
    bytes: 29 * MB,
    mtime: days(9),
  },
  "var/cache/apt/pkgcache.bin": {
    kind: "sparse",
    bytes: 42 * MB,
    mtime: days(9),
  },
  "var/spool/cron/crontabs/deploy": {
    kind: "text",
    mtime: days(44),
    mode: 0o600,
    content: "*/5 * * * * /opt/tools/healthcheck.sh\n0 4 * * 0 /home/deploy/scripts/rotate-logs.sh\n",
  },
  "var/tmp/apt-key-gpghome.leftover": {
    kind: "sparse",
    bytes: 4 * KB,
    mtime: days(200),
  },

  // ---- the crowd (TRE-148): the families defined above the tree ----------
  ...PRODUCT_IMAGES,
  ...GALLERY,
  ...BANNERS,
  ...PRODUCT_SHOTS,
  ...ICONS,
  ...VIDEO_CUTS,
  ...PODCAST,
  ...CLIPS,
  ...UPLOADS,
  ...AVATARS,
  ...EXPORTS,
  ...ATTACHMENTS,
  ...ROTATED_LOGS,
  ...JOURNALS,
  ...NIGHTLY_DUMPS,
  ...MONTHLY_TARBALLS,
  ...TABLES,
  ...SYSTEM_TABLES,
  ...BINLOGS,
  ...SALES,
  ...DOWNLOADS,
  ...DEBS,
  ...ETC_EXTRAS,
  ...BOOT,
  ...ARCHIVE,
  ...RUN,
};

// ---------------------------------------------------------------- bookmarks

export interface BookmarkSpec {
  path: string;
  label: string;
  hint: string | null;
}

/** On the LOCAL host, in sidebar order. The seed's SSH host keeps its own. */
export const BOOKMARKS: readonly BookmarkSpec[] = [
  { path: tree("var/www"), label: "Web root", hint: "app + api releases" },
  { path: tree("var/log"), label: "Logs", hint: "nginx, app, system" },
  { path: tree("opt/backups"), label: "Backups", hint: "nightly dumps" },
  { path: tree("var/lib/mysql"), label: "MySQL data", hint: "the fat one" },
  {
    path: tree("home/deploy"),
    label: "deploy",
    hint: "the deploy account's home",
  },
  { path: tree("srv/media"), label: "Media", hint: "images + video" },
];

// ---------------------------------------------------------------- views

export type HostRef = "local" | RemoteSlug;

export interface ViewPaneSpec {
  host: HostRef | null;
  path: string;
  sort: "name" | "size" | "mode" | "owner" | "age";
  dir: 1 | -1;
  hide: string;
}

export interface ViewSpec {
  name: string;
  slot: number | null;
  createdAt: Rel;
  a: ViewPaneSpec;
  b: ViewPaneSpec;
  split: "split" | "left" | "right";
  insp: boolean;
  heat: boolean;
  glob: string;
}

export const VIEWS: readonly ViewSpec[] = [
  {
    name: "Releases ↔ logs",
    slot: 1,
    createdAt: days(41),
    a: {
      host: "local",
      path: tree("var/www/app/releases"),
      sort: "age",
      dir: -1,
      hide: "",
    },
    b: {
      host: "local",
      path: tree("var/log/nginx"),
      sort: "name",
      dir: 1,
      hide: "owner",
    },
    split: "split",
    insp: true,
    heat: true,
    glob: "",
  },
  {
    name: "Backups → Marlow",
    slot: 2,
    createdAt: days(28),
    a: {
      host: "local",
      path: tree("opt/backups"),
      sort: "age",
      dir: -1,
      hide: "",
    },
    b: {
      host: "marlow",
      path: "/srv/backups",
      sort: "size",
      dir: -1,
      hide: "mode,owner",
    },
    split: "split",
    insp: false,
    heat: false,
    glob: "*.gz",
  },
  {
    name: "Log triage",
    slot: 3,
    createdAt: days(12),
    a: {
      host: "local",
      path: tree("var/log/app"),
      sort: "age",
      dir: -1,
      hide: "",
    },
    b: { host: "local", path: tree("var/log"), sort: "name", dir: 1, hide: "" },
    split: "left",
    insp: false,
    heat: true,
    glob: "",
  },
  {
    name: "Media",
    slot: null,
    createdAt: days(5),
    a: {
      host: "local",
      path: tree("srv/media/images"),
      sort: "size",
      dir: -1,
      hide: "",
    },
    b: {
      host: "local",
      path: tree("srv/media/videos"),
      sort: "size",
      dir: -1,
      hide: "",
    },
    split: "split",
    insp: true,
    heat: true,
    glob: "",
  },
];

// ---------------------------------------------------------------- scans

export interface ScanSpec {
  key: string;
  /** Relative to the tree root; `""` is the root itself. */
  root: string;
  depth: number;
  startedAt: Rel;
  /** How long it ran. */
  durationMs: number;
  status: "DONE" | "FAILED" | "CANCELLED";
  error?: string;
}

/**
 * DONE scans get their rows computed from the tree by the real aggregator at
 * load time. The other two are history with no rows: a scan the host refused
 * and one somebody stopped.
 */
export const SCANS: readonly ScanSpec[] = [
  {
    key: "root",
    root: "",
    depth: 3,
    startedAt: minutes(41),
    durationMs: 148_000,
    status: "DONE",
  },
  {
    key: "www",
    root: "var/www",
    depth: 3,
    startedAt: days(3, 2),
    durationMs: 21_000,
    status: "DONE",
  },
  {
    key: "log",
    root: "var/log",
    depth: 2,
    startedAt: hours(26),
    durationMs: 9_000,
    status: "DONE",
  },
  {
    key: "mysql",
    root: "var/lib/mysql",
    depth: 3,
    startedAt: days(5, 1),
    durationMs: 1_200,
    status: "FAILED",
    error: "Permission denied on the host.",
  },
  {
    key: "srv",
    root: "srv",
    depth: 3,
    startedAt: days(9, 3),
    durationMs: 64_000,
    status: "CANCELLED",
  },
];

// ---------------------------------------------------------------- hashes

export interface HashSpec {
  /** Relative to the tree root. Must be a regular file. */
  path: string;
  computedAt: Rel;
}

/**
 * Files whose sha256 the cache already holds. The digest is computed from the
 * materialised bytes at load time; the size and mtime are read back from the
 * file, which is the only way the row can match the first `stat` the inspector
 * makes. Kept to a couple of gigabytes of (sparse, zero) reading.
 */
export const HASHES: readonly HashSpec[] = [
  { path: "etc/nginx/nginx.conf", computedAt: days(12, 3) },
  { path: "etc/nginx/sites-available/app.conf", computedAt: days(11, 21) },
  { path: "home/deploy/scripts/deploy.sh", computedAt: days(9, 5) },
  { path: "home/deploy/scripts/rotate-logs.sh", computedAt: days(9, 5) },
  { path: "usr/local/bin/backup-db", computedAt: days(9, 5) },
  { path: "opt/backups/db-2026-08-28.sql.gz", computedAt: days(3, 8) },
  { path: "opt/backups/db-2026-08-29.sql.gz", computedAt: days(3, 8) },
  { path: "opt/backups/db-2026-08-31.sql.gz", computedAt: hours(20) },
  { path: "srv/uploads/invoice-2026-08.pdf", computedAt: days(3, 23) },
  { path: "srv/uploads/invoice-2026-08 (2).pdf", computedAt: days(3, 23) },
  { path: "srv/uploads/brochure.pdf", computedAt: days(3, 23) },
  {
    path: "var/www/app/releases/2026-08-30-1730/package.json",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/app/releases/2026-08-30-1730/README.md",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/app/releases/2026-08-30-1730/CHANGELOG.md",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/app/releases/2026-08-30-1730/dist/main.js",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/app/releases/2026-08-30-1730/dist/vendor.js",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/app/releases/2026-08-30-1730/dist/styles.css",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/app/releases/2026-08-30-1730/public/index.html",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/app/releases/2026-08-21-0940/dist/main.js",
    computedAt: days(1, 6),
  },
  {
    path: "var/www/api/releases/2026-08-28-1015/package.json",
    computedAt: days(3, 22),
  },
  { path: "var/log/nginx/access.log.2.gz", computedAt: hours(30) },
];

// ---------------------------------------------------------------- transfers

export interface TransferItemSpec {
  name: string;
  kind: "file" | "directory" | "symlink";
  bytes: number;
  status: "DONE" | "SKIPPED" | "FAILED" | "PENDING";
  conflict?: "ASK" | "OVERWRITE" | "SKIP" | "RENAME";
  finalName?: string;
  error?: string;
}

export interface TransferSpec {
  key: string;
  operation: "COPY" | "MOVE";
  /** Null is a host deleted since — the job outlives it with the reference nulled. */
  src: HostRef | null;
  srcPath: string;
  dst: HostRef | null;
  dstPath: string;
  status: "DONE" | "FAILED" | "CANCELLED";
  createdAt: Rel;
  /** Queue wait before it started, and how long it ran. */
  queuedMs: number;
  durationMs: number;
  error?: string;
  strategy: "ask" | "overwrite" | "skip" | "keepBoth";
  landAs?: Record<string, string>;
  /**
   * Either a directory of the tree to enumerate at load time (`fromTree`),
   * or an explicit list — for a source that is not in the tree, or a job
   * that failed partway.
   */
  items: { fromTree: string } | TransferItemSpec[];
}

const file = (name: string, bytes: number, status: TransferItemSpec["status"] = "DONE"): TransferItemSpec => ({
  name,
  kind: "file",
  bytes,
  status,
});
const dir = (name: string, status: TransferItemSpec["status"] = "DONE"): TransferItemSpec => ({
  name,
  kind: "directory",
  bytes: 0,
  status,
});

export const TRANSFERS: readonly TransferSpec[] = [
  {
    key: "release-to-backups",
    operation: "COPY",
    src: "local",
    srcPath: tree("var/www/app/releases"),
    dst: "local",
    dstPath: tree("opt/backups"),
    status: "DONE",
    createdAt: days(1, 7),
    queuedMs: 400,
    durationMs: 3_100,
    strategy: "ask",
    items: { fromTree: "var/www/app/releases/2026-08-30-1730" },
  },
  {
    key: "mysql-to-backups",
    operation: "COPY",
    src: "local",
    srcPath: tree("var/lib"),
    dst: "local",
    dstPath: tree("opt/backups"),
    status: "DONE",
    createdAt: days(2, 4),
    queuedMs: 1_200,
    durationMs: 384_000,
    strategy: "overwrite",
    items: { fromTree: "var/lib/mysql" },
  },
  {
    key: "uploads-to-images",
    operation: "MOVE",
    src: "local",
    srcPath: tree("srv/uploads"),
    dst: "local",
    dstPath: tree("srv/media/images"),
    status: "DONE",
    createdAt: days(15, 2),
    queuedMs: 300,
    durationMs: 900,
    strategy: "ask",
    items: [
      file("product-a.png", 2_2 * 100 * KB),
      file("product-b.png", 2_4 * 100 * KB),
      file("product-c.png", 1_9 * 100 * KB),
    ],
  },
  {
    key: "remote-backups-in",
    operation: "COPY",
    src: "marlow",
    srcPath: "/srv/backups",
    dst: "local",
    dstPath: tree("opt/backups"),
    status: "DONE",
    createdAt: days(31, 5),
    queuedMs: 800,
    durationMs: 612_000,
    strategy: "skip",
    items: [file("site-2026-08-01.tar.gz", 1_210 * MB), file("db-2026-07-31.sql.gz", 388 * MB, "SKIPPED")],
  },
  {
    key: "nginx-logs-out",
    operation: "COPY",
    src: "local",
    srcPath: tree("var/log"),
    dst: "marlow",
    dstPath: "/srv/backups/logs",
    status: "DONE",
    createdAt: days(6, 9),
    queuedMs: 200,
    durationMs: 14_000,
    strategy: "overwrite",
    items: { fromTree: "var/log/nginx" },
  },
  {
    key: "backups-to-media-failed",
    operation: "COPY",
    src: "local",
    srcPath: tree("opt"),
    dst: "local",
    dstPath: tree("srv/media"),
    status: "FAILED",
    createdAt: days(8, 11),
    queuedMs: 500,
    durationMs: 92_000,
    error: "1 entry could not be transferred.",
    strategy: "ask",
    items: [
      dir("backups"),
      file("backups/README.md", 231),
      file("backups/db-2026-08-23.sql.gz", 392 * MB),
      file("backups/site-2026-08-01.tar.gz", 1_210 * MB),
      {
        ...file("backups/site-2025-08-01.tar.gz", 1_020 * MB, "FAILED"),
        error: "Permission denied on the host.",
      },
    ],
  },
  {
    key: "videos-out-cancelled",
    operation: "COPY",
    src: "local",
    srcPath: tree("srv/media"),
    dst: "tundra",
    dstPath: "/srv/media/incoming",
    status: "CANCELLED",
    createdAt: days(19, 6),
    queuedMs: 300,
    durationMs: 41_000,
    error: "Cancelled.",
    strategy: "ask",
    items: [
      dir("videos"),
      file("videos/tour-720p.mp4", 214 * MB),
      file("videos/tour.mp4", 642 * MB, "PENDING"),
      file("videos/launch.mp4", 1_820 * MB, "PENDING"),
    ],
  },
  {
    key: "avatars-conflicts",
    operation: "COPY",
    src: "local",
    srcPath: tree("var/www/app/shared/uploads"),
    dst: "local",
    dstPath: tree("srv/uploads"),
    status: "DONE",
    createdAt: days(3, 12),
    queuedMs: 250,
    durationMs: 1_400,
    strategy: "keepBoth",
    items: [
      dir("avatars"),
      { ...file("avatars/u-1001.png", 84 * KB), conflict: "OVERWRITE" },
      {
        ...file("avatars/u-1002.png", 112 * KB, "SKIPPED"),
        conflict: "SKIP",
        error: "already there",
      },
      {
        ...file("avatars/u-1003.png", 96 * KB),
        conflict: "RENAME",
        finalName: "u-1003 (2).png",
      },
      file("avatars/u-1004.png", 178 * KB),
    ],
  },
  {
    key: "remote-exports-move",
    operation: "MOVE",
    src: "sable",
    srcPath: "/home/dba/exports",
    dst: "local",
    dstPath: tree("home/alice/projects"),
    status: "DONE",
    createdAt: days(37, 1),
    queuedMs: 600,
    durationMs: 2_300,
    strategy: "ask",
    items: [file("sales-2026-07.csv", 118_204)],
  },
  {
    key: "deleted-host-history",
    operation: "COPY",
    src: null,
    srcPath: "/data/exports",
    dst: "local",
    dstPath: tree("opt/backups"),
    status: "DONE",
    createdAt: days(50, 4),
    queuedMs: 900,
    durationMs: 55_000,
    strategy: "ask",
    items: [file("site-2026-07-01.tar.gz", 1_180 * MB)],
  },
  {
    key: "deleted-host-failed",
    operation: "COPY",
    src: null,
    srcPath: "/data/exports",
    dst: "local",
    dstPath: tree("opt/backups"),
    status: "FAILED",
    createdAt: days(46, 2),
    queuedMs: 700,
    durationMs: 100,
    error: "A host this transfer used has been deleted.",
    strategy: "ask",
    items: [file("site-2026-07-15.tar.gz", 1_190 * MB, "PENDING")],
  },
  {
    key: "api-release-duplicate",
    operation: "COPY",
    src: "local",
    srcPath: tree("var/www/api/releases"),
    dst: "local",
    dstPath: tree("var/www/api/releases"),
    status: "DONE",
    createdAt: hours(5, 20),
    queuedMs: 200,
    durationMs: 700,
    strategy: "ask",
    landAs: { "2026-08-28-1015": "2026-08-28-1015 (2)" },
    items: { fromTree: "var/www/api/releases/2026-08-28-1015" },
  },
];

// ---------------------------------------------------------------- activity

export type ActivityOutcome = "success" | "failure" | "refused" | "pending";

export interface ActivitySpec {
  /** Unique, and the seed of the row's id. */
  key: string;
  at: Rel;
  kind: string;
  summary: string;
  tag?: string;
  host?: HostRef | null;
  outcome?: ActivityOutcome;
  detail?: string;
  elevated?: boolean;
  origin?: "terminal";
  destructive?: boolean;
  bytes?: number;
  durationMs?: number;
  payload?: Record<string, unknown>;
  /** Which of the three fake browser sessions did it. */
  session?: 0 | 1 | 2;
  /** For a chmod or chown: the entries it changed, as the undo reads them. */
  snapshots?: ReadonlyArray<{
    path: string;
    mode: number;
    uid: number;
    gid: number;
  }>;
}

/**
 * The hand-written half of the log: sign-outs, edits, refusals, a crash. The
 * other half — a row per scan, per transfer, per saved view, per bookmark —
 * is derived from the specs above by `fixtures.ts`, so the strip and the
 * tables tell one story.
 */
export const ACTIVITY: readonly ActivitySpec[] = [
  {
    key: "host-create-local",
    at: days(80, 3),
    kind: "host.create",
    summary: "Added the host Kestrel",
    host: "local",
    destructive: true,
    durationMs: 41,
  },
  {
    key: "host-create-marlow",
    at: days(80, 2, 50),
    kind: "host.create",
    summary: "Added the host Marlow",
    host: "marlow",
    destructive: true,
    durationMs: 38,
  },
  {
    key: "host-test-marlow",
    at: days(80, 2, 49),
    kind: "host.test",
    summary: "Tested a connection to Marlow",
    host: "marlow",
    durationMs: 412,
  },
  {
    key: "host-create-sable",
    at: days(80, 2, 40),
    kind: "host.create",
    summary: "Added the host Sable",
    host: "sable",
    destructive: true,
    durationMs: 35,
  },
  {
    key: "host-create-tundra",
    at: days(80, 2, 30),
    kind: "host.create",
    summary: "Added the host Tundra",
    host: "tundra",
    destructive: true,
    durationMs: 40,
  },
  {
    key: "host-test-tundra",
    at: days(80, 2, 29),
    kind: "host.test",
    summary: "Tested a connection to Tundra",
    host: "tundra",
    outcome: "failure",
    detail: "connect ETIMEDOUT tundra.example.com:22",
    durationMs: 10_020,
  },
  {
    key: "logout-1",
    at: days(80, 1),
    kind: "user.logout",
    summary: "Signed out",
    durationMs: 3,
  },
  {
    key: "mkdir-exports",
    at: days(52, 4),
    kind: "file.mkdir",
    summary: `mkdir exports in ${tree("var/www/app/shared/uploads")}`,
    host: "local",
    durationMs: 6,
    payload: { created: tree("var/www/app/shared/uploads/exports"), mode: 493 },
  },
  {
    key: "upload-brochure",
    at: days(20, 2, 10),
    kind: "file.upload",
    summary: `upload into ${tree("srv/uploads")}`,
    host: "local",
    destructive: true,
    bytes: 5_6 * 100 * KB,
    durationMs: 1_840,
    payload: { conflict: "keepBoth", files: 1 },
  },
  {
    key: "rename-batch",
    at: days(15, 1, 30),
    kind: "file.rename",
    summary: "rename 3 entries by pattern",
    tag: "3 entries",
    host: "local",
    destructive: true,
    durationMs: 22,
    payload: {
      pattern: "^IMG_(\\d+)\\.png$",
      replacement: "product-$1.png",
      renamed: 3,
    },
  },
  {
    key: "chmod-scripts",
    at: days(6, 4),
    kind: "file.chmod",
    summary: "chmod 755 on 3 paths",
    tag: undefined,
    host: "local",
    destructive: true,
    durationMs: 18,
    payload: {
      mode: "755",
      recursive: false,
      special: [],
      paths: [
        tree("home/deploy/scripts/deploy.sh"),
        tree("home/deploy/scripts/rotate-logs.sh"),
        tree("usr/local/bin/tail-app"),
      ],
    },
    snapshots: [
      {
        path: tree("home/deploy/scripts/deploy.sh"),
        mode: 0o644,
        uid: 1000,
        gid: 1000,
      },
      {
        path: tree("home/deploy/scripts/rotate-logs.sh"),
        mode: 0o644,
        uid: 1000,
        gid: 1000,
      },
      { path: tree("usr/local/bin/tail-app"), mode: 0o644, uid: 0, gid: 0 },
    ],
  },
  {
    key: "chown-refused",
    at: days(6, 3, 58),
    kind: "file.chown",
    summary: "chown www-data:www-data on 1 path, recursive",
    host: "local",
    destructive: true,
    outcome: "failure",
    detail: "chown requires elevation on this host — open a sudo window and try again.",
    durationMs: 12,
    payload: {
      owner: "www-data",
      group: "www-data",
      recursive: true,
      paths: [tree("var/www/app/shared/uploads")],
    },
  },
  {
    key: "sudo-open",
    at: days(6, 3, 57),
    kind: "host.sudo.open",
    summary: "Opened a sudo window on Kestrel",
    host: "local",
    destructive: true,
    durationMs: 640,
    payload: { requestedHostId: LOCAL_HOST.id },
  },
  {
    key: "chown-elevated",
    at: days(6, 3, 56),
    kind: "file.chown",
    summary: "chown www-data:www-data on 1 path, recursive",
    host: "local",
    destructive: true,
    elevated: true,
    durationMs: 210,
    payload: {
      owner: "www-data",
      group: "www-data",
      recursive: true,
      paths: [tree("var/www/app/shared/uploads")],
    },
  },
  {
    key: "sudo-drop",
    at: days(6, 3, 40),
    kind: "host.sudo.drop",
    summary: "Closed a sudo window",
    host: "local",
    durationMs: 2,
  },
  {
    key: "delete-tmp",
    at: days(5, 6),
    kind: "file.delete",
    summary: "delete 4 entries",
    tag: "4 entries",
    host: "local",
    destructive: true,
    durationMs: 31,
    origin: "terminal",
    payload: {
      paths: [
        tree("tmp/build-8790.log"),
        tree("tmp/build-8791.log"),
        tree("tmp/build-8802.log"),
        tree("tmp/.pnpm-store"),
      ],
      removed: 4,
    },
  },
  {
    key: "create-notes",
    at: days(3, 1),
    kind: "file.create",
    summary: `create notes.md in ${tree("home/deploy")}`,
    host: "local",
    durationMs: 5,
    payload: { created: tree("home/deploy/notes.md"), mode: 420 },
  },
  {
    key: "download-dump",
    at: days(1, 9, 20),
    kind: "file.download",
    summary: "download db-2026-08-31.sql.gz",
    host: "local",
    bytes: 409 * MB,
    durationMs: 8_400,
    payload: {
      paths: [tree("opt/backups/db-2026-08-31.sql.gz")],
      kind: "file",
    },
  },
  {
    key: "download-zip",
    at: days(1, 9),
    kind: "file.download",
    summary: "download releases.zip",
    tag: "zip",
    host: "local",
    bytes: 24_600_000,
    durationMs: 3_900,
    payload: { paths: [tree("var/www/app/releases")], kind: "directory" },
  },
  {
    key: "link-minted",
    at: days(1, 8, 50),
    kind: "link.minted",
    summary: "signed link for site-2026-08-01.tar.gz",
    tag: "link",
    host: "local",
    destructive: true,
    durationMs: 4,
    payload: {
      ttlSeconds: 900,
      paths: [tree("opt/backups/site-2026-08-01.tar.gz")],
    },
  },
  {
    key: "link-used",
    at: days(1, 8, 41),
    kind: "link.used",
    summary: "signed link used for site-2026-08-01.tar.gz",
    tag: "link",
    host: "local",
    bytes: 1_210 * MB,
    durationMs: 61_000,
    payload: {
      paths: [tree("opt/backups/site-2026-08-01.tar.gz")],
      ip: "203.0.113.42",
      userAgent: "curl/8.7.1",
    },
  },
  {
    key: "hash-queued",
    at: days(1, 6, 2),
    kind: "file.hash",
    summary: "Queued sha256 for 1 path(s)",
    tag: "1 path(s)",
    host: "local",
    durationMs: 9,
    payload: { paths: [tree("var/www/app/releases/2026-08-30-1730")] },
  },
  {
    key: "hash-cancel",
    at: days(1, 5, 30),
    kind: "file.hash.cancel",
    summary: "Stopped a checksum job",
    host: "local",
    durationMs: 3,
  },
  {
    key: "compare-releases",
    at: days(1, 5),
    kind: "file.compare",
    summary: `Compared ${tree("var/www/app/releases/2026-08-21-0940")} with ${tree("var/www/app/releases/2026-08-30-1730")}`,
    tag: "same host",
    host: "local",
    durationMs: 412,
  },
  {
    key: "path-refused",
    at: days(1, 2),
    kind: "path.refused",
    summary: "20 refused paths within the counter's window",
    host: "local",
    outcome: "refused",
    detail:
      "20 refused paths in 60s. Nothing was withheld: a refused path answers 403 however many times it is asked for.",
    durationMs: 0,
    payload: { category: "outside-roots", path: "/etc/shadow" },
  },
  {
    key: "password-changed",
    at: days(1, 1),
    kind: "user.password",
    summary: "Changed the account password",
    destructive: true,
    durationMs: 190,
  },
  {
    key: "bookmark-edit",
    at: hours(23),
    kind: "bookmark.update",
    summary: "Edited the favourite MySQL data",
    host: "local",
    durationMs: 7,
  },
  {
    key: "bookmark-reorder",
    at: hours(22, 58),
    kind: "bookmark.reorder",
    summary: "Reordered favourites",
    tag: "6 items",
    host: "local",
    durationMs: 12,
  },
  {
    key: "rename-single",
    at: hours(21),
    kind: "file.rename",
    summary: "rename tour_720.mp4 → tour-720p.mp4",
    host: "local",
    destructive: true,
    origin: "terminal",
    durationMs: 8,
    payload: {
      newName: "tour-720p.mp4",
      paths: [tree("srv/media/videos/tour_720.mp4")],
    },
  },
  {
    key: "host-update",
    at: hours(9),
    kind: "host.update",
    summary: "Edited the host Kestrel",
    host: "local",
    destructive: true,
    durationMs: 27,
  },
  {
    key: "mkdir-pending",
    at: hours(2, 14),
    kind: "file.mkdir",
    summary: `mkdir scratch in ${tree("tmp")}`,
    host: "local",
    outcome: "pending",
    payload: { paths: [tree("tmp")] },
  },
  {
    key: "logout-2",
    at: hours(2, 12),
    kind: "user.logout",
    summary: "Signed out, closing 1 sudo window",
    durationMs: 4,
    session: 1,
  },
  {
    key: "upload-rate-limited",
    at: minutes(58),
    kind: "file.upload",
    summary: `upload into ${tree("var/www/app/shared/uploads/avatars")}`,
    host: "local",
    destructive: true,
    outcome: "refused",
    detail: "Rate limit reached: at most 30 uploads per 1 minute(s). Try again in 41 second(s).",
    durationMs: 0,
    payload: { conflict: "keepBoth" },
  },
  {
    key: "delete-refused",
    at: minutes(12),
    kind: "file.delete",
    summary: "delete 1 entry · ibdata1",
    tag: "1 entry",
    host: "local",
    destructive: true,
    outcome: "refused",
    detail: "Path is not allowed on this host.",
    durationMs: 2,
    payload: { paths: [tree("var/lib/mysql/ibdata1")] },
  },
];
