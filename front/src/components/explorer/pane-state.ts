import { joinPath, parentPath } from "@helpers/listing";

import type { Clipboard, ClipboardMode } from "@helpers/clipboard";
import type { SortDirection, SortKey } from "@helpers/listing";

/**
 * What the two panes remember (TRE-16 §2, §3, §5), minus what the URL now owns
 * (TRE-18 §1).
 *
 * The split is the interesting part. A pane's host, path, sort key and sort
 * direction are in the query string, because those four are what a link has to
 * reproduce. Everything here is what a link should not carry: the open tabs,
 * the back and forward stacks — unbounded arrays appended on every navigation,
 * which would walk a long session into a URL no browser accepts — and the
 * selection and cursor, which change on every arrow key.
 *
 * So the reducer no longer decides where a pane is. It is told, and it keeps
 * the memory around that: actions carry the path, and the caller writes the
 * same path to the URL. One direction, no sync loop.
 */

/** The half of a pane's state that lives in React. */
export interface PaneMemory {
  /** One path per open tab; `tabs[tab]` mirrors the URL's path for this pane. */
  tabs: string[];
  tab: number;
  /** Visited paths, newest last. Back pops, forward pushes. */
  hist: string[];
  fwd: string[];
  /** Names, not indices: a listing can be re-sorted under a selection. */
  sel: string[];
  /** The row the keyboard is on, which is not necessarily selected. */
  cur: string | null;
}

/**
 * The name the cursor holds while it stands on the `..` row (TRE-77).
 *
 * A name, like every other value `cur` takes, and safe as one: the API refuses
 * `..` as an entry name at every point one could arrive — the rename plan, the
 * create endpoint, the path guard's segment check — so no listing can carry a
 * row called this. Everything that resolves the cursor through `rows.find(...)`
 * therefore answers null for it without being taught to, which is the right
 * answer: `..` is a place to stand, not a thing to operate on.
 */
export const PARENT_NAME = "..";

/** A pane's memory joined with what the URL owns — what a `Pane` renders from. */
export interface PaneView extends PaneMemory {
  /** Null until a host is bound. */
  hostId: string | null;
  path: string;
  sort: SortKey;
  dir: SortDirection;
  /** The columns this pane has put away (TRE-124), as `helpers/columns.ts` writes them. */
  hide: string;
}

export interface ExplorerState {
  panes: [PaneMemory, PaneMemory];
  /**
   * What `⌘X` or `⌘C` is holding, or null for nothing (TRE-71 §1).
   *
   * Beside the panes rather than inside one, because there is one clipboard and
   * not two: a `⌘V` whose meaning depended on which pane had focus would be a
   * rule nothing on screen explains. It sits here for the same reason the tabs
   * and the history stacks do — it is memory around where the panes are, and it
   * survives navigation, a pane switch and a re-sort, which are exactly the
   * things done between taking something and putting it down.
   *
   * Not in the URL, and so not across a reload. A clipboard remembered from
   * yesterday holds paths that may not exist on a host that may not answer, and
   * offering to paste them is worse than having forgotten them.
   */
  clip: Clipboard | null;
}

export type PaneIndex = 0 | 1;

export function pathOf(pane: PaneView): string {
  return pane.path;
}

function newPane(path: string): PaneMemory {
  return { tabs: [path], tab: 0, hist: [], fwd: [], sel: [], cur: null };
}

export function initialState(path = "/"): ExplorerState {
  return { panes: [newPane(path), newPane(path)], clip: null };
}

export type ExplorerAction =
  /** Every path change. `history: false` for a replay or a host switch. */
  | { type: "navigate"; pane: PaneIndex; path: string; history?: boolean }
  /** Back and forward, which rewrite both stacks and the path at once. */
  | { type: "stacks"; pane: PaneIndex; path: string; hist: string[]; fwd: string[] }
  | { type: "newTab"; pane: PaneIndex; path: string }
  | { type: "selectTab"; pane: PaneIndex; tab: number }
  /**
   * Shutting one tab, and shutting all the others (TRE-130).
   *
   * `tab` is the handle the gesture was aimed at, which is not necessarily the
   * open one — the × on a background tab closes that tab and leaves the pane
   * exactly where it is. Neither may empty the strip: a pane with no tabs has
   * nowhere to be, and that rule lives here rather than in the two surfaces
   * that offer the gesture, which is what stops them from disagreeing about it.
   */
  | { type: "closeTab"; pane: PaneIndex; tab: number }
  | { type: "closeOtherTabs"; pane: PaneIndex; tab: number }
  /** A click on a row, carrying the modifiers and the order they were seen in. */
  | { type: "click"; pane: PaneIndex; name: string; names: readonly string[]; extend: boolean; toggle: boolean }
  | { type: "move"; pane: PaneIndex; delta: number; names: readonly string[] }
  /** ⌘A. Carries the names for the same reason `click` does — the pane knows
   * what is on screen, the reducer does not. */
  | { type: "selectAll"; pane: PaneIndex; names: readonly string[] }
  /** After an operation renamed or removed what was selected (TRE-22): the
   * names no longer describe anything, and the cursor's does not either. */
  | { type: "selectNone"; pane: PaneIndex }
  /**
   * Put the cursor and the selection on one entry, by name (TRE-69 §3).
   *
   * Carries no `names`, unlike `click`: what this points at has usually just
   * been created and is not in the listing yet. The name is written down now
   * and means something the moment the refetch lands, which is what makes
   * "created, then selected" one gesture instead of two.
   */
  | { type: "reveal"; pane: PaneIndex; name: string }
  | { type: "cursor"; pane: PaneIndex; name: string | null }
  /**
   * `⌘X` and `⌘C` (TRE-71 §1). Taking a new selection replaces what is
   * held — there is no stack, because a clipboard with a history is one whose
   * `⌘V` cannot be predicted from anything on screen.
   */
  | { type: "hold"; mode: ClipboardMode; hostId: string; directory: string; names: readonly string[] }
  /** A click on the status bar, `⎋` in a pane, and a cut that has been pasted. */
  | { type: "release" };

/** The actions a single pane answers. The two clipboard ones are not among them. */
type PaneAction = Extract<ExplorerAction, { pane: PaneIndex }>;

export function explorerReducer(state: ExplorerState, action: ExplorerAction): ExplorerState {
  // The clipboard is not a pane's, so these two never reach `paneReducer` —
  // which is also why they are the only actions here without a `pane`.
  switch (action.type) {
    case "hold":
      return action.names.length === 0
        ? state
        : {
            ...state,
            clip: {
              mode: action.mode,
              hostId: action.hostId,
              directory: action.directory,
              // Copied: the caller hands over the pane's own selection array,
              // which the next click rewrites.
              names: [...action.names],
            },
          };

    case "release":
      return state.clip === null ? state : { ...state, clip: null };

    default:
      return {
        ...state,
        panes: state.panes.map((pane, index) => (index === action.pane ? paneReducer(pane, action) : pane)) as [
          PaneMemory,
          PaneMemory,
        ],
      };
  }
}

/**
 * Whether a close aimed at `tab` is a close that may happen (TRE-130).
 *
 * One predicate for both actions and for the two surfaces that offer them, so
 * the strip, the menu and the reducer cannot come to different conclusions
 * about the same handle. The last tab never closes — a pane with no tabs has no
 * path, and `tabs[tab]` is what half this module reads.
 */
function closable(pane: PaneMemory, tab: number): boolean {
  return pane.tabs.length > 1 && tab >= 0 && tab < pane.tabs.length;
}

function paneReducer(pane: PaneMemory, action: PaneAction): PaneMemory {
  switch (action.type) {
    case "navigate":
      return navigate(pane, action.path, action.history !== false);

    case "stacks": {
      const tabs = pane.tabs.slice();
      tabs[pane.tab] = action.path;
      return { ...pane, tabs, hist: action.hist, fwd: action.fwd, sel: [], cur: null };
    }

    case "newTab":
      return { ...pane, tabs: [...pane.tabs, action.path], tab: pane.tabs.length, sel: [], cur: null };

    case "selectTab":
      return action.tab === pane.tab || action.tab >= pane.tabs.length
        ? pane
        : { ...pane, tab: action.tab, sel: [], cur: null };

    case "closeTab": {
      if (!closable(pane, action.tab)) return pane;

      const tabs = pane.tabs.filter((_, index) => index !== action.tab);
      // Closing the open tab lands on its neighbour to the right, or on the new
      // last tab when the right-hand end is what closed — which is what every
      // tabbed thing this app is shaped after does. Closing any other tab
      // leaves the open one open, one place to the left if it was to the right.
      const tab = action.tab < pane.tab ? pane.tab - 1 : Math.min(pane.tab, tabs.length - 1);

      // The selection and the cursor go only when the pane has actually moved.
      // They name rows in a directory nobody is looking at any more — but
      // closing a *background* tab changes nothing on screen, and a fifty-entry
      // selection lost to tidying up the strip would be a gesture nobody makes
      // twice.
      return action.tab === pane.tab ? { ...pane, tabs, tab, sel: [], cur: null } : { ...pane, tabs, tab };
    }

    case "closeOtherTabs": {
      if (!closable(pane, action.tab)) return pane;
      // Same rule, read the other way: the pane moves unless the tab that
      // survives is the one it was already on.
      return action.tab === pane.tab
        ? { ...pane, tabs: [pane.tabs[action.tab]], tab: 0 }
        : { ...pane, tabs: [pane.tabs[action.tab]], tab: 0, sel: [], cur: null };
    }

    case "click": {
      // `..` is a row the cursor can stand on and never one the selection can
      // hold (TRE-77). `sel` is what `rm`, chmod, the transfer and the rename
      // pattern are aimed at, and a list containing `..` is a list pointing at
      // the parent directory.
      //
      // Landing on it moves the cursor and leaves the selection exactly as it
      // was, rather than replacing it the way a click on a real row does. The
      // alternative makes the one unselectable row in the listing the quickest
      // way to lose a fifty-entry selection — a worse trade than a cursor that
      // has stepped off what is highlighted, which is a state every two-pane
      // manager this app is shaped after allows.
      if (action.name === PARENT_NAME) return { ...pane, cur: PARENT_NAME };

      if (action.extend && pane.cur) {
        const from = action.names.indexOf(pane.cur);
        const to = action.names.indexOf(action.name);
        if (from > -1 && to > -1) {
          // Filtered rather than assumed clean: `names` carries `..` so the
          // cursor can walk onto it, so a range that reaches the top of the
          // listing contains it. Refusing it here rather than at the four
          // callers is what keeps the rule in one place.
          const sel = action.names
            .slice(Math.min(from, to), Math.max(from, to) + 1)
            .filter((name) => name !== PARENT_NAME);
          // The cursor follows the click, as it does in every file manager and
          // in the mockup: an arrow key afterwards carries on past the end of
          // the range rather than jumping back into the middle of it.
          return { ...pane, sel: [...sel], cur: action.name };
        }
      }
      if (action.toggle) {
        const sel = pane.sel.includes(action.name)
          ? pane.sel.filter((name) => name !== action.name)
          : [...pane.sel, action.name];
        return { ...pane, sel, cur: action.name };
      }
      return { ...pane, sel: [action.name], cur: action.name };
    }

    case "move": {
      if (action.names.length === 0) return pane;
      const current = pane.cur === null ? -1 : action.names.indexOf(pane.cur);
      const next = Math.max(0, Math.min(action.names.length - 1, current < 0 ? 0 : current + action.delta));
      const name = action.names[next];
      // The same rule as `click` above: the cursor may land on `..`, the
      // selection may not follow it there, and what was selected stays so —
      // arrowing over `..` on the way to the row below must not be a way to
      // lose it.
      return name === PARENT_NAME ? { ...pane, cur: name } : { ...pane, cur: name, sel: [name] };
    }

    case "selectAll": {
      // Everything the pane is showing, which under a glob is not everything
      // the directory holds — selecting rows you filtered away would be a way
      // to delete files you never saw.
      if (action.names.length === 0) return pane;
      return { ...pane, sel: [...action.names], cur: pane.cur ?? action.names[0] };
    }

    case "selectNone":
      // The cursor goes with it. Its name is one of the ones that just changed,
      // and the effect that seeds a cursor puts it back on the first row.
      return pane.sel.length === 0 && pane.cur === null ? pane : { ...pane, sel: [], cur: null };

    case "reveal":
      return { ...pane, sel: [action.name], cur: action.name };

    case "cursor":
      return pane.cur === action.name ? pane : { ...pane, cur: action.name };

    default:
      return pane;
  }
}

/**
 * Every path change in one place: the tab moves, the selection and cursor go
 * (they named rows in a directory nobody is looking at any more), and history
 * records where we were unless we are replaying it.
 */
function navigate(pane: PaneMemory, path: string, pushHistory: boolean): PaneMemory {
  const current = pane.tabs[pane.tab] ?? "/";
  if (path === current) return pane;

  const tabs = pane.tabs.slice();
  tabs[pane.tab] = path;

  return {
    ...pane,
    tabs,
    sel: [],
    cur: null,
    hist: pushHistory ? [...pane.hist, current] : pane.hist,
    fwd: pushHistory ? [] : pane.fwd,
  };
}

/**
 * Where Back would go, or null when it would go nowhere.
 *
 * Pure and exported because the caller has to know the destination *before*
 * dispatching: the URL is the source of truth for the path, so it is written
 * with the same value the reducer is about to record, rather than read back
 * out of the reducer afterwards.
 *
 * History is the pane's while the path is the tab's, so switching tabs can
 * leave the top of the stack equal to where we already are. Skipping those
 * entries is what stops Back from spending one and going nowhere.
 */
export function backTarget(pane: PaneView): { path: string; hist: string[]; fwd: string[] } | null {
  const hist = pane.hist.slice();
  while (hist.length > 0 && hist[hist.length - 1] === pane.path) hist.pop();
  if (hist.length === 0) return null;
  const path = hist.pop() as string;
  return { path, hist, fwd: [pane.path, ...pane.fwd] };
}

export function forwardTarget(pane: PaneView): { path: string; hist: string[]; fwd: string[] } | null {
  const fwd = pane.fwd.slice();
  while (fwd.length > 0 && fwd[0] === pane.path) fwd.shift();
  if (fwd.length === 0) return null;
  const path = fwd.shift() as string;
  return { path, hist: [...pane.hist, pane.path], fwd };
}

/**
 * Where closing a tab leaves the pane, or null when it leaves it where it is
 * (TRE-130).
 *
 * Pure and exported for `backTarget`'s reason: the URL owns the path, so the
 * caller has to know the destination *before* dispatching in order to write the
 * same value the reducer is about to record. Null covers both of the cases with
 * nothing to write — a lone tab, which never closes, and a background tab,
 * whose closing the open one does not feel.
 */
export function closeTabTarget(pane: PaneView, tab: number): string | null {
  if (!closable(pane, tab) || tab !== pane.tab) return null;
  const tabs = pane.tabs.filter((_, index) => index !== tab);
  return tabs[Math.min(tab, tabs.length - 1)];
}

/**
 * The same question for "close the others": the surviving tab's path, or null
 * when it is the one the pane is already on.
 */
export function closeOtherTabsTarget(pane: PaneView, tab: number): string | null {
  if (!closable(pane, tab) || tab === pane.tab) return null;
  return pane.tabs[tab];
}

/** Whether the strip has anything to close, which is what both menu rows ask. */
export function canCloseTabs(pane: PaneView): boolean {
  return pane.tabs.length > 1;
}

/** Where "up" goes, or null at the root. */
export function upTarget(path: string): string | null {
  return path === "/" ? null : parentPath(path);
}

/**
 * Where the cursor sits in the pane's scroll window, or -1 when it sits nowhere.
 *
 * The window counts `..` as its row 0 and the listing array does not contain it,
 * so the search that answers for every other name answers -1 for this one — and
 * a virtualiser handed -1 does not scroll to the row the keyboard is standing on
 * (TRE-77, TRE-19).
 *
 * The row index is passed in rather than searched for here: the caller already
 * has it, and a ten-thousand-row listing should not be walked twice to answer
 * one question.
 */
export function cursorWindowIndex(cur: string | null, rowIndex: number, hasParent: boolean): number {
  if (cur === PARENT_NAME) return hasParent ? 0 : -1;
  if (cur === null || rowIndex < 0) return -1;
  return rowIndex + (hasParent ? 1 : 0);
}

/** Where opening a directory goes. */
export function openTarget(path: string, name: string): string {
  return joinPath(path, name);
}
