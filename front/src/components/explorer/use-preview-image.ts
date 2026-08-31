"use client";

import { recallPreview, rememberPreview } from "@components/explorer/preview-cache";
import { formatTotal } from "@helpers/listing";
import { fetchPreview, imageMime } from "@lib/api/preview";
import { useEffect, useState } from "react";

import type { FileRow } from "@lib/api/fs";
import type { PreviewFetch } from "@lib/api/preview";

/**
 * The bytes behind the inspector's preview box (TRE-138), as a state the box
 * can draw: an object URL once an image has arrived, a note where the server
 * refused for a reason worth naming, and neither while there is nothing to
 * show — which is also every unnamed failure, because the hatched caption is
 * this feature's error state and a broken-image glyph is nobody's.
 *
 * Selection outruns the network, so the rules here are about time. Nothing is
 * asked for until the cursor has rested on a row for a beat: an abort cannot
 * un-send a request, so a held arrow key that fired one fetch per repeat would
 * spend the server's preview budget on rows nobody looked at and then be
 * refused on the row they wanted — the settle timer is what makes a pass over
 * three hundred photographs cost zero instead of three hundred. A cached image
 * skips the wait; it costs nothing to show. One `AbortController` per
 * selection cancels the fetch in flight when the cursor moves on anyway, the
 * state carries the key it answers so an old image can never paint over a new
 * selection, and a timeout aborts the same way a move does, so a dead host
 * degrades to the stub instead of a spinner that never ends.
 */

/** Longer than a key repeat, invisible next to the fetch it gates. */
const SETTLE_MS = 200;

const TIMEOUT_MS = 15_000;

export interface PreviewImage {
  /** Object URL to draw, or null while there is nothing to draw. */
  url: string | null;
  /** Replaces the caption when the refusal is worth naming. */
  note: string | null;
}

const NOTHING: PreviewImage = { url: null, note: null };

/**
 * What a refusal says in the box. Both figures of the pair carry units, and a
 * refusal with nothing worth naming says nothing — the caption is the answer.
 */
function refusalNote(result: Extract<PreviewFetch, { kind: "refused" }>): string | null {
  if (result.code === "EPREVIEWTOOBIG" && result.size !== null && result.ceiling !== null) {
    return `${formatTotal(result.size)} · preview limit ${formatTotal(result.ceiling)}`;
  }
  if (result.status === 429) return "too many previews · try again shortly";
  return null;
}

export function usePreviewImage(hostId: string, path: string, row: FileRow): PreviewImage {
  const mime = row.type === "file" ? imageMime(row.extension) : null;
  // mtime and size are in the key so a file changed in place refetches instead
  // of recalling the stale bytes.
  const key = `${hostId}\n${path}\n${row.mtime}\n${row.size ?? 0}`;

  const [state, setState] = useState<(PreviewImage & { key: string }) | null>(null);

  useEffect(() => {
    if (mime === null) return;

    const cached = recallPreview(key);
    if (cached !== null) {
      setState({ key, url: cached, note: null });
      return;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const settle = setTimeout(() => {
      timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      fetchPreview(hostId, path, mime, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.kind === "image") {
            const url = URL.createObjectURL(result.blob);
            rememberPreview(key, url, result.blob.size);
            setState({ key, url, note: null });
            return;
          }
          setState({ key, url: null, note: refusalNote(result) });
        })
        .catch(() => {
          // An abort lands here too, and is not a result: the effect that
          // aborted has already cleaned up, and this closure's key is stale.
          if (!controller.signal.aborted) setState({ key, url: null, note: null });
        })
        .finally(() => clearTimeout(timeout));
    }, SETTLE_MS);

    return () => {
      clearTimeout(settle);
      clearTimeout(timeout);
      controller.abort();
    };
  }, [key, mime, hostId, path]);

  if (state === null || state.key !== key) return NOTHING;
  return state;
}
