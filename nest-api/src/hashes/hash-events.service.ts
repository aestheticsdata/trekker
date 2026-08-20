import { Injectable } from "@nestjs/common";

/**
 * Who is watching which checksum jobs (TRE-27 §2).
 *
 * The same in-process fan-out as `ScanEventsService` and `TransferEventsService`,
 * and it makes the same assumption for the same reason: this API runs as one
 * process. A second one would need a shared bus as well as a shared queue, and
 * neither is a small change — so the assumption is stated here rather than
 * discovered later.
 *
 * Scoped per user rather than per job or per host. A browser opens one stream
 * and receives every job that account owns; the inspector filters to the job it
 * is watching. Fanning out per user is what makes a job started from the
 * context menu in one pane appear in the other one's panel.
 */

export type HashStatus = "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/** How the bytes were read. Mirrors the `HashMethod` enum in the schema. */
export type HashMethod = "REMOTE" | "STREAMED";

/**
 * What the feed carries.
 *
 * **`bytesDone` advances per file, not per byte, whenever the host is doing the
 * hashing.** `sha256sum` says nothing while it reads and prints one line when
 * it is finished, so the only honest resolution available for a remote job is
 * whole files. The streamed fallback does know its position and reports it, and
 * `method` is on every frame so a reader can tell which kind of progress it is
 * looking at rather than wondering why the bar moves in steps.
 *
 * `path` is the file being read right now, which is the part somebody actually
 * watches on a job of four thousand files.
 */
export interface HashProgress {
  id: string;
  hostId: string;
  status: HashStatus;
  /** Null until the first file starts, and on every terminal frame. */
  path: string | null;
  method: HashMethod | null;
  files: number;
  filesDone: number;
  /** Files the cache already held, counted in `filesDone` and never read. */
  filesCached: number;
  /** Files that could not be hashed. The job carries on past each one. */
  filesFailed: number;
  /** Strings: a job may be tens of gigabytes and this outgrows a double. */
  bytesTotal: string;
  bytesDone: string;
  elapsedSeconds: number;
  error: string | null;
}

type Listener = (progress: HashProgress) => void;

@Injectable()
export class HashEventsService {
  private readonly listeners = new Map<string, Set<Listener>>();

  /**
   * Watch one account's jobs. Returns the unsubscribe, which the SSE route
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
   * being told — nor abandon a running job's own progress loop.
   */
  emit(userId: string, progress: HashProgress): void {
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
