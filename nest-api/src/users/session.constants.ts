/**
 * Shared between main.ts (which sets the cookie) and the controller (which
 * clears it on logout). Two string literals that must match are two string
 * literals that will eventually stop matching.
 */
export const SESSION_COOKIE_NAME = "trekker.sid";

/**
 * Rolling: every request pushes the expiry back, so this is an idle timeout and
 * not a cap on how long a session may live. An open tab polls often enough to
 * never reach it — the clock only runs while the app is closed.
 *
 * Twelve hours, so that leaving the machine for a working day and coming back
 * does not cost a sign-in. It extends nothing else on its own: a sudo window
 * carries its own, far shorter expiry (`SUDO_WINDOW_MS`, fifteen minutes), and
 * a longer session never keeps a cached password alive past it.
 */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
