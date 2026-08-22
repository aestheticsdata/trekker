/**
 * The surfaces and inks the sudo chrome is drawn in (TRE-29).
 *
 * Here rather than in the components for the reason `tooltip.ts` gives:
 * `scripts/verify-contrast.ts` measures these, and Node runs that script
 * directly — it can strip types, but not JSX. A check with its own copy of the
 * palette is a check of the copy.
 *
 * These are the colours that *carry the meaning*. The `#` on a command preview
 * and the countdown on the badge are the app's answer to "will this run as
 * root", and an answer that is hard to read is not one. So every pair below is
 * checked at AA rather than trusted.
 *
 * `warning-wash` exists because of the obvious shortcut it replaces. Tinting a
 * surface toward amber with `bg-warning/10` to sit under amber text moves the
 * background *closer* to the ink: over `app` that composite measures 4.41:1,
 * which is under AA and looks perfectly fine while being wrong. An opaque token
 * is a colour that can be measured instead of composited, which is also why the
 * check can see it at all — the script cannot resolve an opacity modifier.
 */

/** The badge's fill while a window is open, and the sudo modal's header. */
export const SUDO_SURFACE = "bg-warning-wash";
/** The label, the countdown, and the `#` itself. */
export const SUDO_INK = "text-warning";

/** The chrome behind a command preview, in every modal that draws one. */
export const COMMAND_SURFACE = "bg-chrome";
/** `$` while unelevated. */
export const PROMPT_INK = "text-ink-label";
/** `#` while a window is open, and the note under the box that says what it means. */
export const PROMPT_ELEVATED_INK = "text-warning";

/** The panel behind a modal's body, which the elevated note sits directly on. */
export const MODAL_SURFACE = "bg-app";

/** The `elevate` button: dark ink on a full amber fill, the inverse of the rest. */
export const ELEVATE_FILL = "bg-warning";
export const ELEVATE_INK = "text-on-accent";
