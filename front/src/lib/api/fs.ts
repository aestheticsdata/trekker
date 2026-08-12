import { apiRequest } from "@lib/api/client";

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
  size: number;
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
  totalBytes: number;
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
