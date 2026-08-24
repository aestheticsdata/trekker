"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { Tooltip, TooltipBlock } from "@components/ui/tooltip";
import { fetchActivity } from "@lib/api/activity";
import { undoChmod, undoChown } from "@lib/api/permissions";
import { QUERY_KEYS } from "@lib/query/keys";
import { useQuery, useQueryClient } from "@tanstack/react-query";

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
  const undoable = (item.kind === "file.chmod" || item.kind === "file.chown") && item.outcome === "success";

  return (
    // The row is 176px wide and its summary is a sentence, so the tooltip is not
    // a second copy of this row — it is the only place the row can be read. The
    // failure reason goes under it rather than beside it: "Removed a host" tells
    // you nothing you did not already know if it did not happen.
    <Tooltip
      content={
        <TooltipBlock
          note={item.detail}
          // Where it came from goes in the tooltip rather than as a badge on
          // the row: the row is 176px and its summary already truncates, so a
          // chip would be bought with the only words that say what happened.
          // Only shown when there is something to say — a button is the default
          // and a row marked "from: ui" on every entry marks nothing (TRE-35).
          rows={[
            { label: "when", value: stamp(item.createdAt) },
            ...(item.origin === null ? [] : [{ label: "from", value: item.origin }]),
          ]}
          subject={item.summary}
        />
      }
    >
      <li className="flex items-baseline gap-1.5 px-2.5 py-0.5">
        <Dot outcome={item.outcome} />
        <span className={`truncate font-sans text-xs ${item.outcome === "success" ? "text-ink-muted" : "text-ink"}`}>
          {item.summary}
        </span>
        {undoable && <UndoButton item={item} />}
        <span className="text-ink-faint ml-auto flex-none font-mono text-caps tabular-nums">
          {since(item.createdAt)}
        </span>
      </li>
    </Tooltip>
  );
}

/**
 * The durable fallback for undo (TRE-75): a toast is where it is usually
 * caught, but a dismissed one must not be the only way back, and this row
 * survives as long as its `PermissionSnapshots` rows do (30 days).
 */
function UndoButton({ item }: { item: ActivityView }) {
  const { csrfToken } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();

  const undo = () => {
    const call = item.kind === "file.chmod" ? undoChmod : undoChown;
    call(item.id, csrfToken)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY] });
        push({ tone: "info", message: "Reverted." });
      })
      .catch(() => {
        push({ tone: "danger", message: "Could not undo — it may have expired." });
      });
  };

  return (
    <button
      type="button"
      onClick={undo}
      aria-label="Undo"
      title="Undo — restores only what this change touched, not anything altered since."
      className="text-ink-faint hover:text-ink-muted flex-none cursor-pointer font-mono text-2xs"
    >
      ↺
    </button>
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
 * The absolute time behind that column: `2026-08-17 15:42`.
 *
 * Sliced off the ISO string rather than formatted. `toLocaleString` would ask
 * the browser which locale, and this app pins locales precisely because two
 * different answers either side of hydration is a mismatch — and for a log the
 * sliced form is unambiguous in a way a localised one is not.
 */
function stamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/**
 * Compact relative time — "4m", "3h", "2d". Deliberately not
 * `Intl.RelativeTimeFormat`: this column is 4 characters wide in the mockup and
 * "4 minutes ago" does not fit, so the full timestamp lives in the row's
 * tooltip where there is room for it.
 */
function since(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
