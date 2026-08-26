/**
 * The two addresses authentication moves between.
 *
 * Plain constants with no directive, because `LOGIN_PATH` is needed on both
 * sides of the boundary: the private layout redirects to it from the server,
 * the API client from the browser. `EXPLORER_PATH` keeps it company rather than
 * sitting alone in a hook — the pair only means anything together.
 */

/** Where a signed-in session belongs. */
export const EXPLORER_PATH = "/";

/** Where one that has ended belongs. */
export const LOGIN_PATH = "/login";
