import { apiRequest } from "@lib/api/client";

/**
 * Favourites (TRE-18 §3).
 *
 * A bookmark belongs to a host, not to the account, so the list arrives flat
 * and the sidebar groups it — `position` orders within one host and there is
 * no cross-host ordering to rely on.
 */

export interface BookmarkView {
  id: string;
  hostId: string;
  path: string;
  label: string;
  /** The small grey second line: an item count, a size, whatever is useful. */
  hint: string | null;
  position: number;
}

export interface BookmarkInput {
  hostId: string;
  path: string;
  label: string;
  hint?: string;
}

export async function fetchBookmarks(): Promise<BookmarkView[]> {
  return (await apiRequest("/bookmarks")) as BookmarkView[];
}

export async function createBookmark(input: BookmarkInput, csrfToken: string | null): Promise<BookmarkView> {
  return (await apiRequest("/bookmarks", { method: "POST", body: input, csrfToken })) as BookmarkView;
}

export async function updateBookmark(
  id: string,
  input: { label?: string; hint?: string; position?: number },
  csrfToken: string | null,
): Promise<BookmarkView> {
  return (await apiRequest(`/bookmarks/${id}`, { method: "PATCH", body: input, csrfToken })) as BookmarkView;
}

export async function deleteBookmark(id: string, csrfToken: string | null): Promise<void> {
  await apiRequest(`/bookmarks/${id}`, { method: "DELETE", csrfToken });
}

/** The host's whole list in its new order — the server refuses a partial one. */
export async function reorderBookmarks(
  hostId: string,
  ids: readonly string[],
  csrfToken: string | null,
): Promise<BookmarkView[]> {
  return (await apiRequest("/bookmarks/reorder", {
    method: "PATCH",
    body: { hostId, ids },
    csrfToken,
  })) as BookmarkView[];
}
