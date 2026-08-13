/**
 * The one way this app talks to the API from the browser.
 *
 * Development runs the front on 3005 and the API on 6800. In production nginx
 * puts both behind one domain, so /api/ is same-origin and a bare relative URL
 * is correct. Next inlines NODE_ENV at build time, so there is nothing to
 * configure and no env file on this side.
 */
export const API_ORIGIN = process.env.NODE_ENV === "production" ? "" : "http://localhost:6800";

/** The header Trekker's CsrfGuard reads (nest-api/src/users/csrf-token.util.ts). */
const CSRF_HEADER = "x-csrf-token";

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
 * The one refusal no caller can answer (TRE-63).
 *
 * Every other failure belongs to whoever asked: a 403 is a permission the pane
 * names, a 502 is a host it names, and both leave the reader somewhere they can
 * act. A 401 is not about the request at all — the session ended — and the only
 * useful answer is to leave for the login screen, which no individual call site
 * is in a position to do.
 *
 * Announced from here rather than from a React Query cache handler because not
 * every call is a query: `saveLastLayout` is fire and forget and would never
 * reach one. This is the single door all of them go through, query or not, and
 * it is the earliest point at which the status is known — before any retry
 * policy, and before the caller has decided what to say about its own failure.
 *
 * One slot rather than a set: there is exactly one subscriber by construction
 * (see auth/session-expiry.tsx), and a set would quietly allow a second, which
 * means a second redirect. Unsubscribing compares identity so that React's
 * StrictMode remount — subscribe, clean up, subscribe again — ends subscribed
 * rather than cleared.
 */
type UnauthorizedListener = () => void;

let unauthorizedListener: UnauthorizedListener | null = null;

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListener = listener;

  return () => {
    if (unauthorizedListener === listener) unauthorizedListener = null;
  };
}

export async function apiRequest(path: string, options: RequestOptions = {}): Promise<unknown> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  if (options.body !== undefined) headers["content-type"] = "application/json";
  // Attached whenever we have one and the verb needs it. A GET carrying it
  // would be harmless but pointless.
  if (options.csrfToken && method !== "GET") headers[CSRF_HEADER] = options.csrfToken;

  const response = await fetch(`${API_ORIGIN}/api${path}`, {
    method,
    headers,
    // The session cookie is httpOnly, so this is the only way it travels.
    credentials: "include",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    // Announced before the throw, so the app starts leaving while the caller is
    // still deciding what to say about its own failed request.
    if (response.status === 401 && !options.credentialCheck) unauthorizedListener?.();

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
