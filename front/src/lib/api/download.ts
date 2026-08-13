import { API_ORIGIN } from "@lib/api/client";

/**
 * Download (TRE-26), which is the one API call this app does not make.
 *
 * Everything else goes through `apiRequest`, and this deliberately does not:
 * that function parses every response as JSON and hands back the parsed value,
 * so a file would be read into memory, decoded as text, and thrown away. There
 * is no streaming escape hatch in it and there should not be one — a download
 * belongs to the browser, which already has a progress indicator, a Save-As
 * dialogue, a downloads list and a resume button that no page can match.
 *
 * So this builds a URL and lets the browser fetch it. The session cookie rides
 * along because it is `sameSite: "lax"` and this is a top-level GET, which is
 * the exact case Lax exists to permit. No CSRF token: a GET is exempt on both
 * sides, and an anchor could not set a header anyway.
 */

export function downloadUrl(hostId: string, path: string): string {
  // URLSearchParams, not template interpolation: a path may hold `&`, `#` or a
  // space, and each of those silently truncates or splits a hand-built query.
  const query = new URLSearchParams({ hostId, path });
  return `${API_ORIGIN}/api/fs/download?${query.toString()}`;
}

/**
 * Ask the browser for it.
 *
 * `target="_blank"` rather than navigating this tab, and that is the whole
 * design decision in this file. The response is `Content-Disposition:
 * attachment`, so on success the browser downloads it and closes the tab it
 * opened before anything is painted — the user sees their own download UI and
 * nothing else. On a refusal the API answers with JSON, and *that* is why the
 * new tab matters: the alternative is the app itself navigating away to an
 * error document, losing the explorer, the panes and the selection over a 403.
 *
 * Must be called synchronously from a user gesture, or the popup blocker takes
 * it. Every caller here is a click or a key handler.
 */
export function startDownload(hostId: string, path: string): void {
  const anchor = document.createElement("a");
  anchor.href = downloadUrl(hostId, path);
  anchor.target = "_blank";
  // Without this the opened tab gets a handle on `window.opener`. It is our own
  // origin in production, so nothing is being defended against today — but a
  // tab opened at a URL built from a path is not the place to rely on that.
  anchor.rel = "noopener noreferrer";

  // Appended, clicked, removed. Firefox ignores a click on an anchor that is
  // not in the document.
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
