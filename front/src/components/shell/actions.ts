import { hintFor } from "@helpers/keys";

import type { RowType } from "@lib/api/fs";

/**
 * Every operation this app performs, declared once (TRE-70 §4).
 *
 * Three surfaces render from this file — the toolbar's action row, the
 * listing's context menu and TRE-36's ⌘K palette — and none of them decides
 * anything. What exists, what each entry is called, which shape carries it and
 * what it needs in order to run are all here; a surface picks a shape and draws
 * what comes back.
 *
 * That matters because availability used to be written twice: string literals
 * in the toolbar's own list, and a map of handlers in `page.tsx` that quietly
 * meant "and this one is enabled now". With one surface that is merely
 * duplicated. With three it is the thing that drifts — an action enabled in the
 * menu and dead in the palette for the same selection, found by whoever tries
 * the other route, months later.
 *
 * Free of React, and its one value import is `helpers/keys.ts`, which imports
 * nothing itself — so `scripts/verify-menu.ts` can still put the whole table
 * through node, with the alias hook that script now carries.
 */

export type ActionId =
  | "newDir"
  | "newFile"
  | "open"
  | "openOther"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "copyTo"
  | "moveTo"
  | "refresh"
  | "rename"
  | "chmod"
  | "download"
  | "tail"
  | "upload"
  | "link"
  | "copyPath"
  | "copyName"
  | "favourite"
  | "compare"
  | "hash"
  | "rm";

/** What a surface is aimed at: the selected entries, or the pane's directory. */
export type TargetKind = "entries" | "directory";

export type Surface = "toolbar" | "menu" | "palette";

/**
 * Everything a rule may turn on.
 *
 * `entries` carries kinds rather than rows because no rule has ever needed a
 * name, and a list of four short strings is something a parent can compare
 * cheaply enough to pass this object upward without re-rendering for ever.
 */
export interface ActionContext {
  kind: TargetKind;
  /** The entries the action would run on. Empty when the target is a directory. */
  entries: readonly RowType[];
  /** The pane's host, or null when nothing is bound to it. */
  hostId: string | null;
  /** The other pane's host, or null. What F5 and F6 need somewhere to land. */
  otherHostId: string | null;
  /** Whether the clipboard is holding anything (TRE-71). */
  holding: boolean;
}

/**
 * The least a row has to be for `ContextMenu` to draw it.
 *
 * `Action` is the only thing in *this* file that satisfies it, and that is the
 * point of separating them: TRE-37's views menu — restore, update, rename,
 * duplicate, delete — is a menu over a saved view rather than over a selection,
 * so it has no place in this registry and no `ActionId` to be keyed by. It
 * still wants the same panel, the same keyboard, the same disabled treatment.
 * A menu that draws one kind of row and a second menu written for the other is
 * two menus that drift.
 */
export interface MenuEntry {
  id: string;
  label: string;
  /** The key that reaches this, where one does. */
  hint?: string;
  /** Absent means enabled. Present means disabled, and this is the sentence. */
  unavailableReason?: string;
  danger?: boolean;
}

/** A row of any menu: an entry, or the rule between two blocks of them. */
export type MenuRow = MenuEntry | { rule: true };

/** One rendered entry. The shape the toolbar's button has always taken. */
export interface Action extends MenuEntry {
  id: ActionId;
  label: string;
  /**
   * The key that reaches this, from `helpers/keys.ts` and from nowhere else
   * (TRE-36 §2) — "F5", "⌦", "⌘X". Absent when no chord does.
   *
   * It used to be written here, as a literal beside the label, and two of them
   * were not keys at all: `compare` carried `⇄` and `upload` carried `↑`, which
   * is a glyph and an arrow key respectively. Those are `mark` now, and the
   * distinction is the point — one of these is a thing to press.
   */
  hint?: string;
  /**
   * The mockup's decorative glyph, where 2a draws one beside the label: `⇄` on
   * `compare`, `↑` on `upload`. Not a key, and never advertised as one.
   */
  mark?: string;
  /** The palette's second line: what the operation does, in a few words. */
  note?: string;
  /** Absent means enabled. Present means disabled, and this is the sentence. */
  unavailableReason?: string;
  danger?: boolean;
  onSelect?: () => void;
}

/** A row of a surface: an action, or the rule between two blocks of them. */
export type ActionRow = Action | { rule: true };

/** Narrows either kind of row, so one menu component serves both. */
export function isRule(row: MenuRow): row is { rule: true } {
  return "rule" in row;
}

// ---------------------------------------------------------------- the rules

const NO_HOST = "Bind a host to this pane first";
const NOTHING = "Select an entry, or put the cursor on one";

type Rule = (context: ActionContext) => string | undefined;

/** The first reason that applies, or undefined when none does. */
function all(...rules: readonly Rule[]): Rule {
  return (context) => {
    for (const rule of rules) {
      const why = rule(context);
      if (why !== undefined) return why;
    }
    return undefined;
  };
}

const host: Rule = (context) => (context.hostId === null ? NO_HOST : undefined);
const some: Rule = (context) => (context.entries.length === 0 ? NOTHING : undefined);
const one: Rule = (context) =>
  context.entries.length === 0 ? NOTHING : context.entries.length > 1 ? "This takes one entry at a time" : undefined;
const otherPane: Rule = (context) =>
  context.otherHostId === null ? "The other pane has no host to send these to" : undefined;
/**
 * Both panes bound, for an action that reads both rather than sending anything
 * one way. `otherPane` above says "to send these to", which is the wrong
 * sentence for a comparison and would be the wrong sentence to read in a
 * tooltip explaining why `compare` is grey.
 */
const bothPanes: Rule = (context) =>
  context.otherHostId === null ? "The other pane has no host to compare against" : undefined;

/** Exactly one entry, of one of these kinds. */
function onlyKind(kinds: readonly RowType[], why: string): Rule {
  return (context) => (context.entries.every((kind) => kinds.includes(kind)) ? undefined : why);
}

// ------------------------------------------------------------- the registry

interface Spec {
  label: string;
  /** The toolbar's shorter word, where the width of that row forced one. */
  short?: string;
  /** 2a's glyph beside the label. See `Action.mark` — this is not a shortcut. */
  mark?: string;
  /** One line on what it does, for the palette. Never why it is unavailable. */
  note?: string;
  danger?: boolean;
  why?: Rule;
}

/**
 * What each operation is called and what it needs.
 *
 * The two labels are not decoration. `copy` in the toolbar and `copy to other
 * pane` in the menu are the same action, and the menu has to say where the
 * bytes are going because the clipboard's `copy` is sitting four rows above it
 * — the moment either is called plain `copy` in the same list, one of them is
 * lying.
 */
const SPECS: Readonly<Record<ActionId, Spec>> = {
  // F7, not the ⇧⌘N the design spec first drew (settled by TRE-69): Chrome and
  // Firefox both take ⇧⌘N for a private window before the page sees the key, so
  // a menu advertising it would teach a shortcut that never fires.
  newDir: { label: "new directory", short: "new", note: "a directory, here", why: host },
  newFile: { label: "new file", note: "an empty file, here", why: host },

  open: { label: "open", why: all(host, one) },
  // No `otherPane` rule, unlike F5 and F6: this does not send anything to the
  // other pane, it points that pane at a directory on *this* host — so a pane
  // with nothing bound to it is a pane about to have something bound to it.
  openOther: {
    label: "open in other pane",
    why: all(host, one, onlyKind(["dir", "link"], "Only a directory can be opened in the other pane")),
  },

  cut: { label: "cut", note: "hold the selection, to move it", why: all(host, some) },
  copy: { label: "copy", note: "hold the selection, to duplicate it", why: all(host, some) },
  paste: {
    label: "paste",
    note: "put down what the clipboard is holding",
    why: all(host, (context) => (context.holding ? undefined : "Nothing on the clipboard")),
  },
  duplicate: { label: "duplicate", note: "a copy beside the original, under a free name", why: all(host, some) },
  copyTo: {
    label: "copy to other pane",
    short: "copy",
    note: "with each conflict decided per entry",
    why: all(host, some, otherPane),
  },
  moveTo: {
    label: "move to other pane",
    short: "move",
    note: "with each conflict decided per entry",
    why: all(host, some, otherPane),
  },

  refresh: { label: "refresh", note: "re-read this directory from the host", why: host },

  // `rename`, not `regex rename`: the long label pushed `rm` off the right edge
  // of the toolbar at a 12px `--ui-base` (TRE-72), and the modal's own
  // name/pattern switch says the regex is there better than a label can.
  rename: { label: "rename", note: "one name, or a pattern over the selection", why: all(host, some) },
  chmod: { label: "permissions", note: "mode, owner and group", why: all(host, some) },
  // One at a time, because the route takes one path: a file streams as itself
  // and a directory streams as a zip, and there is no third shape that is
  // several of either (TRE-26).
  download: { label: "download", note: "a file as itself, a directory as a zip", why: all(host, one) },
  // The strip's other way in (TRE-34 §3). The directory heuristic offers logs
  // where logs usually are; this is how somebody follows the one that is not
  // there, and it is the only route that works in an ordinary directory.
  //
  // Files only, and one at a time — the strip follows a file, and "tail these
  // four" is a different feature the ticket puts out of scope.
  tail: {
    label: "tail this file",
    note: "follow it live in the strip under the panes",
    why: all(host, one, onlyKind(["file"], "A tail follows a file")),
  },
  upload: { label: "upload here", short: "upload", mark: "↑", note: "pick files to put in this directory", why: host },
  link: {
    label: "mint signed link",
    note: "a signed URL, good for a while",
    why: all(host, one, onlyKind(["file"], "A signed link points at a file")),
  },

  copyPath: {
    label: "copy path",
    note: "the absolute path, to the clipboard",
    why: all(host, (context) => (context.kind === "directory" ? undefined : one(context))),
  },
  copyName: { label: "copy name", note: "just the name, to the clipboard", why: one },

  favourite: {
    label: "add to favourites",
    note: "keep this directory in the sidebar",
    why: all(
      host,
      (context) => (context.kind === "directory" ? undefined : one(context)),
      (context) =>
        context.kind === "directory" ? undefined : onlyKind(["dir"], "Only a directory can be a favourite")(context),
    ),
  },

  // Aimed at the two panes' directories, never at the selection — which is why
  // it carries no `some` rule and appears in the directory menu rather than the
  // entries one. Comparing "these three files" against another pane is a
  // different question, and not one this asks.
  compare: {
    label: "compare with other pane",
    short: "compare",
    mark: "⇄",
    note: "name, size and hash, both directories",
    why: all(host, bothPanes),
  },

  // Files only, and it is not a limitation of the route — a directory in the
  // selection is expanded into the files under it. It is what the word means: a
  // directory has no sha256, and an entry offering one would be promising a
  // number that does not exist. Selecting the directory and asking for the
  // checksums of what is in it is the same gesture, one row up.
  hash: { label: "compute sha256", note: "runs in the background", why: all(host, some) },
  rm: { label: "rm", note: "permanent — this app has no trash", danger: true, why: all(host, some) },
};

// --------------------------------------------------------------- the shapes

/** `null` is the rule between two blocks. */
type ShapeRow = ActionId | null;

/**
 * The menu over one or more entries.
 *
 * `new` stays at the top of both shapes. Finder and Explorer put "New Folder"
 * only in the background menu and both can afford to, because their listings
 * end; this one is virtualised (TRE-19), so a directory of two thousand entries
 * has no empty space left to right-click and a `new directory` reachable only
 * by scrolling to the bottom of `node_modules` is not reachable.
 */
const ENTRIES_SHAPE: readonly ShapeRow[] = [
  "newDir",
  "newFile",
  null,
  "open",
  "openOther",
  null,
  "cut",
  "copy",
  "duplicate",
  "copyTo",
  "moveTo",
  null,
  "rename",
  "chmod",
  "download",
  "tail",
  "link",
  "hash",
  "copyPath",
  "copyName",
  null,
  "favourite",
  "rm",
];

/** The menu over empty space, `..`, the path row or a tab. */
const DIRECTORY_SHAPE: readonly ShapeRow[] = [
  "newDir",
  "newFile",
  null,
  "paste",
  "upload",
  null,
  "refresh",
  "compare",
  "copyPath",
  "favourite",
];

/** The toolbar's row, unchanged from what TRE-14 drew and TRE-42 trued up. */
const TOOLBAR_SHAPE: readonly ShapeRow[] = [
  "newDir",
  "copyTo",
  "moveTo",
  "duplicate",
  "compare",
  "chmod",
  "rename",
  "download",
  "upload",
  "rm",
];

/**
 * The palette's shape (TRE-36 §1).
 *
 * Nearly everything, and the omissions are the argument. `open` and `open in
 * other pane` are missing because both mean "the row the cursor is on", and the
 * palette cannot aim at that row any better than ↩ already does — an entry for
 * them would be a second name for a key that is one press away, on a surface
 * that costs two.
 *
 * Everything else is here whether or not it can run, which is the ticket's
 * rule and a good one: a palette that hides what is unavailable is a palette
 * nobody can learn the app from. `rm` is last, where a destructive thing
 * belongs in a list somebody is arrowing down.
 *
 * No rules in it. The group header is the separator on this surface.
 */
const PALETTE_SHAPE: readonly ShapeRow[] = [
  "compare",
  "chmod",
  "rename",
  "copyTo",
  "moveTo",
  "duplicate",
  "hash",
  "download",
  "upload",
  "tail",
  "link",
  "newDir",
  "newFile",
  "refresh",
  "cut",
  "copy",
  "paste",
  "copyPath",
  "copyName",
  "favourite",
  "rm",
];

/**
 * What a surface should draw, for this target.
 *
 * The target decides which entries **exist** — an entry belonging to the other
 * shape is absent, because a menu is about what was right-clicked. The context
 * decides which are **enabled** — an entry that belongs here but cannot run now
 * is present, disabled, and carries the sentence why, which is the convention
 * the toolbar has followed since TRE-14 and how anyone learns the operation is
 * there at all.
 *
 * Handlers are not attached here: this file knows what exists, and the surface
 * knows what pressing it does.
 */
export function resolveActions(context: ActionContext, surface: Surface = "menu"): readonly ActionRow[] {
  const shape =
    surface === "toolbar"
      ? TOOLBAR_SHAPE
      : surface === "palette"
        ? PALETTE_SHAPE
        : context.kind === "directory"
          ? DIRECTORY_SHAPE
          : ENTRIES_SHAPE;

  const rows: ActionRow[] = [];
  for (const id of shape) {
    if (id === null) {
      // Never two rules running together, and never one at either end — a shape
      // whose blocks are all empty would otherwise draw as a stack of lines.
      if (rows.length > 0 && !isRule(rows[rows.length - 1])) rows.push({ rule: true });
      continue;
    }

    const spec = SPECS[id];
    rows.push({
      id,
      label: surface === "toolbar" ? (spec.short ?? spec.label) : spec.label,
      // Read, never written. The chord lives in `helpers/keys.ts` and this is
      // the only place any surface asks for it (TRE-36 §2).
      hint: hintFor(id),
      mark: spec.mark,
      note: spec.note,
      danger: spec.danger,
      unavailableReason: spec.why?.(context),
    });
  }

  // A trailing rule is possible whenever the last block is empty.
  while (rows.length > 0 && isRule(rows[rows.length - 1])) rows.pop();
  return rows;
}
