/**
 * The one way this app talks to the API from the browser.
 *
 * Development runs the front on 3005 and the API on 6800. In production nginx
 * puts both behind one domain, so /api/ is same-origin and a bare relative URL
 * is correct. Next inlines NODE_ENV at build time, so there is nothing to
 * configure and no env file on this side.
 */
import { LOGIN_PATH } from "@auth/paths";

export const API_ORIGIN = process.env.NODE_ENV === "production" ? "" : "http://localhost:6800";

/** The header Trekker's CsrfGuard reads (nest-api/src/users/csrf-token.util.ts). */
const CSRF_HEADER = "x-csrf-token";
const ORIGIN_HEADER = "x-trekker-origin";

/**
 * An API refusal, carrying what the server actually said.
 *
 * The message matters: these screens show the specific reason rather than a
 * generic failure, so "That email is already registered" has to survive the
 * trip instead of becoming "something went wrong".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The machine-readable code, where the endpoint sends one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Required by the API for every unsafe verb. */
  csrfToken?: string | null;
  /**
   * Which surface started this, for the audit log (TRE-35).
   *
   * Only ever `"terminal"`, and only on the three mutating calls a typed line
   * can reach. Absent means a button, which is the default and needs no saying
   * — a header on every request in the app would be a column that is never
   * null and therefore never a filter.
   *
   * Declared per call rather than carried in a context, deliberately. This ends
   * up in an audit row, and an audit row should be traceable to the line of
   * code that claimed it: an ambient origin picked up from a provider is
   * exactly the kind of thing that is right for a year and then quietly wrong.
   */
  origin?: "terminal";
  /**
   * Set on the handful of calls that answer 401 to mean *what you sent is
   * wrong* rather than *your session is gone* — a wrong password, a wrong
   * recovery passphrase (TRE-63).
   *
   * The distinction has teeth. `PATCH /users/password` is session-guarded and
   * answers 401 when the **current** password is mistyped, so the day this app
   * grows a change-password form, an ordinary typo would otherwise sign the
   * operator out mid-sentence. Declared per call rather than inferred from the
   * path, so it sits in `api/users.ts` beside the endpoints it describes, where
   * whoever writes that form will be reading.
   */
  credentialCheck?: boolean;
}

/**
 * Sends the operator to the login screen when the session is gone (TRE-88).
 *
 * The same function the sibling apps carry, in the same place: inside the one
 * door every request goes through, where the 401 is first known. Returns `true`
 * when it navigated — the caller then leaves its promise pending, so the
 * refusal never becomes a React Query error on a page that is already being
 * replaced. Returns `false` when it cannot or should not navigate (a server
 * render, or the login screen already being what is on screen), and the caller
 * throws normally instead of hanging for ever.
 *
 * The navigation is a hard one, and that is the whole mechanism: it discards
 * the auth context, the query cache and this React tree, and re-runs the server
 * guard in `app/(private)/layout.tsx`. Nothing is left to be cleaned up by
 * hand, which is why there is no subscription here and no marker on the way
 * out. The trailing-slash strip is there because a path can arrive as
 * `/login/`.
 */
function redirectToLogin(): boolean {
  if (typeof window === "undefined") return false;

  if (window.location.pathname.replace(/\/$/, "") === LOGIN_PATH) return false;

  window.location.replace(LOGIN_PATH);
  return true;
}

export async function apiRequest(path: string, options: RequestOptions = {}): Promise<unknown> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers["content-type"] = "application/json";
  // Attached whenever we have one and the verb needs it. A GET carrying it
  // would be harmless but pointless.
  if (options.csrfToken && method !== "GET") headers[CSRF_HEADER] = options.csrfToken;
  // A label, not a claim: the API grants the terminal nothing the buttons do
  // not have, so a forged value moves a word in a log and no permission at all.
  // The server still checks it against a closed list before storing it.
  if (options.origin !== undefined) headers[ORIGIN_HEADER] = options.origin;

  const response = await fetch(`${API_ORIGIN}/api${path}`, {
    method,
    headers,
    // The session cookie is httpOnly, so this is the only way it travels.
    credentials: "include",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  // Ahead of reading the body, which nothing downstream will get to look at:
  // the navigation is already under way and this promise never settles, so the
  // 401 reaches neither a caller's catch nor an error boundary.
  if (response.status === 401 && !options.credentialCheck && redirectToLogin()) {
    return new Promise<never>(() => {});
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      response.status,
      messageFrom(payload) ?? `Request failed with ${response.status}`,
      codeFrom(payload),
    );
  }

  return payload;
}

/**
 * Nest's default error envelope puts the reason in `message`, which is a
 * string for a thrown exception and an array for a failed ValidationPipe.
 * Both are worth showing; the array is joined so the panel reads as prose.
 */
function messageFrom(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const message = (payload as { message?: unknown }).message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.filter((line) => typeof line === "string").join(" ");
  return null;
}

function codeFrom(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
