"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { Tooltip } from "@components/ui/tooltip";
import { formatSize } from "@helpers/listing";
import { ApiError } from "@lib/api/client";
import { cancelTransfer, fetchTransfers, retryTransfer, transferStreamUrl } from "@lib/api/transfers";
import { QUERY_KEYS } from "@lib/query/keys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import type { TransferProgress, TransferView } from "@lib/api/transfers";
import type { ReactNode } from "react";

/**
 * Transfers in flight, and the strip that shows them (TRE-24 §3).
 *
 * The queue is **server state**, which is the whole design and the reason this
 * is a query rather than a `useState`. A transfer outlives the tab that started
 * it: reload the page, open a second one, come back an hour later, and the same
 * jobs are there because the server is the one keeping them. Everything here is
 * a view of `GET /transfers` that a live feed keeps ahead of the poll.
 *
 * The feed and the list answer different questions and neither replaces the
 * other. The list is *what jobs exist*, asked on load and whenever the stream
 * reconnects. The feed is *where each one has got to*, which changes several
 * times a second and is worth no round trip at all. Overlaying one on the other
 * is what stops a job that finished during a dropped connection from sitting at
 * 60% for ever.
 */

interface TransferContextValue {
  jobs: readonly TransferView[];
  /** True while the live feed is attached. False means the numbers are the poll's. */
  live: boolean;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  dismiss: (id: string) => void;
}

const TransferContext = createContext<TransferContextValue | null>(null);

/** How often the list is re-asked when the feed is not attached. */
const POLL_MS = 5_000;

/** Statuses a job is still doing something in. */
const ACTIVE = new Set(["QUEUED", "RUNNING", "PAUSED"]);

export function TransferProvider({ children }: { children: ReactNode }) {
  const { csrfToken } = useAuth();
  const queryClient = useQueryClient();
  const { push } = useToast();

  const [progress, setProgress] = useState<Record<string, TransferProgress>>({});
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [live, setLive] = useState(false);
  /** Jobs already announced, so a completion toast fires once and not per tick. */
  const announced = useRef(new Set<string>());

  const list = useQuery({
    queryKey: [QUERY_KEYS.TRANSFERS],
    queryFn: fetchTransfers,
    // The floor under the live feed rather than the way progress arrives. A
    // dropped stream that never reconnects still ends with the right answer,
    // five seconds late, instead of a bar frozen at whatever it last heard.
    refetchInterval: POLL_MS,
    staleTime: 1_000,
    throwOnError: false,
  });

  const jobs = (list.data ?? [])
    .map((job) => merge(job, progress[job.id]))
    .filter((job) => !dismissed.includes(job.id))
    .filter((job) => ACTIVE.has(job.status) || job.status === "FAILED");

  /**
   * The live feed.
   *
   * `EventSource` reconnects on its own with its own backoff, which is most of
   * why this is SSE rather than a websocket. What it does not do is tell us
   * what happened while it was away — so every `open`, first or fiftieth,
   * re-asks the list. That is the reconciliation, and it costs one request per
   * reconnection rather than one per second.
   */
  useEffect(() => {
    const source = new EventSource(transferStreamUrl(), { withCredentials: true });

    source.onopen = () => {
      setLive(true);
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.TRANSFERS] });
    };

    source.onmessage = (event: MessageEvent<string>) => {
      const update = parse(event.data);
      if (update === null) return;
      setProgress((current) => ({ ...current, [update.id]: update }));

      if (ACTIVE.has(update.status)) return;
      // A job that has just ended. The list is what decides whether the row
      // stays — this only makes sure it is asked, and asked once.
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.TRANSFERS] });
    };

    source.onerror = () => {
      setLive(false);
      // Deliberately nothing else. A network drop is EventSource's own problem
      // and it retries; a 401 closes it for good, and the request the poll
      // above is about to make is what routes that to the login screen.
    };

    return () => {
      source.close();
      setLive(false);
    };
  }, [queryClient]);

  /**
   * What a finished transfer does to the rest of the app.
   *
   * Both panes are invalidated rather than the destination's alone: a move
   * changed the source too, and a pane showing either is now describing a
   * directory that is not there any more.
   */
  useEffect(() => {
    for (const job of list.data ?? []) {
      if (ACTIVE.has(job.status) || announced.current.has(job.id)) continue;
      announced.current.add(job.id);

      for (const hostId of [job.srcHostId, job.dstHostId]) {
        if (hostId === null) continue;
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.DIRECTORY, hostId] });
        void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.ENTRY, hostId] });
      }
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.ACTIVITY] });

      if (job.status === "DONE") {
        push({
          tone: "success",
          message: `${job.operation === "move" ? "Moved" : "Copied"} ${count(job.itemsTotal, "entry", "entries")}`,
          detail: `${formatSize(job.bytesDone, "file")} into ${job.dstPath}`,
        });
      } else if (job.status === "FAILED") {
        // The row stays in the strip with its retry, so the toast says what
        // happened rather than repeating what the row is already showing.
        push({ tone: "warning", message: "Transfer finished with failures", detail: job.error ?? undefined });
      }
    }
  }, [list.data, queryClient, push]);

  const stop = useMutation({
    mutationFn: (id: string) => cancelTransfer(id, csrfToken),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.TRANSFERS] }),
    onError: (error) =>
      push({
        tone: "danger",
        message: "Could not cancel that transfer",
        detail: error instanceof ApiError ? error.message : undefined,
      }),
  });

  const again = useMutation({
    mutationFn: (id: string) => retryTransfer(id, csrfToken),
    onSuccess: (job) => {
      // Off the announced list, or the completion it is about to reach a second
      // time would pass in silence.
      announced.current.delete(job.id);
      void queryClient.invalidateQueries({ queryKey: [QUERY_KEYS.TRANSFERS] });
    },
    onError: (error) =>
      push({
        tone: "danger",
        message: "Could not retry that transfer",
        detail: error instanceof ApiError ? error.message : undefined,
      }),
  });

  return (
    <TransferContext.Provider
      value={{
        jobs,
        live,
        cancel: (id) => stop.mutate(id),
        retry: (id) => again.mutate(id),
        dismiss: (id) => setDismissed((current) => [...current, id]),
      }}
    >
      {children}
    </TransferContext.Provider>
  );
}

export function useTransfers(): TransferContextValue {
  const value = useContext(TransferContext);
  if (value === null) throw new Error("useTransfers must be used inside a TransferProvider");
  return value;
}

/**
 * The queue, as the sidebar renders it.
 *
 * One row per job that is going or went wrong. A job that finished cleanly is
 * gone from here and in the activity strip below, which is the honest division:
 * this section is about work in progress, and a completed transfer is history.
 */
export function TransferQueue() {
  const { jobs, cancel, retry, dismiss } = useTransfers();

  if (jobs.length === 0) {
    return <p className="text-ink-faint px-2.5 py-1 font-mono text-2xs">Nothing moving. F5 copies, F6 moves.</p>;
  }

  return (
    <>
      {jobs.map((job) => (
        <QueueRow
          key={job.id}
          job={job}
          onCancel={() => cancel(job.id)}
          onRetry={() => retry(job.id)}
          onDismiss={() => dismiss(job.id)}
        />
      ))}
    </>
  );
}

function QueueRow({
  job,
  onCancel,
  onRetry,
  onDismiss,
}: {
  job: TransferView & { rate?: number | null; etaSeconds?: number | null };
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const failed = job.status === "FAILED";
  // By bytes when there are any, by items when there are not — a transfer of a
  // thousand empty files has no bytes to be a fraction of, and a bar stuck at
  // zero for a job that is nearly done is worse than no bar.
  const fraction =
    job.bytesTotal > 0 ? job.bytesDone / job.bytesTotal : job.itemsTotal > 0 ? job.itemsDone / job.itemsTotal : 0;

  return (
    <div className="border-raised flex flex-col gap-1 border-t px-2.5 py-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className={`font-mono text-2xs ${failed ? "text-danger-soft" : "text-ink-label"}`}>{job.operation}</span>
        <span className="text-ink-soft min-w-0 flex-1 truncate font-mono text-xs">{basename(job.dstPath)}</span>
        <Tooltip content={failed ? "Dismiss" : "Cancel"}>
          <button
            type="button"
            aria-label={failed ? `Dismiss ${job.operation} into ${job.dstPath}` : `Cancel ${job.operation}`}
            onClick={failed ? onDismiss : onCancel}
            className="text-ink-faint hover:text-ink flex-none font-mono text-2xs"
          >
            ×
          </button>
        </Tooltip>
      </div>

      {failed ? (
        <div className="flex items-baseline gap-1.5">
          <span className="text-danger-soft min-w-0 flex-1 truncate font-mono text-2xs">
            {job.error ?? "Something went wrong."}
          </span>
          {/* Only the failures re-run, which is why this is offered at all: a
              retry that redid the whole job would move gigabytes to fix one file. */}
          {job.failed > 0 && (
            <button
              type="button"
              onClick={onRetry}
              className="text-ink-label hover:text-brand flex-none font-mono text-2xs"
            >
              retry {job.failed}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="bg-chrome h-0.75 w-full overflow-hidden rounded-sm">
            <div
              className="bg-accent-soft h-full transition-[width] duration-200"
              style={{ width: `${Math.round(Math.min(fraction, 1) * 100)}%` }}
            />
          </div>
          <div className="text-ink-faint flex items-baseline gap-1.5 font-mono text-2xs">
            <span>{Math.round(Math.min(fraction, 1) * 100)}%</span>
            <span className="min-w-0 flex-1 truncate">
              {job.status === "QUEUED" ? "queued" : describeRate(job.rate ?? null)}
            </span>
            <span>{describeEta(job.etaSeconds ?? null)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The list's row with the feed's numbers on top.
 *
 * The feed wins on the counters and the list wins on everything else. The list
 * is a snapshot that may be five seconds old; the feed is a stream of numbers
 * with no paths, no hosts and no timestamps in it. Taking each from the one
 * that knows is the whole point of having both.
 */
function merge(
  job: TransferView,
  update: TransferProgress | undefined,
): TransferView & { rate: number | null; etaSeconds: number | null } {
  if (!update) return { ...job, rate: null, etaSeconds: null };

  return {
    ...job,
    status: update.status,
    bytesTotal: update.bytesTotal || job.bytesTotal,
    bytesDone: Math.max(update.bytesDone, job.bytesDone),
    itemsTotal: update.itemsTotal || job.itemsTotal,
    itemsDone: Math.max(update.itemsDone, job.itemsDone),
    failed: update.failed || job.failed,
    error: update.error ?? job.error,
    rate: update.rate,
    etaSeconds: update.etaSeconds,
  };
}

function parse(payload: string): TransferProgress | null {
  try {
    return JSON.parse(payload) as TransferProgress;
  } catch {
    // A truncated frame from a proxy that cut a message in half. The next one
    // is a whole second away and carries the same counters.
    return null;
  }
}

function describeRate(rate: number | null): string {
  if (rate === null || rate <= 0) return "";
  return `${formatSize(rate, "file")}/s`;
}

function describeEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
