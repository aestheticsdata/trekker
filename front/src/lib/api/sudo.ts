import { apiRequest } from "@lib/api/client";

/**
 * Opening and closing a sudo window (TRE-29).
 *
 * Three calls, and the order between the first two is the point. `GET :id/sudo`
 * is asked *before* anything is typed, because most cloud images ship their
 * default account with `NOPASSWD: ALL` and `sudo` on such a host never reads
 * what it is sent — a password field there would accept the wrong password, or
 * a blank one, and report success. Asking the host first is what keeps the
 * prompt honest.
 *
 * Nothing here ever reads a password back, and nothing here stores one. It goes
 * up once, `sudo` decides, and the window that comes back names only how long
 * it lasts.
 */

/**
 * What this host would want in order to open a window.
 *
 * `"none"` is the common case rather than the degenerate one. The last two are
 * configuration rather than authentication: nothing the person at the keyboard
 * can retype will change either answer.
 */
export type SudoRequirement = "none" | "password" | "not-a-sudoer" | "no-sudo-binary";

export interface SudoRequirementView {
  hostId: string;
  needs: SudoRequirement;
  /**
   * How long a window opened now would last, from the server rather than from a
   * constant here — the duration is an install setting, and a modal that reads
   * "fifteen minutes" on a host configured for five would be lying in the one
   * dialog where the reader is deciding how much to trust this application.
   */
  windowMs: number;
}

/** An open window, as the client sees it. Never carries the password. */
export interface SudoWindowView {
  hostId: string;
  hostLabel: string;
  /** Whether a password was actually required. False on a NOPASSWD host. */
  neededPassword: boolean;
  /** ISO 8601 — a `Date` on the server, a string by the time it lands here. */
  expiresAt: string;
  remainingMs: number;
}

export async function fetchSudoRequirement(hostId: string): Promise<SudoRequirementView> {
  return (await apiRequest(`/hosts/${hostId}/sudo`)) as SudoRequirementView;
}

/**
 * Open a window on one host.
 *
 * `password` is omitted rather than sent empty when the host asked for none —
 * the API refuses a present-but-blank one, and rightly: an empty string is a
 * guess, not an absence.
 *
 * `credentialCheck` is load-bearing (TRE-63). This route answers 401 for a
 * password `sudo` refused, which is a fact about the *machine's* account and
 * says nothing about the browser session. Without the flag, one mistyped sudo
 * password would sign the operator out of Trekker mid-sentence.
 */
export async function openSudo(
  hostId: string,
  password: string | null,
  csrfToken: string | null,
): Promise<SudoWindowView> {
  return (await apiRequest(`/hosts/${hostId}/sudo`, {
    method: "POST",
    body: password === null ? {} : { password },
    csrfToken,
    credentialCheck: true,
  })) as SudoWindowView;
}

/**
 * Close it early. Idempotent by design on the server, which is what lets the
 * badge lose a race with the expiry timer without raising anything.
 */
export async function dropSudo(hostId: string, csrfToken: string | null): Promise<{ ok: true; wasOpen: boolean }> {
  return (await apiRequest(`/hosts/${hostId}/sudo/drop`, { method: "POST", csrfToken })) as {
    ok: true;
    wasOpen: boolean;
  };
}

/**
 * `14:32`, the way a window's remaining time is written everywhere in the app.
 *
 * Rounded up, not down: a window with 400ms left is still open, and a badge
 * reading `0:00` beside a working `#` prompt is the kind of small lie that
 * makes someone distrust the whole indicator. Minutes are unpadded and seconds
 * are not, so the string is stable at `mm:ss` width once past ten minutes.
 */
export function formatWindow(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
