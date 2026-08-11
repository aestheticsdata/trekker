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
