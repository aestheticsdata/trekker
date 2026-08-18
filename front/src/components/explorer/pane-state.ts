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

/** A pane's memory joined with what the URL owns — what a `Pane` renders from. */
export interface PaneView extends PaneMemory {
  /** Null until a host is bound. */
  hostId: string | null;
  path: string;
  sort: SortKey;
  dir: SortDirection;
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

    case "click": {
      if (action.extend && pane.cur) {
        const from = action.names.indexOf(pane.cur);
        const to = action.names.indexOf(action.name);
        if (from > -1 && to > -1) {
          const sel = action.names.slice(Math.min(from, to), Math.max(from, to) + 1);
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
      return { ...pane, cur: name, sel: [name] };
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

/** Where "up" goes, or null at the root. */
export function upTarget(path: string): string | null {
  return path === "/" ? null : parentPath(path);
}

/** Where opening a directory goes. */
export function openTarget(path: string, name: string): string {
  return joinPath(path, name);
}
