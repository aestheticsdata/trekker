import { apiRequest } from "@lib/api/client";

/**
 * Directory comparison (TRE-28), against the API's `compare` route.
 *
 * Restated rather than imported, like `scans.ts` and `hashes.ts` beside it: the
 * two packages share no types package, and a field that drifts should fail at
 * the first render rather than render `undefined`.
 *
 * Sizes are **numbers** here, unlike the scan and checksum payloads, and the
 * difference is real rather than an inconsistency: those carry totals over a
 * whole filesystem, which outgrow a double. These are one file's size, which
 * does not, and they arrive from the same `list()` the panes already draw as
 * numbers.
 */

export type Verdict = "onlyA" | "onlyB" | "differs" | "identical" | "inconclusive";

/** Which level reached the verdict. On screen it is the row's explanation. */
export type Reason = "name" | "kind" | "size" | "mtime" | "link" | "hash" | "depth";

export type EntryKind = "file" | "directory" | "symlink" | "block" | "character" | "fifo" | "socket" | "unknown";

export interface SideFacts {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  linkTarget?: string;
}

export interface CompareEntry {
  /** Relative to both roots, so one string names the same thing on both sides. */
  path: string;
  depth: number;
  a: SideFacts | null;
  b: SideFacts | null;
  verdict: Verdict;
  reason: Reason;
}

export interface CompareSummary {
  total: number;
  onlyA: number;
  onlyB: number;
  differs: number;
  identical: number;
  inconclusive: number;
  /** Rows a checksum would settle. A subset of `inconclusive`. */
  hashable: number;
}

export interface CompareSide {
  hostId: string;
  /** The resolved root. Every entry path hangs off this, so joins use it. */
  path: string;
}

export interface CompareResult {
  a: CompareSide;
  b: CompareSide;
  depth: number;
  maxEntries: number;
  /** A bound bit: the row ceiling, or a shared directory left unopened. */
  truncated: boolean;
  unreadable: string[];
  unreadableCount: number;
  entries: CompareEntry[];
  summary: CompareSummary;
  /** The absolute paths a checksum pass would ask for, one list per side. */
  hashable: { a: string[]; b: string[] };
}

export interface ComparePair {
  hostId: string;
  path: string;
}

export async function runCompare(
  a: ComparePair,
  b: ComparePair,
  csrfToken: string | null,
  depth?: number,
): Promise<CompareResult> {
  return (await apiRequest("/compare", {
    method: "POST",
    body: { a, b, ...(depth === undefined ? {} : { depth }) },
    csrfToken,
  })) as CompareResult;
}

/**
 * The sentence under a row, in the same words the server decided it in.
 *
 * Written here rather than sent, because it is presentation and the reason code
 * is the fact. A server that sent the prose would be a server deciding how the
 * modal reads.
 */
export function explain(entry: CompareEntry): string {
  switch (entry.reason) {
    case "name":
      return entry.verdict === "onlyA" ? "not on the right" : "not on the left";
    case "kind":
      return `${entry.a?.kind ?? "?"} on the left, ${entry.b?.kind ?? "?"} on the right`;
    case "size":
      return "different size";
    case "mtime":
      return "same size, different time";
    case "link":
      return entry.verdict === "inconclusive" ? "a link this host would not read" : "by what the link points at";
    case "depth":
      return "not compared — the depth limit stopped here";
    case "hash":
      if (entry.verdict === "identical") return "same bytes";
      if (entry.verdict === "differs") return "same size and time, different bytes";
      return "same size and time — only a checksum can tell";
  }
}
