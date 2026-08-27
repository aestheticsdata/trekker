import type { FileRow, RowType } from "@lib/api/fs";

/**
 * Everything the file table computes from a row, in one place and with no
 * React in sight (TRE-16 §6).
 *
 * Formatting lives here rather than in the pane because these are the rules a
 * test will want to pin — a glob that must not become a regular expression, a
 * sort that must keep directories first — and because the inspector (TRE-17)
 * and the palette (TRE-36) will format the same values the same way.
 */

/* ---- formatting ------------------------------------------------------- */

/**
 * The mockup's ladder: two decimals from a GB up, one below, bytes exact.
 *
 * `null` is a size nobody knows — a directory whose `du` has not answered yet,
 * or was refused (TRE-107) — and prints as the same dash a symlink gets. The
 * pane draws a spinner over the pending case instead of calling this; every
 * other caller wants the dash, because "we do not know" and "not applicable"
 * are the same sentence to a reader.
 */
export function formatSize(bytes: number | null, type: RowType): string {
  if (type === "link" || bytes === null) return "—";
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(2)} TB`;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${Math.round(bytes)} B`;
}

/**
 * The size cell for a directory that is still being walked (TRE-107).
 *
 * A dash turning on its own axis, which is the same character the column would
 * otherwise be showing — so a pending row reads as "this figure is coming"
 * rather than as a different kind of row. Four frames, advanced by one ticker
 * the pane owns: every spinner in the listing therefore turns in step, which in
 * a monospace table looks deliberate where a hundred independent animations
 * would look like a fault.
 */
export const SPINNER_FRAMES = ["-", "\\", "|", "/"] as const;

export function spinnerFrame(tick: number): string {
  return SPINNER_FRAMES[tick % SPINNER_FRAMES.length] as string;
}

/** Bytes for the pane footer, where a directory total has no type to speak of. */
export function formatTotal(bytes: number): string {
  return formatSize(bytes, "file");
}

/**
 * A total over rows, some of which have no size yet (TRE-107).
 *
 * `≥`, because that is precisely what the figure is: the sum of what is known,
 * with some directories still being walked or refused outright. Printed bare it
 * would be a claim about rows nothing has counted — which is the habit this
 * ticket exists to break, one 4 kB directory at a time.
 */
export function formatPartialTotal(bytes: number, unknown: number): string {
  return unknown > 0 ? `≥ ${formatTotal(bytes)}` : formatTotal(bytes);
}

/** Why a total carries the `≥`, or nothing when it does not. */
export function partialTotalHint(unknown: number): string | undefined {
  if (unknown <= 0) return undefined;
  return unknown === 1
    ? "One directory has no size yet, so this total is a floor."
    : `${unknown} directories have no size yet, so this total is a floor.`;
}

/**
 * The exact count, grouped (TRE-17 §2). The stats row rounds; the metadata row
 * is where the number is the number, and nine digits unbroken are unreadable.
 *
 * The locale is pinned rather than the browser's: this renders on the server
 * first, and a separator chosen from two different locales is a hydration
 * mismatch on every file over a thousand bytes.
 */
export function formatExactBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} B`;
}

/**
 * What a file costs the filesystem, as opposed to what it contains.
 *
 * An estimate, and labelled as one: 4 KiB is the block size of every filesystem
 * this app is likely to meet, but neither `stat` over SFTP nor the listing
 * carries the real one, and a sparse file occupies far less than this says.
 * Worth showing anyway — the gap between 12 bytes and 4 KiB is the answer to
 * "why is this directory of tiny files so large".
 */
const BLOCK_BYTES = 4096;

export function onDiskBytes(bytes: number): number {
  return Math.ceil(bytes / BLOCK_BYTES) * BLOCK_BYTES;
}

/**
 * "2026-08-07 / 04:20:11" — the ISO instant, made readable, still UTC.
 *
 * The separator does the work the `T` was doing and does it visibly: a lone
 * space between two groups of digits leaves one long number that the eye has to
 * cut in half for itself, which is the whole of what made the raw value hard to
 * read (TRE-103). A slash with air on both sides says where the date stops.
 *
 * Sliced rather than stripped of its `T` and `Z`, because `toISOString()` — how
 * the API builds every timestamp — always emits a milliseconds field, even
 * after the server has deliberately floored the value to whole seconds. Trimming
 * only the two letters leaves a `.000` on every file in the app: three digits of
 * precision that were thrown away upstream, wide enough to push the inspector's
 * `modified` row into its own ellipsis.
 *
 * That ellipsis is the constraint the slash had to clear, and it does, with a
 * character to spare: the inspector gives its values 133px, Plex Mono advances
 * 0.6em, and at `text-2xs` this is 21 characters of the ~22 that fit. Anything
 * added here after this is not free — measure it.
 */
export function formatInstant(iso: string): string {
  return iso.slice(0, 19).replace("T", " / ");
}

export function ageDays(mtime: string, now: number): number {
  return (now - Date.parse(mtime)) / 86_400_000;
}

/**
 * One unit, never two: "3d", not "3d 4h". The column is 38px wide and the
 * question it answers is "roughly how stale", which one unit already answers.
 */
export function formatAge(days: number): string {
  if (days < 0) return "now";
  if (days < 0.0007) return `${Math.max(1, Math.round(days * 86_400))}s`;
  if (days < 0.042) return `${Math.round(days * 1440)}min`;
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 60) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

/* The seven age buckets moved to `@helpers/heat` with TRE-33, where the ramp
 * they index and the contrast check that verifies it live beside them. */

/* ---- the type tag ------------------------------------------------------ */

/** Label and background for the 14px tag in the first column. */
export interface TypeTag {
  label: string;
  className: string;
}

/**
 * Extension groups, from the mockup's own table. The colours are one-offs
 * belonging to this tag and nothing else, so they stay here as classes rather
 * than becoming twenty design tokens the rest of the app would never use.
 */
const TAGS: Record<string, TypeTag> = {
  js: { label: "JS", className: "bg-[#4a3f8f]" },
  ts: { label: "TS", className: "bg-[#35306e]" },
  json: { label: "{}", className: "bg-[#33495c]" },
  yml: { label: "YML", className: "bg-[#33495c]" },
  cfg: { label: "CFG", className: "bg-[#33495c]" },
  sql: { label: "SQL", className: "bg-[#0f3f6b]" },
  db: { label: "DB", className: "bg-[#0f3f6b]" },
  log: { label: "LOG", className: "bg-[#2c5a76]" },
  md: { label: "MD", className: "bg-[#2c5a76]" },
  htm: { label: "HTM", className: "bg-[#14456b]" },
  css: { label: "CSS", className: "bg-[#4a2f6b]" },
  img: { label: "IMG", className: "bg-[#1d5230]" },
  mp4: { label: "MP4", className: "bg-[#1d5230]" },
  sh: { label: "SH", className: "bg-[#1d5230]" },
  key: { label: "KEY", className: "bg-[#5f2f7a]" },
  pem: { label: "PEM", className: "bg-[#5f2f7a]" },
  gz: { label: "GZ", className: "bg-[#12545a]" },
};

/** Extensions that mean the same thing as one of the groups above. */
const ALIASES: Record<string, keyof typeof TAGS> = {
  mjs: "js",
  cjs: "js",
  jsx: "js",
  tsx: "ts",
  yaml: "yml",
  conf: "cfg",
  ini: "cfg",
  env: "cfg",
  toml: "cfg",
  sqlite: "db",
  markdown: "md",
  html: "htm",
  scss: "css",
  png: "img",
  jpg: "img",
  jpeg: "img",
  gif: "img",
  svg: "img",
  webp: "img",
  ico: "img",
  mov: "mp4",
  mkv: "mp4",
  webm: "mp4",
  bash: "sh",
  zsh: "sh",
  crt: "pem",
  cer: "pem",
  tgz: "gz",
  zst: "gz",
  bz2: "gz",
  xz: "gz",
  zip: "gz",
};

export function typeTag(row: FileRow): TypeTag {
  if (row.type === "dir") return { label: "DIR", className: "bg-on-pane-strong" };
  if (row.type === "link") return { label: "↗", className: "bg-on-pane-strong" };

  // hasOwn, not `in`: a file called `x.constructor` is a filename, not a
  // lookup into Object.prototype.
  const extension = row.extension;
  const key = Object.hasOwn(TAGS, extension) ? extension : ALIASES[extension];
  return key && Object.hasOwn(TAGS, key) ? TAGS[key] : { label: "{}", className: "bg-[#33495c]" };
}

/* ---- filtering --------------------------------------------------------- */

/**
 * A glob, and nothing more. `*` and `?` are the only two characters that mean
 * anything; everything else — including the dots and brackets a filename is
 * full of — is escaped so `a(1).log` matches itself and a pasted `.*` cannot
 * quietly become a wildcard.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

/* ---- sorting ----------------------------------------------------------- */

export type SortKey = "name" | "size" | "mode" | "owner" | "age";
/** 1 ascending, -1 descending — the multiplier the comparator ends with. */
export type SortDirection = 1 | -1;

/**
 * Directories first, always, whatever the column and whatever the direction:
 * a listing where `src/` sorts between two log files by size is a listing
 * nobody can navigate. Name breaks every tie so the order is total and a
 * re-render never shuffles equal rows.
 */
export function sortRows(rows: readonly FileRow[], key: SortKey, direction: SortDirection): FileRow[] {
  /**
   * `Date.parse` in the comparator is one parse per comparison of a string with
   * one answer — a quarter of a million of them on a ten-thousand-entry
   * directory, which made age eight times dearer than every other column
   * (TRE-19). Parsed once per row instead.
   */
  const instant = key === "age" ? new Map(rows.map((row) => [row, Date.parse(row.mtime)])) : null;

  return rows.slice().sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;

    // A size still being computed sorts after every known one, in **both**
    // directions — outside the multiplication below, exactly as the
    // directories-first rule is. A row must not leap to the top of the pane
    // because its `du` has not finished, and must not leap again when it does.
    if (key === "size" && (a.size === null) !== (b.size === null)) return a.size === null ? 1 : -1;

    let comparison = 0;
    if (key === "size") comparison = (a.size ?? 0) - (b.size ?? 0);
    // The column shows an age, so ascending means youngest first — which is
    // the newest mtime, not the oldest. Sorting the timestamps the obvious way
    // round would contradict the values printed in the column.
    else if (instant) comparison = (instant.get(b) as number) - (instant.get(a) as number);
    else if (key === "mode") comparison = a.mode.localeCompare(b.mode);
    else if (key === "owner") comparison = a.owner.localeCompare(b.owner);

    return (comparison || a.name.localeCompare(b.name)) * direction;
  });
}

/* ---- paths ------------------------------------------------------------- */

export function joinPath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

export function parentPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return `/${segments.join("/")}`;
}

/**
 * Where a symlink actually points.
 *
 * `readlink` returns the target as it was written, and most system symlinks
 * are written relative — `libssl.so -> libssl.so.3`, `latest -> ../releases/9`.
 * Following one verbatim would navigate to `/libssl.so.3`, a path that does
 * not exist, so the target is resolved against the directory the link lives in
 * and the `.`/`..` segments are collapsed before it is used.
 */
export function resolveTarget(directory: string, target: string): string {
  const base = target.startsWith("/") ? [] : directory.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") base.pop();
    else base.push(segment);
  }
  return `/${base.join("/")}`;
}

export interface Crumb {
  label: string;
  path: string;
  last: boolean;
}

/** "/" then a segment per level, each one navigable on its own. */
export function breadcrumbs(path: string): Crumb[] {
  const segments = path.split("/").filter(Boolean);
  return [{ label: "/", path: "/", last: segments.length === 0 }].concat(
    segments.map((segment, index) => ({
      label: segment + (index < segments.length - 1 ? "/" : ""),
      path: `/${segments.slice(0, index + 1).join("/")}`,
      last: index === segments.length - 1,
    })),
  );
}
