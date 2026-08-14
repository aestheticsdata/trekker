import { API_ORIGIN, apiRequest } from "@lib/api/client";

/**
 * Transfers (TRE-24), against TRE-23's routes.
 *
 * Restated rather than imported, like `delete.ts` and `rename.ts`: the two
 * packages share no types package, and a field that drifts should fail at the
 * first render rather than render `undefined`.
 *
 * Note what is *not* here. Nothing in this file decides whether two entries
 * conflict, what "keep both" would call the copy, or whether there is room at
 * the destination. All three come from the server's own walk, because all three
 * are questions about two machines this browser cannot see — and a local answer
 * would be a second implementation, kept in step by nothing.
 */

export type TransferOperation = "copy" | "move";
export type ConflictStrategy = "ask" | "overwrite" | "skip" | "keepBoth";
export type TransferStatus = "QUEUED" | "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED";

export interface EntryFacts {
  size: number;
  mtimeMs: number;
  /** Only on the destination side, and only to tell a merge from a collision. */
  kind?: string;
}

export interface PlannedItem {
  /** Path relative to the selection — `reports/june.csv`. The key for overrides. */
  name: string;
  kind: string;
  bytes: number;
  mode: number | null;
  mtimeMs: number | null;
  source: EntryFacts;
  /** What is already at the destination under this name, or null. */
  target: EntryFacts | null;
  /**
   * Whether anybody has to answer for this row. Not the same as `target !== null`:
   * a directory arriving on a directory merges, so it is present and unasked.
   */
  conflict: boolean;
  /** The server's own line: "identical size · target is 3 d older". */
  note: string;
}

export interface TransferPlan {
  operation: TransferOperation;
  sameHost: boolean;
  source: { hostId: string; path: string };
  destination: { hostId: string; path: string; freeBytes: number | null };
  items: PlannedItem[];
  bytes: number;
  files: number;
  directories: number;
  conflicts: number;
  /** Symlinks under the selection, counted and not copied. */
  skippedLinks: number;
  truncated: boolean;
  ceiling: number;
}

export interface TransferView {
  id: string;
  operation: TransferOperation;
  status: TransferStatus;
  srcHostId: string | null;
  srcPath: string;
  dstHostId: string | null;
  dstPath: string;
  bytesTotal: number;
  bytesDone: number;
  itemsTotal: number;
  itemsDone: number;
  failed: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TransferItemView {
  name: string;
  kind: string;
  bytes: number;
  status: string;
  conflict: string;
  finalName: string | null;
  error: string | null;
}

/** What the SSE feed carries. Mirrors `TransferProgress` on the server. */
export interface TransferProgress {
  id: string;
  status: TransferStatus;
  bytesTotal: number;
  bytesDone: number;
  itemsTotal: number;
  itemsDone: number;
  rate: number | null;
  etaSeconds: number | null;
  error: string | null;
  failed: number;
}

export interface TransferRequest {
  srcHostId: string;
  srcPaths: readonly string[];
  dstHostId: string;
  dstPath: string;
  operation: TransferOperation;
}

export async function planTransfer(request: TransferRequest, csrfToken: string | null): Promise<TransferPlan> {
  return (await apiRequest("/transfers/plan", { method: "POST", body: request, csrfToken })) as TransferPlan;
}

export async function startTransfer(
  request: TransferRequest & { strategy: ConflictStrategy; overrides?: Record<string, ConflictStrategy> },
  csrfToken: string | null,
): Promise<TransferView> {
  return (await apiRequest("/transfers", { method: "POST", body: request, csrfToken })) as TransferView;
}

export async function fetchTransfers(): Promise<TransferView[]> {
  return (await apiRequest("/transfers")) as TransferView[];
}

export async function fetchTransfer(id: string): Promise<TransferView & { items: TransferItemView[] }> {
  return (await apiRequest(`/transfers/${id}`)) as TransferView & { items: TransferItemView[] };
}

export async function cancelTransfer(id: string, csrfToken: string | null): Promise<TransferView> {
  return (await apiRequest(`/transfers/${id}/cancel`, { method: "POST", csrfToken })) as TransferView;
}

export async function retryTransfer(id: string, csrfToken: string | null): Promise<TransferView> {
  return (await apiRequest(`/transfers/${id}/retry`, { method: "POST", csrfToken })) as TransferView;
}

/**
 * The progress feed's URL.
 *
 * `EventSource` is the one thing in this app that does not go through
 * `apiRequest`: it is not `fetch`, it takes a URL and opens its own connection.
 * `withCredentials` is what makes it send the session cookie, and it is the
 * reason this returns a URL rather than a stream — the caller constructs the
 * `EventSource` so it also owns closing it.
 */
export function transferStreamUrl(): string {
  return `${API_ORIGIN}/api/transfers/stream`;
}
