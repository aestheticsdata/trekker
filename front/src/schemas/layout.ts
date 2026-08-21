import { isViewSlot } from "@helpers/keys";
import { SORT_KEYS, SPLIT_MODES, VIEW_MODES } from "@lib/url/explorer-params";
import { z } from "zod";

import type { ViewSlot } from "@helpers/keys";

/**
 * The stored layout (TRE-51), on its way back out of the database.
 *
 * The API validates what goes in, and this validates what comes out anyway.
 * Not belt and braces: the column is Json and its shape belongs to this file,
 * so a layout written by an older build is the normal case the moment these
 * keys ever change. Parsing here is what turns that into a cold open on the
 * defaults instead of an explorer holding values nothing downstream expects.
 *
 * Strict, unlike `AuthUserSchema`. That one is loose so a field added
 * server-side cannot break sign-in; this one is the front's own shape coming
 * home, and an unknown key in it means the writer and the reader disagree.
 */

const PaneLayoutSchema = z.object({
  host: z
    .string()
    .regex(/^[0-9a-f-]{36}$/i)
    .nullable(),
  path: z.string().min(1).max(700).startsWith("/"),
  sort: z.enum(SORT_KEYS),
  dir: z.union([z.literal(1), z.literal(-1)]),
  /**
   * The file this pane's live tail is following (TRE-34), or null for none.
   *
   * The only field here with a default, and it is the *added* field: a layout
   * stored before this key existed has no `tail`, and under a strict object a
   * missing key is a parse failure — so every account in the install would have
   * taken one cold open on the day this shipped, losing the position it had.
   * Defaulting says the honest thing instead, which is that a layout written
   * without a tail was a layout following nothing.
   *
   * A default belongs on a key being introduced, and only while layouts written
   * before it still exist. It is not a licence to soften the schema generally —
   * an *unknown* key still fails, because that means the writer and the reader
   * disagree rather than that one of them is older.
   */
  tail: z.string().min(1).max(700).startsWith("/").nullable().default(null),
});

export const StoredLayoutSchema = z.strictObject({
  a: PaneLayoutSchema,
  b: PaneLayoutSchema,
  active: z.union([z.literal(0), z.literal(1)]),
  split: z.enum(SPLIT_MODES),
  view: z.enum(VIEW_MODES),
  heat: z.boolean(),
  insp: z.boolean(),
  du: z.boolean(),
  /** Null is "follow the active pane", which is where the strip starts. */
  duRoot: z.string().min(1).max(700).startsWith("/").nullable(),
  glob: z.string().max(200),
});

export type StoredLayout = z.infer<typeof StoredLayoutSchema>;

/**
 * One layout, one string, whatever order the keys arrived in.
 *
 * `JSON.stringify` preserves insertion order, and the two layouts being
 * compared are built differently: the restored one comes out of the schema
 * above (a, b first), the live one is assembled from the URL state (a and b
 * appended last). Stringifying them directly makes two identical layouts
 * compare unequal, which costs a pointless write back of the layout that was
 * just read.
 */
export function serialiseLayout(layout: StoredLayout): string {
  const pane = ({ host, path, sort, dir, tail }: StoredLayout["a"]) => ({ host, path, sort, dir, tail });
  const { active, split, view, heat, insp, du, duRoot, glob } = layout;
  return JSON.stringify({ a: pane(layout.a), b: pane(layout.b), active, split, view, heat, insp, du, duRoot, glob });
}

/**
 * What a *saved view* remembers (TRE-37 §1) — a strict subset of the above.
 *
 * The subset is the design, and it is what makes the dirty dot honest. A view
 * is two directories and how they are arranged. It is deliberately not where
 * the keyboard was (`active`), which file a pane was tailing (`tail`), whether
 * the disk-usage strip was open (`du`, `duRoot`), or which of the two listing
 * densities was showing (`view`). Every one of those changes while somebody is
 * simply reading, and the dot compares exactly these fields — a dot that
 * appeared because the cursor moved to the other pane is the noise the ticket
 * asks for none of.
 *
 * `split` carries what the mockup called `solo`: `left` and `right` *are* one
 * pane full width. One three-valued field rather than a mode and a boolean,
 * because two fields saying the same thing is two fields that can disagree.
 */
// Strict, like the object below it and unlike `PaneLayoutSchema` above: this
// one has no key that was ever added later, and the whole reason the top level
// is strict is that an unknown key means the writer and the reader disagree.
// The API strips what it does not declare (`whitelist: true`), so a pane
// arriving with a `tail` on it did not come from this app's own endpoint.
const ViewPaneSchema = z.strictObject({
  host: z
    .string()
    .regex(/^[0-9a-f-]{36}$/i)
    .nullable(),
  path: z.string().min(1).max(700).startsWith("/"),
  sort: z.enum(SORT_KEYS),
  dir: z.union([z.literal(1), z.literal(-1)]),
});

export const ViewLayoutSchema = z.strictObject({
  a: ViewPaneSchema,
  b: ViewPaneSchema,
  split: z.enum(SPLIT_MODES),
  insp: z.boolean(),
  heat: z.boolean(),
  glob: z.string().max(200),
});

export type ViewLayout = z.infer<typeof ViewLayoutSchema>;
export type ViewPane = z.infer<typeof ViewPaneSchema>;

/**
 * One saved view, as the API sends it.
 *
 * `slot` is a digit, never `"⌥3"`: how a chord is spelled belongs to
 * `helpers/keys.ts` and to nothing else (TRE-36 §2), so moving a glyph there
 * cannot require a migration or a re-read of every stored row.
 *
 * `hostLabels` is a memo — host id to the label that host had when the view was
 * saved — and it exists for one sentence. A view whose host has been deleted
 * has to be able to name the machine that is gone, and the id alone cannot,
 * because the row it names is the row that no longer exists. It is never
 * compared: renaming a host must not make a view look unsaved.
 */
export const SavedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slot: z.custom<ViewSlot>(isViewSlot).nullable(),
  layout: ViewLayoutSchema,
  hostLabels: z.record(z.string(), z.string()).default({}),
});

export type SavedView = z.infer<typeof SavedViewSchema>;
