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
  /**
   * Bytes, and `null` for a directory (TRE-107).
   *
   * `stat` on a directory reports the block its own entries occupy — 4096 on
   * every filesystem this app is likely to meet — which is the same number for
   * an empty directory and for one holding a hundred gigabytes. It is a true
   * syscall result and a useless column, so it is not carried: what a directory
   * contains is a `du` walk, it arrives later over `/fs/dir-sizes/stream`, and
   * until it does this field says it does not know.
   *
   * Nullable rather than absent, and that is the point of it. Every total and
   * every scale over a listing has to decide what to do with a directory, and a
   * `number` let all six of them quietly add 4096. `null` makes each one say so.
   */
  size: number | null;
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

/**
 * Whole seconds, because that is the precision every transport can carry.
 *
 * `node:fs` reports milliseconds and SFTP v3 has only a seconds field, so the
 * same file read locally and over SSH would otherwise differ in its last three
 * digits — enough to fail a driver-parity comparison, and enough to make the
 * pane diff (TRE-28) invent changes between two copies that are identical.
 * Presenting the lower precision everywhere is what makes a timestamp mean the
 * same thing regardless of how the host was reached.
 */
function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

export function toRow(entry: FileEntry, names: OwnerNames): FileRow {
  const row: FileRow = {
    name: entry.name,
    type: rowTypeOf(entry.kind),
    size: entry.kind === "directory" ? null : entry.size,
    mode: octalMode(entry.mode),
    modeText: modeText(entry.mode),
    owner: names.owner ?? String(entry.uid),
    group: names.group ?? String(entry.gid),
    ownerResolved: names.owner !== null,
    groupResolved: names.group !== null,
    uid: entry.uid,
    gid: entry.gid,
    mtime: isoSeconds(entry.mtimeMs),
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
    atime: stat.atimeMs === undefined ? null : isoSeconds(stat.atimeMs),
    ctime: stat.ctimeMs === undefined ? null : isoSeconds(stat.ctimeMs),
  };
}
