import { SORT_KEYS, SPLIT_MODES, VIEW_MODES } from "@lib/url/explorer-params";
import { z } from "zod";

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
