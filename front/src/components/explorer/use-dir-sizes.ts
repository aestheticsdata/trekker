"use client";

import { dirSizesStreamUrl } from "@lib/api/fs";
import { useEffect, useState } from "react";

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
   */
  firstVisible: number;
}): DirSizes {
  const [sizes, setSizes] = useState<DirSizes>(NOTHING);

  useEffect(() => {
    if (hostId === null || !ready) {
      setSizes(NOTHING);
      return;
    }

    // A new directory knows nothing, and must not show the last one's figures
    // against rows that happen to share a name.
    setSizes({ known: new Map(), walking: true });

    const source = new EventSource(dirSizesStreamUrl(hostId, path, Math.max(0, firstVisible), VISIBLE_ROWS), {
      withCredentials: true,
    });

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      source.close();
    };

    const finish = (): void => {
      close();
      setSizes((current) => ({ ...current, walking: false }));
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

      setSizes((current) => {
        const known = new Map(current.known);
        known.set(frame.name, {
          bytes: typeof frame.bytes === "number" ? frame.bytes : null,
          partial: frame.partial === true,
          error: typeof frame.error === "string" ? frame.error : null,
        });
        return { ...current, known };
      });
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
  }, [hostId, path, ready, elevated, firstVisible]);

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
