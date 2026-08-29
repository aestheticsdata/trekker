"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { formatSize } from "@helpers/listing";
import { ApiError } from "@lib/api/client";
import { UploadRefusal, uploadBatch } from "@lib/api/upload";
import { createContext, useContext, useState } from "react";

import type { PickedFile } from "@helpers/picked";
import type { ConflictPolicy, UploadResult } from "@lib/api/upload";
import type { ReactNode } from "react";

/**
 * Uploads in flight, and the tray that shows them (TRE-65, TRE-126).
 *
 * A context rather than state in the explorer, for one reason: an upload
 * outlives the thing that started it. Dropping a file on the left pane and then
 * navigating away, switching panes, or opening a modal must not cancel it, and
 * anything owned by a component that re-renders on navigation eventually will.
 *
 * The tray is deliberately not a toast. Toasts here dismiss themselves after
 * six seconds and cannot be updated in place, which is the opposite of both
 * things a progress row needs — to stay while the work does, and to change
 * while it is staying.
 *
 * A row is still one file. What changed in TRE-126 is underneath: several files
 * travel in one request, because the rate limit is spent per request and the
 * old one-per-file scheme refused everything past the thirtieth. So a row's
 * *bar* is the bar of the request it is riding in, and its *verdict* is its own,
 * read out of the `results[]` the route returns.
 */

export type UploadState = "sending" | "waiting" | "done" | "failed";

export interface UploadRow {
  id: number;
  /** The path under the destination — a bare name for a flat pick. */
  name: string;
  bytes: number;
  /** 0 to 1. Reported by the browser for the whole request, never estimated. */
  progress: number;
  state: UploadState;
  detail?: string;
  abort: () => void;
}

interface UploadContextValue {
  rows: readonly UploadRow[];
  /**
   * Send them. Returns once every file has settled, so a caller can refresh the
   * listing at the end rather than once per file.
   */
  start: (hostId: string, directory: string, files: readonly PickedFile[], conflict?: ConflictPolicy) => Promise<void>;
  dismiss: (id: number) => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

/** Rows kept on screen after they finish, so a completed batch is legible. */
const KEEP_FINISHED = 12;

/**
 * A file this size or larger travels alone.
 *
 * Not a performance number — a legibility one. Progress is reported per
 * request, so anything packed with others loses its own bar; a file big enough
 * that somebody is watching it is a file that keeps one.
 */
const ALONE_BYTES = 8 * 1024 * 1024;

/** Otherwise pack until one of these is met. Both are under the route's 200. */
const BATCH_FILES = 100;
const BATCH_BYTES = 32 * 1024 * 1024;

/** How many times one batch waits out the limit before giving up. */
const MAX_WAITS = 10;

/** And the longest single wait, so a wrong header cannot hang the tray. */
const MAX_WAIT_SECONDS = 120;

let nextId = 1;

export function UploadProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<readonly UploadRow[]>([]);
  const { csrfToken } = useAuth();
  const { push } = useToast();

  /**
   * One state write for a whole batch, never one per file in it.
   *
   * A hundred files in a request means a hundred rows moving together, and a
   * `setRows` each would be a hundred re-renders per progress event — on a
   * screen where TRE-114 already records that upload progress reaches every
   * mounted row. The two shapes below are the two things a batch does: move as
   * one, and settle individually.
   */
  const patchAll = (ids: readonly number[], change: Partial<UploadRow>) => {
    const targets = new Set(ids);
    setRows((current) => current.map((row) => (targets.has(row.id) ? { ...row, ...change } : row)));
  };

  const patchEach = (changes: ReadonlyMap<number, Partial<UploadRow>>) => {
    setRows((current) =>
      current.map((row) => {
        const change = changes.get(row.id);
        return change === undefined ? row : { ...row, ...change };
      }),
    );
  };

  /**
   * Finished rows are trimmed as new ones arrive, never the live ones.
   *
   * A folder adds hundreds at once, and a tray that kept every one of them
   * would be a scrollback rather than a status.
   */
  const add = (fresh: readonly UploadRow[]) => {
    setRows((current) => [
      ...current.filter((row) => row.state === "done" || row.state === "failed").slice(-KEEP_FINISHED),
      ...current.filter((row) => row.state === "sending" || row.state === "waiting"),
      ...fresh,
    ]);
  };

  const settle = (rows: ReadonlyArray<{ id: number; picked: PickedFile }>, result: UploadResult) => {
    // Paired on the path as sent, which the route echoes back in `requested`.
    const answers = new Map(result.results.map((outcome) => [outcome.requested, outcome]));

    const changes = new Map<number, Partial<UploadRow>>();

    for (const { id, picked } of rows) {
      const outcome = answers.get(picked.path);
      if (outcome === undefined) {
        changes.set(id, { state: "failed", detail: "The server did not answer for this file." });
      } else if (outcome.code === "ESKIPPED") {
        changes.set(id, { state: "done", progress: 1, detail: "already there" });
      } else if (!outcome.ok) {
        changes.set(id, { state: "failed", detail: outcome.message ?? "The host refused it." });
      } else {
        // The name, because it may not be the one that was sent: a conflict
        // answered with `keepBoth` lands as `report (2).txt`, and a tray that
        // did not say so would leave someone hunting for a file that is right
        // there under a name they never chose.
        changes.set(id, { state: "done", progress: 1, detail: outcome.name ?? undefined });
      }
    }

    patchEach(changes);
  };

  const start: UploadContextValue["start"] = async (hostId, directory, files, conflict = "keepBoth") => {
    if (files.length === 0) return;

    // Batch after batch, not all at once. Ten parallel requests share one
    // uplink and all finish at the same late moment; one at a time finishes the
    // first files first, which are the ones somebody is usually waiting for. It
    // also keeps one write stream open on the destination host rather than ten.
    for (const batch of pack(files)) {
      const members = batch.map((picked) => {
        const id = nextId++;
        return { id, picked };
      });
      const ids = members.map((member) => member.id);

      // Aborting any row aborts the request it is riding in, which is every row
      // of this batch. Said out loud in the detail below rather than left for
      // somebody to deduce from ninety-nine rows going red at once.
      let handle: { abort: () => void } = { abort: () => {} };
      // Set by the row's ×. The handle alone is not enough: a batch that is
      // *waiting* out the rate limit has no request to abort, and without this
      // it would go back and send itself after the cancel.
      let cancelled = false;
      const stop = () => {
        cancelled = true;
        handle.abort();
      };

      add(
        members.map(({ id, picked }) => ({
          id,
          name: picked.path,
          bytes: picked.file.size,
          progress: 0,
          state: "sending" as const,
          abort: stop,
        })),
      );

      let waits = 0;
      let sending = true;

      while (sending) {
        try {
          const started = uploadBatch(hostId, directory, batch, csrfToken, conflict, (fraction) => {
            patchAll(ids, { progress: fraction, state: "sending" });
          });
          handle = started;

          settle(members, await started.done);
          sending = false;
        } catch (error) {
          const waitable = error instanceof UploadRefusal && error.status === 429 && error.retryAfterSeconds !== null;

          if (waitable && waits < MAX_WAITS) {
            waits += 1;
            const seconds = Math.min((error as UploadRefusal).retryAfterSeconds ?? 0, MAX_WAIT_SECONDS);
            patchAll(ids, { state: "waiting", progress: 0, detail: `rate limit — resuming in ${seconds}s` });
            await sleep(seconds * 1000);
            if (!cancelled) continue;

            patchAll(ids, { state: "failed", detail: "Cancelled." });
            return;
          }

          const message = error instanceof ApiError ? error.message : "The upload did not complete.";
          const aborted = error instanceof ApiError && error.code === "EABORTED";
          patchAll(ids, { state: "failed", detail: aborted ? "Cancelled with its batch." : message });
          sending = false;

          if (aborted) return;

          // A 429 with no `Retry-After` is the hourly byte budget, and there is
          // nothing useful to wait for inside one sitting. Said once, loudly,
          // rather than repeated on every remaining row.
          if (error instanceof ApiError && error.status === 429) {
            push({ tone: "warning", message: "Upload limit reached", detail: message });
            return;
          }
        }
      }
    }
  };

  return (
    <UploadContext.Provider
      value={{ rows, start, dismiss: (id) => setRows((current) => current.filter((row) => row.id !== id)) }}
    >
      {children}
      <UploadTray />
    </UploadContext.Provider>
  );
}

/**
 * Files into requests.
 *
 * Two bounds and one exception: a large file goes on its own so it keeps its
 * bar, and everything else fills a request until it is a hundred files or
 * thirty-two megabytes. Five thousand small files become fifty requests, which
 * clears the thirty-a-minute limit with pacing to spare and writes fifty audit
 * rows for one folder instead of five thousand.
 */
function pack(files: readonly PickedFile[]): PickedFile[][] {
  const batches: PickedFile[][] = [];
  let current: PickedFile[] = [];
  let bytes = 0;

  const flush = () => {
    if (current.length === 0) return;
    batches.push(current);
    current = [];
    bytes = 0;
  };

  for (const picked of files) {
    if (picked.file.size >= ALONE_BYTES) {
      flush();
      batches.push([picked]);
      continue;
    }
    if (current.length >= BATCH_FILES || bytes + picked.file.size > BATCH_BYTES) flush();
    current.push(picked);
    bytes += picked.file.size;
  }

  flush();
  return batches;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useUploads(): UploadContextValue {
  const value = useContext(UploadContext);
  if (value === null) throw new Error("useUploads must be used inside an UploadProvider");
  return value;
}

/**
 * The tray, above the status bar and to the left of where toasts appear.
 *
 * Beside them rather than over them: a toast reports something that happened
 * and a tray row reports something happening, and stacking one on the other
 * would have finished uploads shove in-flight ones around the screen.
 */
function UploadTray() {
  const { rows, dismiss } = useUploads();
  if (rows.length === 0) return null;

  const sending = rows.filter((row) => row.state === "sending").length;
  // A batch waiting out the rate limit is still in flight as far as anyone
  // watching is concerned — it is going to send itself without being asked.
  const waiting = rows.filter((row) => row.state === "waiting").length;
  const live = sending + waiting;

  return (
    <section
      aria-label="Uploads"
      className="bg-app border-line-strong fixed bottom-[calc(var(--spacing-statusbar)+0.5rem)] left-3 z-50 flex w-76 flex-col rounded-sm border shadow-2xl"
    >
      <header className="border-line flex items-center gap-2 border-b px-2.5 py-1.5">
        <span className="text-ink-label font-mono text-2xs tracking-label">uploads</span>
        <span className="text-ink-faint font-mono text-2xs">
          {live === 0
            ? `${rows.length} finished`
            : waiting > 0
              ? `${live} queued, waiting on the limit`
              : `${sending} in flight`}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            for (const row of rows) {
              if (row.state === "sending" || row.state === "waiting") row.abort();
              dismiss(row.id);
            }
          }}
          className="text-ink-dim hover:text-ink font-mono text-2xs"
        >
          {live > 0 ? "cancel all" : "clear"}
        </button>
      </header>

      <div className="max-h-50 overflow-y-auto">
        {rows.map((row) => (
          <UploadTrayRow
            key={row.id}
            row={row}
            onDismiss={() => {
              if (row.state === "sending" || row.state === "waiting") row.abort();
              dismiss(row.id);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function UploadTrayRow({ row, onDismiss }: { row: UploadRow; onDismiss: () => void }) {
  const tone =
    row.state === "failed"
      ? "text-danger-soft"
      : row.state === "done"
        ? "text-success"
        : row.state === "waiting"
          ? "text-warning"
          : "text-ink-muted";

  return (
    <div className="border-raised flex flex-col gap-1 border-t px-2.5 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className={`min-w-0 flex-1 truncate font-mono text-xs/[1.3] ${tone}`}>{row.name}</span>
        <span className="text-ink-dim font-mono text-2xs/none">{formatSize(row.bytes, "file")}</span>
        <button
          type="button"
          aria-label={row.state === "sending" || row.state === "waiting" ? `Cancel ${row.name}` : `Dismiss ${row.name}`}
          onClick={onDismiss}
          className="text-ink-faint hover:text-ink font-mono text-2xs/none"
        >
          ×
        </button>
      </div>

      {/* The bar disappears once there is nothing left to report. A full bar
          sitting under a finished row is a progress indicator for a thing that
          is not in progress. */}
      {row.state === "sending" && (
        <div className="bg-chrome h-0.75 w-full overflow-hidden rounded-sm">
          <div
            className="bg-accent-soft h-full transition-[width] duration-150"
            style={{ width: `${Math.round(row.progress * 100)}%` }}
          />
        </div>
      )}

      {row.detail && <span className="text-ink-faint truncate font-mono text-2xs/none">{row.detail}</span>}
    </div>
  );
}
