/**
 * Shared between main.ts (which sets the cookie) and the controller (which
 * clears it on logout). Two string literals that must match are two string
 * literals that will eventually stop matching.
 */
export const SESSION_COOKIE_NAME = "trekker.sid";

/** Rolling: every request pushes the expiry back. */
export const SESSION_TTL_SECONDS = 60 * 60;
