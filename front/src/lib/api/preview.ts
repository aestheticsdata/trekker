import { API_ORIGIN } from "@lib/api/client";

/**
 * The inspector's image preview (TRE-138) — fetching the bytes of one file to
 * draw them, over `/fs/preview` rather than `/fs/download`, because the two
 * routes are different claims: a download is recorded and rationed as a copy
 * of somebody's data leaving the fleet, and a selection is neither.
 *
 * Not `apiRequest`, for the download's reason: that function parses JSON, and
 * these bytes want to stay bytes. Not an `<img src>` either — the route
 * answers `application/octet-stream` under `nosniff` on purpose (see
 * `nest-api/src/fs/download-headers.ts`), so the browser will not sniff an
 * image out of it. The bytes are fetched, typed here, and handed to the tag as
 * a blob URL.
 */

/**
 * What this box will ask for, and the type the blob is stamped with.
 *
 * Deliberately not `typeLetters(…) === "IMG"`: that group is a badge — a set
 * chosen for what to letter, not for what a browser can draw — and it would
 * promise a preview for formats that render as nothing. This list is the
 * browser's, and the server is never asked about anything off it.
 *
 * **`svg` is missing on purpose, and must stay missing.** Every type here is
 * inert as a document; `image/svg+xml` is the one image type that is not. The
 * `<img>` itself would be safe — scripts do not run in an image load — but a
 * blob URL shares this app's origin and outlives the tag: right-click, "open
 * image in new tab", and the same URL is now a *navigation*, where an SVG's
 * script runs with the session's cookies. A host is exactly the place a
 * hostile file comes from, and "a file this application serves cannot execute
 * on this application's origin" is the property `download-headers.ts` spends
 * its whole length defending. An SVG keeps the hatched caption.
 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
};

/** The MIME type a preview of this extension would carry, or null: no preview. */
export function imageMime(extension: string): string | null {
  // hasOwn, not `in`, for typeLetters' reason: `x.constructor` is a filename.
  return Object.hasOwn(IMAGE_MIME, extension) ? IMAGE_MIME[extension] : null;
}

export type PreviewFetch =
  | { kind: "image"; blob: Blob }
  | { kind: "refused"; status: number; code: string | undefined; size: number | null; ceiling: number | null };

/**
 * The bytes, typed by the extension rather than by the response.
 *
 * The response's type is opaque on purpose, so trusting it would draw nothing;
 * trusting the extension is safe because the blob only ever reaches an
 * `<img>`, where a `.png` full of markup is not an image and simply fails to
 * decode. A refusal comes back as a value, not a throw — the box has captions
 * for "too big" and "too many" that a thrown string would flatten — carrying
 * the figures the server sent so the box can name them.
 */
export async function fetchPreview(
  hostId: string,
  path: string,
  mime: string,
  signal: AbortSignal,
): Promise<PreviewFetch> {
  const query = new URLSearchParams({ hostId, path });
  const response = await fetch(`${API_ORIGIN}/api/fs/preview?${query.toString()}`, {
    credentials: "include",
    signal,
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const refusal = (body ?? {}) as { code?: string; size?: number; ceiling?: number };
    return {
      kind: "refused",
      status: response.status,
      code: refusal.code,
      size: typeof refusal.size === "number" ? refusal.size : null,
      ceiling: typeof refusal.ceiling === "number" ? refusal.ceiling : null,
    };
  }

  const bytes = await response.blob();
  return { kind: "image", blob: new Blob([bytes], { type: mime }) };
}
