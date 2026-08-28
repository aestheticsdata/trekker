"use client";

import { createContext, useContext } from "react";

/**
 * The empty row `AppShell` keeps below the status bar, and the way something
 * rendered elsewhere reaches it (TRE-85 §3).
 *
 * It exists for one occupant: the terminal. 2a draws its prompt as the last row
 * of the window, and the status bar above it is the shell's — but the terminal
 * itself belongs to `Explorer`, because `cd`, `cd -`, `ssh` and both of its
 * modals are closures there. Lifting that state into `page.tsx` to move one
 * `<div>` would leave two inputs pretending to be one, with a focus handoff and
 * a draft carried between them; a portal answers the position and reopens
 * nothing.
 *
 * A context rather than a prop because `children` is built in `page.tsx`, which
 * is above the shell: there is no prop for the shell to hand down. And the node
 * is held in state rather than in a ref, because a ref's `.current` is filled
 * after the render that would have used it — the occupant has to re-render once
 * the row exists, and only state does that.
 */
const FootSlotContext = createContext<HTMLElement | null>(null);

export const FootSlotProvider = FootSlotContext.Provider;

/** The foot row's node, or null before it is mounted — and outside the shell. */
export function useFootSlot(): HTMLElement | null {
  return useContext(FootSlotContext);
}
