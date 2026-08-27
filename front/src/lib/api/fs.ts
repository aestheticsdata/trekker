import { API_ORIGIN, apiRequest } from "@lib/api/client";

/**
 * The listing endpoints (TRE-13), typed for the explorer (TRE-16).
 *
 * These interfaces mirror `nest-api/src/fs/file-row.ts` and `fs.service.ts`.
 * They are restated rather than imported because the two packages do not share
 * a types package, and a drifting field would fail here at the first render
 * rather than silently render `undefined`.
 */

export type RowType = "dir" | "file" | "link" | "other";

export interface FileRow {
  name: string;
  type: RowType;
  /**
   * Bytes, and `null` for a directory (TRE-107).
   *
   * The API does not know what a directory contains at listing time and does
   * not guess: `stat` reports the directory's own 4096-byte block, which is the
   * same figure for an empty folder and for one holding a hundred gigabytes.
   * The real total arrives afterwards on `/fs/dir-sizes/stream`; until it does,
   * this is `null` and every total and scale over the listing has to say so.
   */
  size: number | null;
  /** Octal, zero-padded to four digits: "0755". */
  mode: string;
  /** The `ls` rendering of the same bits: "rwxr-xr-x". */
  modeText: string;
  owner: string;
  group: string;
  ownerResolved: boolean;
  groupResolved: boolean;
  uid: number;
  gid: number;
  /** ISO instant, whole seconds. */
  mtime: string;
  extension: string;
  linkTarget?: string;
  /** False means following the link would be refused by the API. */
  linkInsideRoot?: boolean;
}

/**
 * One entry, statted (TRE-13 §4) — what the inspector's metadata rows read.
 *
 * The four extra fields are nullable because SFTP v3 has no attribute for an
 * inode or a link count. A remote host does not report them, and the panel
 * prints a dash rather than a zero it would be inventing.
 */
export interface FileRowDetail extends FileRow {
  path: string;
  /** The resolved real path — what the guard validated and the driver used. */
  realPath: string;
  inode: number | null;
  nlink: number | null;
  atime: string | null;
  ctime: string | null;
}

export interface ListMeta {
  count: number;
  /** The files' bytes. Directories are not in it — their size is not known yet. */
  totalBytes: number;
  /** How many rows are directories with no size, so a total can mark itself partial. */
  unknownDirs: number;
  truncated: boolean;
  totalEntries: number;
  tookMs: number;
}

export interface ListResult {
  entries: FileRow[];
  meta: ListMeta;
}

export async function fetchListing(hostId: string, path: string): Promise<ListResult> {
  const query = new URLSearchParams({ hostId, path });
  return (await apiRequest(`/fs/list?${query}`)) as ListResult;
}

export async function fetchStat(hostId: string, path: string): Promise<FileRowDetail> {
  const query = new URLSearchParams({ hostId, path });
  return (await apiRequest(`/fs/stat?${query}`)) as FileRowDetail;
}

/**
 * One directory's total, as it arrives (TRE-107).
 *
 * Exactly one of `bytes` and `error` is present, and `partial` qualifies
 * `bytes`: `du` walked what it could and was refused somewhere below, so the
 * figure is a floor rather than the total.
 */

/**
 * One directory's total, as it arrives (TRE-107).
 *
 * Exactly one of `bytes` and `error` is present, and `partial` qualifies
 * `bytes`: `du` walked what it could and was refused somewhere below, so the
 * figure is a floor rather than the total.
 */
export interface DirSizeFrame {
  name: string;
  bytes?: number;
  partial?: boolean;
  error?: string;
}

/** The `{ done: true }` that says the queue drained, on the same channel. */
export interface DirSizesDone {
  done: true;
}

/**
 * `firstVisible` and `visibleCount` say which rows to walk first. They do not
 * bound the work: the server walks every directory either way, because sorting
 * by size and the footer total both need every row.
 */
export function dirSizesStreamUrl(hostId: string, path: string, firstVisible: number, visibleCount: number): string {
  const query = new URLSearchParams({
    hostId,
    path,
    firstVisible: String(firstVisible),
    visibleCount: String(visibleCount),
  });
  return `${API_ORIGIN}/api/fs/dir-sizes/stream?${query.toString()}`;
}
