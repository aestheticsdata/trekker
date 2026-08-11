import type { FileEntry, FileKind, FileStat } from "@hosts/drivers/host-driver";

/**
 * The shape every file table column in the mockup reads from (TRE-13 §1).
 *
 * Formatting decisions the client owns are left to it: sizes stay bytes, and
 * times are ISO instants rather than "3 days ago", which only the browser can
 * compute against its own clock.
 */

/** Four buckets, because that is what the UI draws. */
export type RowType = "dir" | "file" | "link" | "other";

export interface FileRow {
  name: string;
  type: RowType;
  size: number;
  /** Octal, zero-padded to four digits: "0755". */
  mode: string;
  /** The `ls` rendering of the same bits: "rwxr-xr-x". */
  modeText: string;
  /** Owner name when it resolves, otherwise the numeric uid as a string. */
  owner: string;
  group: string;
  /** True when only the number was available — the UI can style it differently. */
  ownerResolved: boolean;
  groupResolved: boolean;
  uid: number;
  gid: number;
  mtime: string;
  /** Lowercase, no dot, "" when there is none. Dotfiles have no extension. */
  extension: string;
  /** Symlinks only. */
  linkTarget?: string;
  /**
   * Symlinks only: whether the target lands inside one of this host's roots.
   * False means following it would be refused, and the UI says so rather than
   * offering a link that cannot be opened.
   */
  linkInsideRoot?: boolean;
}

export interface FileRowDetail extends FileRow {
  path: string;
  /** The resolved real path — what the guard validated and the driver used. */
  realPath: string;
  inode: number | null;
  nlink: number | null;
  atime: string | null;
  ctime: string | null;
}

export function rowTypeOf(kind: FileKind): RowType {
  switch (kind) {
    case "directory":
      return "dir";
    case "file":
      return "file";
    case "symlink":
      return "link";
    default:
      return "other";
  }
}

/** "0755" — four digits so setuid and friends are visible when set. */
export function octalMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, "0");
}

/** "rwxr-xr-x", the bit rendering everyone already reads at a glance. */
export function modeText(mode: number): string {
  const triple = (bits: number): string =>
    `${bits & 0b100 ? "r" : "-"}${bits & 0b010 ? "w" : "-"}${bits & 0b001 ? "x" : "-"}`;
  return `${triple((mode >> 6) & 0b111)}${triple((mode >> 3) & 0b111)}${triple(mode & 0b111)}`;
}

/**
 * "tar.gz" is not an extension anyone filters on; the last segment is. A
 * leading dot makes a dotfile, not an extension — `.bashrc` has none.
 */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

export interface OwnerNames {
  owner: string | null;
  group: string | null;
}

export function toRow(entry: FileEntry, names: OwnerNames): FileRow {
  const row: FileRow = {
    name: entry.name,
    type: rowTypeOf(entry.kind),
    size: entry.size,
    mode: octalMode(entry.mode),
    modeText: modeText(entry.mode),
    owner: names.owner ?? String(entry.uid),
    group: names.group ?? String(entry.gid),
    ownerResolved: names.owner !== null,
    groupResolved: names.group !== null,
    uid: entry.uid,
    gid: entry.gid,
    mtime: new Date(entry.mtimeMs).toISOString(),
    extension: entry.kind === "directory" ? "" : extensionOf(entry.name),
  };
  if (entry.linkTarget !== undefined) row.linkTarget = entry.linkTarget;
  return row;
}

export function toDetail(stat: FileStat, names: OwnerNames, realPath: string): FileRowDetail {
  return {
    ...toRow(stat, names),
    path: stat.path,
    realPath,
    inode: stat.inode ?? null,
    nlink: stat.nlink ?? null,
    atime: stat.atimeMs === undefined ? null : new Date(stat.atimeMs).toISOString(),
    ctime: stat.ctimeMs === undefined ? null : new Date(stat.ctimeMs).toISOString(),
  };
}
