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

/** The mockup's ladder: two decimals from a GB up, one below, bytes exact. */
export function formatSize(bytes: number, type: RowType): string {
  if (type === "link") return "—";
  if (bytes >= 1_099_511_627_776) return `${(bytes / 1_099_511_627_776).toFixed(2)} TB`;
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${Math.round(bytes)} B`;
}

/** Bytes for the pane footer, where a directory total has no type to speak of. */
export function formatTotal(bytes: number): string {
  return formatSize(bytes, "file");
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

/** Seven buckets, fresh to ancient, indexing the `age-*` ramp. */
export function ageIndex(days: number): number {
  if (days < 0.02) return 0;
  if (days < 0.5) return 1;
  if (days < 3) return 2;
  if (days < 14) return 3;
  if (days < 60) return 4;
  if (days < 200) return 5;
  return 6;
}

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
  return rows.slice().sort((a, b) => {
    if ((a.type === "dir") !== (b.type === "dir")) return a.type === "dir" ? -1 : 1;

    let comparison = 0;
    if (key === "size") comparison = a.size - b.size;
    // The column shows an age, so ascending means youngest first — which is
    // the newest mtime, not the oldest. Sorting the timestamps the obvious way
    // round would contradict the values printed in the column.
    else if (key === "age") comparison = Date.parse(b.mtime) - Date.parse(a.mtime);
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
