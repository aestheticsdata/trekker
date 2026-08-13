/**
 * The two addresses authentication moves between, and the mark it leaves when
 * it moves for a reason.
 *
 * Plain constants with no directive, because `LOGIN_PATH` is needed on both
 * sides of the boundary: the private layout redirects to it from the server,
 * the expiry listener from the browser. `EXPLORER_PATH` keeps it company rather
 * than sitting alone in a hook — the pair only means anything together.
 */

/** Where a signed-in session belongs. */
export const EXPLORER_PATH = "/";

/** Where one that has ended belongs. */
export const LOGIN_PATH = "/login";

/**
 * Set on the way to the login screen when the session ended on its own rather
 * than because someone arrived without one.
 *
 * A constant rather than two string literals: the writer and the reader are in
 * different trees — one private, one public — and the day they disagree the
 * notice simply stops appearing, with nothing to see and nothing to catch it.
 */
export const SESSION_EXPIRED_PARAM = "expired";
