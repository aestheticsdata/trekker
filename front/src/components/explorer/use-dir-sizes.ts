"use client";

import { dirSizesStreamUrl } from "@lib/api/fs";
import { useEffect, useRef, useState } from "react";

import type { DirSizeFrame, FileRow } from "@lib/api/fs";

/**
 * What the directories in a listing actually contain (TRE-107).
 *
 * The listing cannot say. `readdir` reports a directory's own inode block —
 * 4096, whether it holds nothing or half a terabyte — so the API sends `null`
 * and the real total arrives here, one `du` at a time, over a stream this hook
 * owns and closes.
 *
 * Beside the component for the reason `use-tail.ts` gives: it is a connection
 * with a lifetime rather than a query. Unlike a tail it has one frame shape, so
 * the frames are bare `data:` like the scan feed's; what earns it a file is the
 * lifetime, because closing this stream is what stops the walks on the host.
 */

/** One directory's answer, or the absence of one. */
export interface DirSize {
  bytes: number | null;
  /** `du` was refused somewhere below: `bytes` is a floor, not the total. */
  partial: boolean;
  /** Why there is no figure. Null while the walk is still running. */
  error: string | null;
}

export interface DirSizes {
  /** Keyed by row name, as the pane keys everything else in a listing. */
  known: ReadonlyMap<string, DirSize>;
  /** False once the server has said the queue drained. */
  walking: boolean;
}

const NOTHING: DirSizes = { known: new Map(), walking: false };

export function useDirSizes({
  hostId,
  path,
  ready,
  elevated,
  firstVisible,
}: {
  hostId: string | null;
  path: string;
  /** False while the listing is still in flight — there is nothing to walk yet. */
  ready: boolean;
  /**
   * Whether this host has an open sudo window (TRE-111).
   *
   * Not passed to the server — it reads the window itself, and a client claiming
   * to be elevated would be a client deciding it. It is here so that *opening*
   * one restarts the walks: a figure measured as the login user is a floor, and
   * the point of opening the window is to stop it being one. Nothing restarts
   * when the window expires — what has already been measured stays measured.
   */
  elevated: boolean;
  /**
   * Which row to walk outwards from.
   *
   * The cursor's index, not the scroll offset, and deliberately: the explorer
   * already knows where the cursor is, whereas the offset lives behind a scroll
   * listener in the virtualiser, and lifting it up here would re-render this
   * component on every wheel event — undoing precisely what TRE-19 bought.
   *
   * Read once, when the stream opens, and never a reason to open another
   * (TRE-152). The cursor moves on every arrow key; a stream that followed it
   * killed and respawned every `du` on the host per keypress, spent the
   * account's `limit:dirsize` in seconds, and sent every figure on screen back
   * to the measuring ring.
   */
  firstVisible: number;
}): DirSizes {
  const [sizes, setSizes] = useState<DirSizes>(NOTHING);

  // How many sudo windows have opened while this pane was mounted — the
  // stream's dependency instead of `elevated` itself, which flips back to false
  // when a window expires and would restart the walk then too. Derived during
  // render, React's pattern for state that follows a prop, so the opening and
  // the restart land in one commit.
  const [windows, setWindows] = useState(0);
  const [wasElevated, setWasElevated] = useState(elevated);
  if (elevated !== wasElevated) {
    setWasElevated(elevated);
    if (elevated) setWindows(windows + 1);
  }

  // The latest cursor, for the stream to read when it opens. Written in its own
  // effect, declared before the stream's so a commit that both moves the cursor
  // and opens the stream opens it on the new one. `verify-dir-sizes.ts` counts
  // the opens, so the dependency cannot creep back.
  const seed = useRef(firstVisible);
  useEffect(() => {
    seed.current = firstVisible;
  }, [firstVisible]);

  useEffect(() => {
    if (hostId === null || !ready) {
      setSizes(NOTHING);
      return;
    }

    // A new directory knows nothing, and must not show the last one's figures
    // against rows that happen to share a name.
    setSizes({ known: new Map(), walking: true });

    const source = new EventSource(dirSizesStreamUrl(hostId, path, Math.max(0, seed.current), VISIBLE_ROWS), {
      withCredentials: true,
    });

    // Answers since the last flush, applied together (TRE-114). One state write
    // per frame was one Explorer render per directory measured — both panes'
    // rows, several times a second for as long as a big directory streams.
    let pending = new Map<string, DirSize>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    /** Takes what is buffered, so each answer is applied exactly once. */
    const take = (): ReadonlyMap<string, DirSize> => {
      const batch = pending;
      pending = new Map();
      return batch;
    };

    const flush = (): void => {
      flushTimer = null;
      const batch = take();
      setSizes((current) => ({ ...current, known: withAnswers(current.known, batch) }));
    };

    let closed = false;
    const close = (): void => {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      if (closed) return;
      closed = true;
      source.close();
    };

    // Whatever is still buffered lands with the end of the walk, in the same
    // write, so a finished walk is never missing its last few figures.
    const finish = (): void => {
      close();
      const batch = take();
      setSizes((current) => ({ known: withAnswers(current.known, batch), walking: false }));
    };

    source.onmessage = (event: MessageEvent<string>) => {
      if (typeof event.data !== "string") return;

      let frame: DirSizeFrame & { done?: boolean };
      try {
        frame = JSON.parse(event.data) as DirSizeFrame & { done?: boolean };
      } catch {
        // One unreadable frame is not a reason to tear down a stream that is
        // otherwise delivering. The next gets the same chance.
        return;
      }

      if (frame.done === true) {
        finish();
        return;
      }
      if (typeof frame.name !== "string") return;

      pending.set(frame.name, {
        bytes: typeof frame.bytes === "number" ? frame.bytes : null,
        partial: frame.partial === true,
        error: typeof frame.error === "string" ? frame.error : null,
      });
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    };

    // **Not a retry**, and this is the one thing about this stream that must
    // not be copied from the other three. `EventSource` has already scheduled a
    // reconnect by the time this runs, and letting it happen would restart
    // every `du` on the host from the beginning to re-send figures this pane
    // already has. The feed simply ends.
    source.onerror = finish;

    // The cleanup is the feature. Leaving the directory closes the response,
    // which kills the walks — without it, a held-down arrow key would leave a
    // `du` running per directory passed through.
    return close;
  }, [hostId, path, ready, windows]);

  return sizes;
}

/**
 * How many rows to name as "on screen".
 *
 * A hint about order rather than a bound: the server walks every directory in
 * the listing either way. Generous on purpose — a tall window on a short row
 * height shows more than a laptop does, and naming too many costs nothing while
 * naming too few leaves a visible row waiting behind an invisible one.
 */
const VISIBLE_ROWS = 60;

/**
 * How long answers wait to be applied together (TRE-114).
 *
 * Five Explorer renders a second at most, however many directories answer in
 * that time. Short enough that a figure appearing still reads as it arriving.
 */
const FLUSH_MS = 200;

/** What was known, with a batch of answers on top. */
function withAnswers(
  known: ReadonlyMap<string, DirSize>,
  batch: ReadonlyMap<string, DirSize>,
): ReadonlyMap<string, DirSize> {
  if (batch.size === 0) return known;
  const next = new Map(known);
  for (const [name, size] of batch) next.set(name, size);
  return next;
}

/**
 * The listing with what is known folded in.
 *
 * Applied before sorting, so a size that arrives sorts, totals and scales like
 * any other — a directory whose figure landed is not a special kind of row.
 * A directory `du` could not read stays `null` and keeps printing a dash: an
 * unreadable directory has no size, and zero would be a claim.
 */
export function withDirSizes(rows: readonly FileRow[], sizes: DirSizes): FileRow[] {
  if (sizes.known.size === 0) return rows as FileRow[];
  return rows.map((row) => {
    if (row.type !== "dir") return row;
    const known = sizes.known.get(row.name);
    return known === undefined || known.bytes === null ? row : { ...row, size: known.bytes };
  });
}
