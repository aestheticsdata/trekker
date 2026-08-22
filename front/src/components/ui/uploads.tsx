"use client";

import { useAuth } from "@auth/context/AuthContext";
import { useToast } from "@components/ui/toast";
import { formatSize } from "@helpers/listing";
import { ApiError } from "@lib/api/client";
import { uploadFile } from "@lib/api/upload";
import { createContext, useContext, useState } from "react";

import type { ConflictPolicy } from "@lib/api/upload";
import type { ReactNode } from "react";

/**
 * Uploads in flight, and the tray that shows them (TRE-65).
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
 */

export type UploadState = "sending" | "done" | "failed";

export interface UploadRow {
  id: number;
  name: string;
  bytes: number;
  /** 0 to 1. Reported by the browser, never estimated here. */
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
  start: (hostId: string, directory: string, files: readonly File[], conflict?: ConflictPolicy) => Promise<void>;
  dismiss: (id: number) => void;
}

const UploadContext = createContext<UploadContextValue | null>(null);

/** Rows kept on screen after they finish, so a completed batch is legible. */
const KEEP_FINISHED = 12;

let nextId = 1;

export function UploadProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<readonly UploadRow[]>([]);
  const { csrfToken } = useAuth();
  const { push } = useToast();

  const patch = (id: number, change: Partial<UploadRow>) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...change } : row)));
  };

  const start: UploadContextValue["start"] = async (hostId, directory, files, conflict = "keepBoth") => {
    if (files.length === 0) return;

    // Sequential, not concurrent. Ten parallel uploads share one uplink and all
    // finish at the same late moment; one at a time finishes the first file
    // first, which is the one somebody is usually waiting for. It also keeps
    // one write stream open on the destination host rather than ten.
    for (const file of files) {
      const id = nextId++;
      let handle: { abort: () => void } = { abort: () => {} };

      const row: UploadRow = {
        id,
        name: file.name,
        bytes: file.size,
        progress: 0,
        state: "sending",
        abort: () => handle.abort(),
      };
      setRows((current) => [...current.slice(-KEEP_FINISHED), row]);

      try {
        const started = uploadFile(hostId, directory, file, csrfToken, conflict, (fraction) =>
          patch(id, { progress: fraction }),
        );
        handle = started;

        const result = await started.done;
        const outcome = result.results[0];

        if (outcome?.code === "ESKIPPED") {
          patch(id, { state: "done", progress: 1, detail: "already there" });
        } else if (outcome && !outcome.ok) {
          patch(id, { state: "failed", detail: outcome.message ?? "The host refused it." });
        } else {
          // The name, because it may not be the one that was sent: a conflict
          // answered with `keepBoth` lands as `report (2).txt`, and a tray that
          // did not say so would leave someone hunting for a file that is right
          // there under a name they never chose.
          patch(id, { state: "done", progress: 1, detail: outcome?.name ?? undefined });
        }
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "The upload did not complete.";
        patch(id, { state: "failed", detail: message });
        // A refusal that applies to the whole batch — the rate limit, the byte
        // budget — is worth saying once, loudly, rather than repeating it on
        // nine more rows nobody reads.
        if (error instanceof ApiError && error.status === 429) {
          push({ tone: "warning", message: "Upload limit reached", detail: message });
          return;
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

  return (
    <section
      aria-label="Uploads"
      className="bg-app border-line-strong fixed bottom-[calc(var(--spacing-statusbar)+0.5rem)] left-3 z-50 flex w-76 flex-col rounded-sm border shadow-2xl"
    >
      <header className="border-line flex items-center gap-2 border-b px-2.5 py-1.5">
        <span className="text-ink-label font-mono text-2xs tracking-label">uploads</span>
        <span className="text-ink-faint font-mono text-2xs">
          {sending > 0 ? `${sending} in flight` : `${rows.length} finished`}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            for (const row of rows) {
              if (row.state === "sending") row.abort();
              dismiss(row.id);
            }
          }}
          className="text-ink-dim hover:text-ink font-mono text-2xs"
        >
          {sending > 0 ? "cancel all" : "clear"}
        </button>
      </header>

      <div className="max-h-50 overflow-y-auto">
        {rows.map((row) => (
          <UploadTrayRow
            key={row.id}
            row={row}
            onDismiss={() => {
              if (row.state === "sending") row.abort();
              dismiss(row.id);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function UploadTrayRow({ row, onDismiss }: { row: UploadRow; onDismiss: () => void }) {
  const tone = row.state === "failed" ? "text-danger-soft" : row.state === "done" ? "text-success" : "text-ink-muted";

  return (
    <div className="border-raised flex flex-col gap-1 border-t px-2.5 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className={`min-w-0 flex-1 truncate font-mono text-xs/[1.3] ${tone}`}>{row.name}</span>
        <span className="text-ink-dim font-mono text-2xs/none">{formatSize(row.bytes, "file")}</span>
        <button
          type="button"
          aria-label={row.state === "sending" ? `Cancel ${row.name}` : `Dismiss ${row.name}`}
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
