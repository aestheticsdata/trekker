/**
 * The treatment a control takes when it is the thing to press (TRE-78).
 *
 * Here rather than in the components for the reason `sudo.ts`, `tail.ts` and
 * `terminal.ts` all give: `scripts/verify-contrast.ts` measures these, and Node
 * runs that script directly — it can strip types, but not JSX. A check with its
 * own copy of the palette is a check of the copy.
 *
 * It exists at all because the obvious answer was wrong for a year. This app
 * reached for `bg-accent` with `text-on-accent` on the ⌘K chip, every modal's
 * confirm button, every permission toggle and the empty pane's one action —
 * fourteen places, all measuring **3.62:1**, all under AA. TRE-34 found it
 * while building the tail strip, refused the pair for its own two buttons, and
 * left the rest for this ticket.
 *
 * The fix could not be the ink. `--color-accent` is an awkward mid-blue and
 * nothing in the palette clears 4.5:1 against it from either side: the darkest
 * ink reaches 3.62 and the lightest reaches 4.08. So the fill moved, onto two
 * values that were already in the palette wearing other names.
 */

/** The fill at rest — 7.09:1 under `PRESS_INK`. */
export const PRESS_FILL = "bg-accent-fill";
/** And under the pointer, brighter rather than darker — 9.34:1. */
export const PRESS_HOVER_FILL = "bg-accent-fill-hover";
/** Dark navy, which is what those two fills are chosen to carry. */
export const PRESS_INK = "text-on-accent";

/**
 * The three of them, as a component writes them.
 *
 * Spelled out rather than built from the constants above, and that duplication
 * is deliberate: Tailwind's scanner reads source text, so a class name composed
 * at runtime — `` `hover:${PRESS_HOVER_FILL}` `` — is a class name that never
 * gets generated. The utility would simply not exist, and the button would
 * silently have no hover at all.
 *
 * The cost is two places that have to agree, so `verify:contrast` asserts they
 * do: it measures the constants, which would not catch a typo in this line, and
 * then checks that this line is made of them.
 */
export const PRESS = "bg-accent-fill text-on-accent hover:bg-accent-fill-hover";

/**
 * A control that is *on* rather than one waiting to be pressed.
 *
 * The same fill and no hover, because a permission bit that is granted, or a
 * scope that is selected, is showing a state rather than offering an action —
 * and a fill that brightened under the pointer would suggest the pointer was
 * about to change something it is not.
 */
export const ON_FILL = "bg-accent-fill text-on-accent";

/**
 * The cell of a segmented control that is the current one.
 *
 * Deliberately *not* `PRESS`, and deliberately left on the colour it already
 * had. A tab that is selected is quieter than the button that commits, and
 * that hierarchy is the mockup's — so the fill stays `accent-soft` and only
 * gets a name.
 *
 * The name is the point. `accent-soft` under this ink is **4.59:1**, nine
 * hundredths over AA, which is fine and is also the thinnest margin that ships
 * here. Left as six inline literals it was a pair no check could see, so a
 * token nudged one step darker would have taken all six under without a word.
 * Named, it is measured.
 */
export const SELECTED = "bg-accent-soft text-on-accent";
export const SELECTED_FILL = "bg-accent-soft";

/**
 * The destructive confirm, which needed no new colour — only the right ink.
 *
 * `bg-danger` was already correct. It was carrying `text-on-accent`, dark navy
 * on dark red, at **1.88:1** — the worst pair in the app, on the one button in
 * it that cannot be undone. `text-ink` on the same fill is 7.86:1.
 */
export const DANGER_FILL = "bg-danger";
export const DANGER_INK = "text-ink";
