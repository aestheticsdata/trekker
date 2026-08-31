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
 * The mockup's ladder: at most two decimals from a GB up, one below, bytes
 * exact — and never a trailing zero among them (TRE-137).
 *
 * Powers of ten, because the labels are `kB` and `MB` (TRE-133). The division
 * used to be by 1024 under those same names, which left every figure in the app
 * smaller than its own unit claimed and put totals in bands a decimal ladder
 * cannot reach — `1022 MB`, four characters wide and a gigabyte in all but
 * name. Kibibytes are a real unit with real labels, and these are not them.
 *
 * `null` is a size nobody knows — a directory whose `du` has not answered yet,
 * or was refused (TRE-107) — and prints as the same dash a symlink gets. The
 * pane draws a spinner over the pending case instead of calling this; every
 * other caller wants the dash, because "we do not know" and "not applicable"
 * are the same sentence to a reader.
 */
export function formatSize(bytes: number | null, type: RowType): string {
  if (type === "link" || bytes === null) return "—";
  if (bytes >= 1_000_000_000_000) return `${decimals(bytes / 1_000_000_000_000, 2)} TB`;
  if (bytes >= 1_000_000_000) return `${decimals(bytes / 1_000_000_000, 2)} GB`;
  if (bytes >= 1_000_000) return `${decimals(bytes / 1_000_000, 1)} MB`;
  if (bytes >= 1000) return `${decimals(bytes / 1000, 1)} kB`;
  return `${Math.round(bytes)} B`;
}

/**
 * The ladder's precision, capped so a figure is never wider than eight
 * characters (TRE-110).
 *
 * The mockup shows `1.24 GB` and never a three-digit one, so it does not say
 * what `411.61 GB` should look like — but the column is 62px, about nine
 * monospace characters, and that figure needs nine. Directories only began
 * reporting real totals in TRE-107, which is what turned three-digit gigabytes
 * from a curiosity into an everyday value.
 *
 * A digit before the point is worth more than one after it: at 411 GB the
 * second decimal is ten megabytes, below anything anyone reads this column to
 * decide. So precision is given up from the right, one place at a time, and
 * only once the integer part has grown enough to need the room:
 *
 *   4 kB   28.55 GB   992 kB   127.1 MB   411.6 GB   1000 kB
 *
 * Precision the value does not have is not printed either: the places above are
 * a ceiling, not a shape, so `28.55 GB` keeps both digits while `1.00 GB` is
 * written `1 GB` (TRE-137). A zero after the point holds the column's decimal
 * points in a line, which is a real thing to want and worth less than the two
 * characters it costs in a cell that has already had to give up precision to
 * fit.
 *
 * `1000 kB` is the one way a decimal rung reaches four integer digits: from
 * 999_950 bytes up, 999.95 kB and over rounds to a `1000.0` the column cannot
 * hold. Those fifty bytes give up their decimals rather than their rung — a
 * hair under a megabyte, still counted in kilobytes, honest about both.
 */
function decimals(value: number, places: number): string {
  const shown = Number(value.toFixed(value >= 100 ? Math.min(places, 1) : places));
  return String(shown >= 1000 ? Math.round(value) : shown);
}

/** Bytes for the pane footer, where a directory total has no type to speak of. */
export function formatTotal(bytes: number): string {
  return formatSize(bytes, "file");
}

/**
 * Why a total or a figure is less than it should be, or nothing when it is not
 * (TRE-107, reworked by TRE-110).
 *
 * There is deliberately no marker to go with it. `≥` was tried and removed: on
 * `/` nearly every directory has a subtree the account cannot read, so nearly
 * every row carried the symbol, and a qualifier that is almost always present
 * qualifies nothing — while costing two characters the column did not have,
 * which wrapped the cell and broke the row.
 *
 * Uncertainty is an ink instead. The figure renders dimmed and explains itself
 * on hover, which reads as "less sure" at a glance, costs no width, and needs
 * nobody to have learnt a symbol.
 */
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

/* ---- the type mark ------------------------------------------------------ */

/**
 * Which silhouette a row draws in the 14px gutter (TRE-108).
 *
 * Shape, not tint. Until this ticket every row in that column drew the same
 * object — one filled pastille, three letters at 5.8px — and the only thing
 * that told a directory from a `.log` was the fill behind letters nobody reads
 * at that size. A colour code has to be learnt; an outline does not. So the
 * folder is the one solid form in the gutter and every file is hollow, and the
 * question the pane is asked most often is answered without reading a name.
 *
 * A symlink keeps the folder's silhouette in the lighter ink: it is walked
 * through, but it points elsewhere.
 */
export type MarkShape = "folder" | "link" | "file";

export function markShape(type: RowType): MarkShape {
  if (type === "dir") return "folder";
  if (type === "link") return "link";
  return "file";
}

/**
 * The four colours the mark is made of, on one ground.
 *
 * Named here rather than written into the component for the reason `press.ts`,
 * `tooltip.ts` and `disks.ts` exist, and which `verify-contrast.ts` states in
 * its own words: a class written straight into a component is a pair no check
 * can see. `verify:contrast` imports both sets and measures every one of them —
 * the two fills and the edge against 1.4.11's 3:1, because a shape carrying
 * meaning is a graphic, and the letters against AA, because they are text.
 */
export interface MarkInk {
  /** The solid folder body, and the tab above it. */
  readonly folder: string;
  /** The same silhouette for a symlink, one step lighter. */
  readonly link: string;
  /** The hollow pastille's 1px edge, which is the whole of its shape. */
  readonly edge: string;
  /** The letters inside it. */
  readonly letters: string;
}

/**
 * 2a's own symlink blue, kept for the record beside the one that ships.
 *
 * It measures 2.21:1 on `bg-pane` — the mark is a shape carrying meaning, which
 * 1.4.11 asks 3:1 of — so it could not ship as drawn. `verify:contrast` prints
 * both numbers, which is TRE-33's rule for every mockup colour this app has had
 * to correct: the hue is the mockup's, the ground is the mockup's, and only the
 * lightness moves.
 */
export const MOCKUP_LINK_HEX = "#3e7fa6";

/**
 * A pane row: dark ink on the app's one light surface.
 *
 * The symlink is `#326585`, which is `MOCKUP_LINK_HEX` at the same hue (202.5°)
 * and the same saturation (45.6%) with its lightness taken from 44.7% to 36% —
 * the least that clears 3:1 on all five row colours, and no further.
 *
 * "No further" is the whole of it. The first attempt reached for
 * `on-pane-strong`, an existing token that clears with room to spare, and that
 * was the wrong number to optimise: it sits **1.63:1** from the folder's own
 * ink, so the two silhouettes this mark exists to tell apart became two solids
 * nobody could tell apart. `#326585` is 2.33:1 from it, against 3.35:1 for the
 * mockup's. The ratio that matters for this one colour is the one to the mark
 * beside it, not the one to the ground under it.
 */
export const MARK_ON_PANE: MarkInk = {
  folder: "bg-on-pane",
  link: "bg-[#326585]",
  edge: "border-on-pane/65",
  letters: "text-on-pane-label",
};

/**
 * The copy plan and the delete confirmation: light ink on a panel.
 *
 * `#4d7f99` is the one value here with no token, and stays a literal for the
 * reason it is already one in `disks.ts` — it is the mockup's own quiet blue,
 * belonging to that strip and to this mark rather than to the palette.
 */
export const MARK_ON_PANEL: MarkInk = {
  folder: "bg-brand",
  link: "bg-[#4d7f99]",
  edge: "border-brand/50",
  letters: "text-brand",
};

/**
 * Extension groups, from the mockup's own table.
 *
 * The letters, and nothing else now: the twenty one-off fills that used to sit
 * beside them came off with TRE-108. They were never perceivable at this size —
 * measured as ink on a pane they land between 4.3 and 5.5:1, against 6.2 for
 * the one neutral the letters now wear — and a badge that has to be read to be
 * understood is a badge that has already failed at 6.4px.
 */
const TAGS: Record<string, string> = {
  js: "JS",
  ts: "TS",
  json: "{}",
  yml: "YML",
  cfg: "CFG",
  sql: "SQL",
  db: "DB",
  log: "LOG",
  md: "MD",
  htm: "HTM",
  css: "CSS",
  img: "IMG",
  mp4: "MP4",
  sh: "SH",
  key: "KEY",
  pem: "PEM",
  gz: "GZ",
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

/**
 * The letters on a hollow pastille.
 *
 * Only ever asked about a file: a folder and a symlink are a shape and carry
 * none. An extension nothing here names falls back to `{}`, which is what the
 * mockup draws over anything it has no group for.
 */
export function typeLetters(extension: string): string {
  // hasOwn, not `in`: a file called `x.constructor` is a filename, not a
  // lookup into Object.prototype.
  const key = Object.hasOwn(TAGS, extension) ? extension : ALIASES[extension];
  return key && Object.hasOwn(TAGS, key) ? TAGS[key] : "{}";
}

/**
 * The driver's own word for a kind, narrowed to a row type.
 *
 * The pane is handed a `RowType` already. The copy plan and the delete
 * confirmation are not — they carry the string the driver reported, which is
 * `"directory"`, `"symlink"`, `"file"` or one of five words for a special file
 * — so the mark repeats the collapse the API makes on its way to a listing
 * rather than growing a second idea of what a directory is called.
 */
export function rowTypeOf(kind: string): RowType {
  if (kind === "directory") return "dir";
  if (kind === "file") return "file";
  if (kind === "symlink") return "link";
  return "other";
}

/**
 * The extension a name ends in, lowercased and without its dot.
 *
 * The API sends `extension` on a listing row and this repeats its rule, for the
 * same two modals: they are given a name and a kind and nothing else, because
 * until the mark existed neither had anything to draw with it. A leading dot is
 * not a separator — `.env` is a name, not an extension — and a trailing one is
 * not either.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
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
