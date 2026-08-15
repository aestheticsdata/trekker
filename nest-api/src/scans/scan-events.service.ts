import { Injectable } from "@nestjs/common";

/**
 * Who is watching which scans (TRE-32).
 *
 * The same in-process fan-out as `TransferEventsService`, and it makes the same
 * assumption for the same reason: this API runs as one process. A second one
 * would need a shared bus as well as a shared queue, and neither is a small
 * change — so the assumption is stated here rather than discovered later.
 *
 * Scoped per user rather than per scan or per host. A browser opens one stream
 * and receives every scan that account owns; the controller filters to the host
 * whose panel is open. Fanning out per user is what makes a scan started in
 * another tab appear in this one.
 */

export type ScanPhase = "probing" | "walking" | "hashing" | "saving";

/**
 * What the feed carries. Numbers, not rows — the rows are a GET away, and there
 * are up to twenty thousand of them.
 *
 * **No percentage and no ETA, deliberately.** `du` has no denominator: nothing
 * knows how many inodes a filesystem holds until the walk has finished counting
 * them. A progress bar here would be a number invented to fill a shape, and an
 * honest inode count that keeps climbing tells the reader more than a fake 40%
 * that stalls.
 */
export interface ScanProgress {
  id: string;
  hostId: string;
  root: string;
  status: "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  phase: ScanPhase;
  /** Inodes counted so far. */
  inodes: number;
  /** Bytes accounted for so far, as a string: this outgrows a double. */
  bytes: string;
  elapsedSeconds: number;
  /** Only during `hashing`, where there is something to measure against. */
  hashedBytes: string | null;
  error: string | null;
}

type Listener = (progress: ScanProgress) => void;

@Injectable()
export class ScanEventsService {
  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * Watch one account's scans. Returns the unsubscribe, which the SSE route
   * calls on `close` — a listener left behind holds a reference to a dead
   * response and writes to it forever.
   */
  subscribe(userId: string, listener: Listener): () => void {
    const set = this.listeners.get(userId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(userId, set);

    return () => {
      const current = this.listeners.get(userId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(userId);
    };
  }

  /**
   * Never throws. A listener is a response socket that may have died between
   * the check and the write, and one broken stream must not stop the others
   * being told — nor abandon a running scan's own progress loop.
   */
  emit(userId: string, progress: ScanProgress): void {
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

  /** Whether anybody is watching. Used by the specs. */
  watchers(userId: string): number {
    return this.listeners.get(userId)?.size ?? 0;
  }
}
