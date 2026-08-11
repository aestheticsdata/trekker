import { joinPath, parentPath } from "@helpers/listing";

import type { SortDirection, SortKey } from "@helpers/listing";

/**
 * What the two panes remember (TRE-16 §2, §3, §5).
 *
 * A reducer rather than a scatter of `useState` calls because these fields
 * change together and the rules between them are the ticket: navigating clears
 * the selection, the cursor is not the selection, and history is per pane and
 * survives a host switch. Every field is a string, a number or an array of
 * them, so TRE-18 can lift the whole thing into the URL through nuqs without
 * reshaping it.
 */

export interface PaneState {
  /** Null until the hosts query answers. */
  hostId: string | null;
  /** One path per open tab; the pane's path is the active tab's. */
  tabs: string[];
  tab: number;
  /** Visited paths, newest last. Back pops, forward pushes. */
  hist: string[];
  fwd: string[];
  /** Names, not indices: a listing can be re-sorted under a selection. */
  sel: string[];
  /** The row the keyboard is on, which is not necessarily selected. */
  cur: string | null;
  sort: SortKey;
  dir: SortDirection;
}

export interface ExplorerState {
  panes: [PaneState, PaneState];
  /** Exactly one pane is active, and every toolbar action means "this one". */
  active: 0 | 1;
}

export type PaneIndex = 0 | 1;

export function pathOf(pane: PaneState): string {
  return pane.tabs[pane.tab] ?? "/";
}

function newPane(path: string): PaneState {
  return { hostId: null, tabs: [path], tab: 0, hist: [], fwd: [], sel: [], cur: null, sort: "name", dir: 1 };
}

export function initialState(path = "/"): ExplorerState {
  return { panes: [newPane(path), newPane(path)], active: 0 };
}

export type ExplorerAction =
  | { type: "focus"; pane: PaneIndex }
  | { type: "switch" }
  /** `null` unbinds — what a pane is left with when its host is deleted. */
  | { type: "host"; pane: PaneIndex; hostId: string | null; path?: string }
  | { type: "cd"; pane: PaneIndex; path: string; history?: boolean }
  | { type: "up"; pane: PaneIndex }
  | { type: "back"; pane: PaneIndex }
  | { type: "forward"; pane: PaneIndex }
  | { type: "open"; pane: PaneIndex; name: string; isDirectory: boolean }
  | { type: "newTab"; pane: PaneIndex }
  | { type: "selectTab"; pane: PaneIndex; tab: number }
  | { type: "sort"; pane: PaneIndex; key: SortKey }
  /** A click on a row, carrying the modifiers and the order they were seen in. */
  | { type: "click"; pane: PaneIndex; name: string; names: readonly string[]; extend: boolean; toggle: boolean }
  | { type: "move"; pane: PaneIndex; delta: number; names: readonly string[] }
  | { type: "cursor"; pane: PaneIndex; name: string | null };

export function explorerReducer(state: ExplorerState, action: ExplorerAction): ExplorerState {
  switch (action.type) {
    case "focus":
      return state.active === action.pane ? state : { ...state, active: action.pane };

    case "switch":
      return { ...state, active: state.active === 0 ? 1 : 0 };

    // A host binding and a cursor landing on the first row of a listing are
    // both data arriving, not the user acting: neither may steal the keyboard
    // from the pane they are working in.
    case "host":
    case "cursor":
      return { ...state, panes: withPane(state, action) };

    default:
      return { ...state, active: action.pane, panes: withPane(state, action) };
  }
}

function withPane(state: ExplorerState, action: ExplorerAction & { pane: PaneIndex }): [PaneState, PaneState] {
  return state.panes.map((pane, index) => (index === action.pane ? paneReducer(pane, action) : pane)) as [
    PaneState,
    PaneState,
  ];
}

function paneReducer(pane: PaneState, action: ExplorerAction): PaneState {
  switch (action.type) {
    case "host": {
      // The pane keeps its history across a host switch, as the ticket asks,
      // but not its selection: those names belong to the other machine. The
      // jump itself is not a history entry — going "back" to a path on a host
      // the pane has left would restore neither.
      const path = action.path ?? pathOf(pane);
      return { ...navigate(pane, path, false), hostId: action.hostId };
    }

    case "cd":
      return navigate(pane, action.path, action.history !== false);

    case "up": {
      const path = pathOf(pane);
      return path === "/" ? pane : navigate(pane, parentPath(path), true);
    }

    // History is the pane's while the path is the tab's, so switching tabs can
    // leave the top of the stack equal to where we already are. Skipping those
    // entries is what stops Back from spending one and going nowhere.
    case "back": {
      const hist = pane.hist.slice();
      const current = pathOf(pane);
      while (hist.length > 0 && hist[hist.length - 1] === current) hist.pop();
      if (hist.length === 0) return { ...pane, hist };
      const previous = hist.pop() as string;
      return { ...navigate(pane, previous, false), hist, fwd: [current, ...pane.fwd] };
    }

    case "forward": {
      const fwd = pane.fwd.slice();
      const current = pathOf(pane);
      while (fwd.length > 0 && fwd[0] === current) fwd.shift();
      if (fwd.length === 0) return { ...pane, fwd };
      const next = fwd.shift() as string;
      return { ...navigate(pane, next, false), fwd, hist: [...pane.hist, current] };
    }

    case "open":
      return action.isDirectory ? navigate(pane, joinPath(pathOf(pane), action.name), true) : pane;

    case "newTab":
      return { ...pane, tabs: [...pane.tabs, pathOf(pane)], tab: pane.tabs.length, sel: [], cur: null };

    case "selectTab":
      return action.tab === pane.tab || action.tab >= pane.tabs.length
        ? pane
        : { ...pane, tab: action.tab, sel: [], cur: null };

    case "sort":
      // Second click on the same column reverses it. A different column starts
      // ascending — except size, where the question is always "what is eating
      // the disk", so the first click puts the biggest at the top.
      return pane.sort === action.key
        ? { ...pane, dir: pane.dir === 1 ? -1 : 1 }
        : { ...pane, sort: action.key, dir: action.key === "size" ? -1 : 1 };

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
function navigate(pane: PaneState, path: string, pushHistory: boolean): PaneState {
  const current = pathOf(pane);
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
