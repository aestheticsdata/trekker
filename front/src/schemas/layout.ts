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
});

export const StoredLayoutSchema = z.strictObject({
  a: PaneLayoutSchema,
  b: PaneLayoutSchema,
  active: z.union([z.literal(0), z.literal(1)]),
  split: z.enum(SPLIT_MODES),
  view: z.enum(VIEW_MODES),
  heat: z.boolean(),
  insp: z.boolean(),
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
  const pane = ({ host, path, sort, dir }: StoredLayout["a"]) => ({ host, path, sort, dir });
  const { active, split, view, heat, insp, glob } = layout;
  return JSON.stringify({ a: pane(layout.a), b: pane(layout.b), active, split, view, heat, insp, glob });
}
