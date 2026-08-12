"use client";

import { fetchActivity } from "@lib/api/activity";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery } from "@tanstack/react-query";

import type { ActivityOutcome, ActivityView } from "@lib/api/activity";

/**
 * The sidebar's activity strip (TRE-30 §4, TRE-18 §3).
 *
 * TRE-18 shipped the sidebar without this on purpose: nothing wrote an
 * `ActivityLog` row yet and the vocabulary of `kind` was this ticket's to
 * define, so the panel would have been empty on every install. It reads the
 * same endpoint an audit view would — one write, two readers — which is what
 * stops the log rotting: a gap in it is now a gap somebody sees on every page
 * load rather than one discovered during an incident.
 */

/** Enough to fill the strip without pushing FAVOURITES off the fold. */
const STRIP_LIMIT = 8;

export function ActivityStrip() {
  const { data } = useQuery({
    queryKey: [QUERY_KEYS.ACTIVITY, STRIP_LIMIT],
    queryFn: () => fetchActivity({ limit: STRIP_LIMIT }),
    staleTime: 30_000,
    // The strip is decoration on a page whose job is browsing files. A failed
    // fetch renders nothing and says nothing — an error toast here would
    // interrupt the actual task to report that a side panel is unavailable.
    throwOnError: false,
  });

  const items = data?.items ?? [];
  if (items.length === 0) return <Empty>Nothing yet.</Empty>;

  return (
    <ul className="pb-1">
      {items.map((item) => (
        <Row
          key={item.id}
          item={item}
        />
      ))}
    </ul>
  );
}

function Row({ item }: { item: ActivityView }) {
  // The failure reason is worth more than the intent when there is one: "Removed
  // a host" tells you nothing you did not already know if it did not happen.
  const title = item.detail ? `${item.summary} — ${item.detail}` : item.summary;

  return (
    <li
      className="flex items-baseline gap-1.5 px-2.5 py-0.5"
      title={title}
    >
      <Dot outcome={item.outcome} />
      <span className={`truncate font-sans text-xs ${item.outcome === "success" ? "text-ink-muted" : "text-ink"}`}>
        {item.summary}
      </span>
      <span className="text-ink-faint ml-auto flex-none font-mono text-caps tabular-nums">{since(item.createdAt)}</span>
    </li>
  );
}

/**
 * Colour carries the outcome, and only when it is not `success`. A strip where
 * every row is green trains the eye to skip it, which costs exactly the one
 * row that was not.
 */
function Dot({ outcome }: { outcome: ActivityOutcome }) {
  const colour =
    outcome === "failure"
      ? "bg-danger"
      : outcome === "refused"
        ? "bg-warning"
        : outcome === "pending"
          ? "bg-accent-dim"
          : "bg-line-strong";

  return (
    <span
      className={`size-1 flex-none rounded-full ${colour}`}
      aria-hidden
    />
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-faint px-2.5 pb-1 font-sans text-xs italic">{children}</p>;
}

/**
 * Compact relative time — "4m", "3h", "2d". Deliberately not
 * `Intl.RelativeTimeFormat`: this column is 4 characters wide in the mockup and
 * "4 minutes ago" does not fit, so the full timestamp lives in the row's
 * `title` where there is room for it.
 */
function since(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
