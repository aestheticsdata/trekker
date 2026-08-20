import { API_ORIGIN, apiRequest } from "@lib/api/client";

/**
 * Checksums (TRE-27), against the API's `hash` routes.
 *
 * Restated rather than imported, like `scans.ts` and `transfers.ts` beside it:
 * the two packages share no types package, and a field that drifts should fail
 * at the first render rather than render `undefined`.
 *
 * Byte counts arrive as **strings** and stay strings. A job can be tens of
 * gigabytes, which outgrows what a double counts exactly, and nothing on this
 * side does arithmetic with them — the panel formats what it is given.
 *
 * `method` reaches the client on purpose. A digest computed by streaming the
 * file across the network is the same digest, but it cost something entirely
 * different to produce, and somebody looking at a checksum is exactly the
 * person who wants to know where it came from.
 */

export type HashStatus = "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/** `REMOTE` is `sha256sum` on the host; `STREAMED` read the bytes through the API. */
export type HashMethod = "REMOTE" | "STREAMED";

export interface HashView {
  hostId: string;
  path: string;
  digest: string;
  method: HashMethod;
  /** What the file measured when the digest was taken. */
  size: string;
  mtimeMs: string;
  computedAt: string;
}

export interface HashJobView {
  id: string;
  hostId: string;
  files: number;
  bytesTotal: string;
  /** In line rather than reading anything yet. */
  queued: boolean;
}

export interface HashState {
  /** Only ever a digest that still describes the file that is there. */
  hash: HashView | null;
  /** A digest was cached, and the file has changed since it was taken. */
  superseded: boolean;
  /** A job of this account that is going to hash this exact path. */
  running: HashJobView | null;
}

/**
 * One frame of the progress feed.
 *
 * `bytesDone` advances **per file** while the host is doing the hashing, which
 * is not a rounding choice: `sha256sum` says nothing while it reads and prints
 * one line when a file is finished, so whole files are the only honest
 * resolution available. The streamed fallback does know its position. `method`
 * is on every frame so the panel can tell which kind of progress it is drawing.
 */
export interface HashProgress {
  id: string;
  hostId: string;
  status: HashStatus;
  /** The file being read right now. Null before the first and after the last. */
  path: string | null;
  method: HashMethod | null;
  files: number;
  filesDone: number;
  /** Files the cache already held. Counted in `filesDone`, never read. */
  filesCached: number;
  filesFailed: number;
  bytesTotal: string;
  bytesDone: string;
  elapsedSeconds: number;
  error: string | null;
}

/**
 * What is known about one path.
 *
 * The path is sent as the client knows it and the server answers about the
 * resolved one — so `hash.path` may differ from what was asked for, which is
 * the same rule the scan panel follows about roots.
 */
export async function fetchHashState(hostId: string, path: string): Promise<HashState> {
  const query = new URLSearchParams({ hostId, path });
  return (await apiRequest(`/hash?${query.toString()}`)) as HashState;
}

export async function startHash(hostId: string, paths: string[], csrfToken: string | null): Promise<HashJobView> {
  return (await apiRequest("/hash", { method: "POST", body: { hostId, paths }, csrfToken })) as HashJobView;
}

export async function cancelHash(jobId: string, csrfToken: string | null): Promise<{ id: string; stopped: boolean }> {
  return (await apiRequest(`/hash/${jobId}/cancel`, { method: "POST", csrfToken })) as {
    id: string;
    stopped: boolean;
  };
}

/**
 * The progress stream's URL, built here rather than opened here.
 *
 * `EventSource` is the one thing that does not go through `apiRequest`: it is
 * not a request, it is a connection with a lifetime, and whoever opens it has
 * to be the one that closes it. Same shape as `scanStreamUrl`.
 *
 * Per user rather than per host, so one open stream serves both panes.
 */
export function hashStreamUrl(): string {
  return `${API_ORIGIN}/api/hash/stream`;
}

/** The head of a digest, which is what fits and what people compare. */
export function shortDigest(digest: string): string {
  return digest.slice(0, 16);
}
