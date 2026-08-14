import { Injectable } from "@nestjs/common";

/**
 * Who is watching which transfers (TRE-23 §1).
 *
 * An in-process fan-out rather than Redis pub/sub, and the reason is the same
 * one that lets `TransferQueueService` hold its in-flight cap in a field: this
 * API runs as one process. A second one would need both — a shared queue and a
 * shared bus — and neither would be a small change, which is why the assumption
 * is stated here rather than discovered later.
 *
 * Scoped per user, not per job. A browser opens one stream for the session and
 * receives every job that account owns, so a transfer started in another tab
 * appears in this one — which is what makes the queue widget survive a reload
 * with no reconciliation beyond the list it already fetches.
 */

export type TransferStatus = "QUEUED" | "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED";

/** What the progress feed carries. Numbers, not rows: the rows are a GET away. */
export interface TransferProgress {
  id: string;
  status: TransferStatus;
  bytesTotal: number;
  bytesDone: number;
  itemsTotal: number;
  itemsDone: number;
  /** Bytes per second, measured over the last tick. Null before there is one. */
  rate: number | null;
  /** Seconds left at the current rate, or null when that cannot be said. */
  etaSeconds: number | null;
  /** Set when the job as a whole failed. Per-item failures are on the items. */
  error: string | null;
  /** How many items ended in `FAILED`, so a finished job can offer a retry. */
  failed: number;
}

type Listener = (progress: TransferProgress) => void;

@Injectable()
export class TransferEventsService {
  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * Watch one account's transfers. Returns the unsubscribe, which the SSE route
   * calls on `close` — a listener left behind after a browser tab is gone holds
   * a reference to a dead response and writes to it forever.
   */
  subscribe(userId: string, listener: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(userId, set);

    return () => {
      const current = this.listeners.get(userId);
      if (!current) return;
      current.delete(listener);
      // Emptied rather than left as an empty Set, so an account that has closed
      // every tab costs nothing at all.
      if (current.size === 0) this.listeners.delete(userId);
    };
  }

  /**
   * Never throws. A listener is a response socket that may have died between
   * the check and the write, and one broken stream must not stop the others
   * from being told — nor abandon a running transfer's own progress loop.
   */
  emit(userId: string, progress: TransferProgress): void {
    const set = this.listeners.get(userId);
    if (!set) return;

    for (const listener of set) {
      try {
        listener(progress);
      } catch {
        // The subscriber's problem, and it has already lost its stream.
      }
    }
  }

  /** Whether anybody is watching. Used only by tests and the health of nothing. */
  watchers(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}
