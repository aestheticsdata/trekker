import { API_ORIGIN, apiRequest } from "@lib/api/client";

/**
 * Disk scans (TRE-33), against TRE-32's routes.
 *
 * Restated rather than imported, like `transfers.ts` and `delete.ts`: the two
 * packages share no types package, and a field that drifts should fail at the
 * first render rather than render `undefined`.
 *
 * Byte counts arrive as **strings**, and they stay strings here. A scan of a
 * multi-petabyte array outgrows a double, and the panel formats these rather
 * than computing with them — the one place arithmetic is unavoidable is the
 * treemap's proportions, which `@helpers/treemap` does in `BigInt` and converts
 * once, at the end, into a ratio.
 *
 * `stale`, `ageSeconds` and `staleAfterSeconds` are all the server's. The
 * threshold is a policy it owns and an install can tune, so the panel prints
 * what it is told rather than deciding for itself when a scan has gone off.
 */

export type ScanStatus = "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
export type ScanPhase = "probing" | "walking" | "hashing" | "saving";
export type ScanEntryKind = "DIRECTORY" | "FILE" | "OTHER";

export interface ScanFacts {
  largest: { path: string; bytes: string } | null;
  oldFiles: { count: string; bytes: string; before: string } | null;
  duplicates: {
    candidates: number;
    confirmed: number;
    skipped: number;
    reclaimableBytes: string;
  } | null;
}

export interface ScanView {
  id: string;
  hostId: string;
  root: string;
  depth: number;
  status: ScanStatus;
  flavour: "GNU" | "PORTABLE" | "SUBTOTALS";
  niced: boolean;
  startedAt: string;
  finishedAt: string | null;
  /** Seconds since it finished, computed server-side. Null while it runs. */
  ageSeconds: number | null;
  stale: boolean;
  staleAfterSeconds: number;
  totalBytes: string | null;
  inodes: string | null;
  unreadableCount: number;
  truncated: boolean;
  error: string | null;
  facts: ScanFacts;
}

export interface ScanEntry {
  path: string;
  bytes: string;
  /** The server's own rounding, for a label. The geometry comes from `bytes`. */
  percent: number;
  kind: ScanEntryKind;
  depth: number;
  /**
   * The API refuses this path outright, however a pane reaches it (TRE-105).
   *
   * Sent only to the owner, and only where it is true — so absent means "no
   * statement was made", which for every account that is not the owner is the
   * only thing this field ever says.
   */
  denied?: boolean;
}

export interface ScanLevel {
  at: string;
  /** What this level sums to — the denominator the bands are drawn against. */
  parentBytes: string;
  entries: ScanEntry[];
}

export interface ScanState {
  /** The newest finished scan of the asked-for root, or null if there is none. */
  scan: ScanView | null;
  /** A scan running on this host, whatever root it is walking. */
  running: ScanView | null;
  level: ScanLevel | null;
}

/** One frame of the progress feed. Deliberately no percentage: `du` has no denominator. */
export interface ScanProgress {
  id: string;
  hostId: string;
  root: string;
  status: ScanStatus;
  phase: ScanPhase;
  inodes: number;
  bytes: string;
  elapsedSeconds: number;
  hashedBytes: string | null;
  error: string | null;
}

/**
 * The panel's payload.
 *
 * `root` is matched verbatim against what the walk stored, which is the
 * *resolved* path the guard produced — so the root to ask for is the one a
 * previous answer named, never a path reassembled from somewhere else.
 */
export async function fetchScanState(hostId: string, root: string): Promise<ScanState> {
  const query = new URLSearchParams({ root });
  return (await apiRequest(`/hosts/${hostId}/scan?${query.toString()}`)) as ScanState;
}

export async function startScan(
  hostId: string,
  root: string,
  csrfToken: string | null,
  origin?: "terminal",
): Promise<ScanView> {
  return (await apiRequest(`/hosts/${hostId}/scan`, {
    method: "POST",
    body: { root },
    csrfToken,
    origin,
  })) as ScanView;
}

export async function cancelScan(hostId: string, csrfToken: string | null): Promise<ScanView> {
  return (await apiRequest(`/hosts/${hostId}/scan/cancel`, { method: "POST", csrfToken })) as ScanView;
}

/**
 * The progress stream's URL, built here rather than opened here.
 *
 * `EventSource` is the one thing that does not go through `apiRequest`: it is
 * not a request, it is a connection with a lifetime, and whoever opens it has
 * to be the one that closes it. Same shape as `transferStreamUrl`.
 */
export function scanStreamUrl(hostId: string): string {
  return `${API_ORIGIN}/api/hosts/${hostId}/scan/stream`;
}
