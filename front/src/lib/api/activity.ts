import { apiRequest } from "@lib/api/client";

/**
 * The activity trail (TRE-30 §4).
 *
 * The sidebar strip and the audit view read the same endpoint — one write, two
 * readers. That is what keeps the log honest: it is not extra work nobody
 * looks at, it is where the UI gets its content, so a gap in it is a gap
 * someone sees.
 */

export type ActivityOutcome = "pending" | "success" | "failure" | "refused";

export interface ActivityView {
  id: string;
  /** `subject.verb` — "host.delete", "bookmark.create". */
  kind: string;
  summary: string;
  /** Short badge: "3 files", "412 MB". */
  tag: string | null;
  hostId: string | null;
  outcome: ActivityOutcome;
  /** Why it failed or was refused. Already redacted server-side. */
  detail: string | null;
  elevated: boolean;
  /** Which surface started it — `"terminal"` (TRE-35), or null for a button. */
  origin: string | null;
  /**
   * A string, not a number: the column is a 64-bit count, and JSON has no
   * integer type that holds one without losing the low bits. Parse it where
   * you format it, never with `parseInt` into arithmetic you care about.
   */
  bytes: string | null;
  durationMs: number | null;
  createdAt: string;
  payload: unknown;
}

export interface ActivityPage {
  items: ActivityView[];
  /** Null on the last page. Pass it back as `cursor`. */
  nextCursor: string | null;
}

export interface ActivityFilters {
  hostId?: string;
  kind?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export async function fetchActivity(filters: ActivityFilters = {}): Promise<ActivityPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }

  const query = params.toString();
  return (await apiRequest(`/activity${query ? `?${query}` : ""}`)) as ActivityPage;
}
