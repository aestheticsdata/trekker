import { apiRequest } from "@lib/api/client";
import { SavedViewSchema } from "@schemas/layout";

import type { ViewSlot } from "@helpers/keys";
import type { SavedView, ViewLayout } from "@schemas/layout";

/**
 * Saved views (TRE-37).
 *
 * The list is parsed on the way in, row by row, for the reason
 * `StoredLayoutSchema` exists one ticket over: the column is Json, its shape
 * belongs to the front, and a row written by an older build is the normal case
 * the moment these keys ever change.
 *
 * Row by row rather than as an array, and that is deliberate. A single
 * unreadable view must not take the other five with it — but it must not
 * vanish silently either, because a named thing disappearing is indistinguishable
 * from a bug. So the count comes back beside the list and the sidebar says so.
 */

export interface ViewList {
  views: readonly SavedView[];
  /** Rows this build cannot read. Zero in every ordinary case. */
  unreadable: number;
}

/** What a write moved out of the way to give this view its shortcut. */
export interface Displaced {
  id: string;
  name: string;
}

export interface ViewWrite {
  view: SavedView;
  displaced: Displaced | null;
}

export interface ViewInput {
  name: string;
  slot: ViewSlot | null;
  layout: ViewLayout;
  /** Host id to label, as they read right now — a memo for the day one is deleted. */
  hostLabels: Record<string, string>;
}

export async function fetchViews(): Promise<ViewList> {
  const rows = (await apiRequest("/views")) as unknown[];
  const views: SavedView[] = [];
  let unreadable = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const parsed = SavedViewSchema.safeParse(row);
    if (parsed.success) views.push(parsed.data);
    else unreadable += 1;
  }

  return { views, unreadable };
}

export async function createView(input: ViewInput, csrfToken: string | null): Promise<ViewWrite> {
  return parseWrite(await apiRequest("/views", { method: "POST", body: input, csrfToken }));
}

/**
 * A partial update: rename, re-key, or overwrite the layout.
 *
 * `slot: null` clears the chord and is not the same as leaving `slot` out —
 * that difference is the whole of the picker's `none` button, and it survives
 * the trip because `JSON.stringify` keeps an explicit null and drops only
 * `undefined`.
 */
export async function updateView(id: string, input: Partial<ViewInput>, csrfToken: string | null): Promise<ViewWrite> {
  return parseWrite(await apiRequest(`/views/${id}`, { method: "PATCH", body: input, csrfToken }));
}

export async function deleteView(id: string, csrfToken: string | null): Promise<void> {
  await apiRequest(`/views/${id}`, { method: "DELETE", csrfToken });
}

/**
 * The envelope, parsed.
 *
 * Thrown rather than degraded, unlike the list: a write whose answer this build
 * cannot read is a write whose result nobody can act on, and the caller has a
 * toast to put the failure in.
 */
function parseWrite(payload: unknown): ViewWrite {
  const body = payload as { view?: unknown; displaced?: Displaced | null };
  return { view: SavedViewSchema.parse(body?.view), displaced: body?.displaced ?? null };
}
