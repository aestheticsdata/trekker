import { API_ORIGIN } from "@lib/api/client";

/**
 * The live tail stream (TRE-34), against `GET /api/fs/tail`.
 *
 * Restated rather than imported, like `scans.ts` and `transfers.ts`: the two
 * packages share no types package, and a field that drifts should fail at the
 * first render rather than render `undefined`.
 *
 * Five frame kinds, and unlike the other three streams in this app they arrive
 * as **named** SSE events rather than as one shape on `onmessage`. That is the
 * server's choice and the right one — a tail's frames are disjoint, and
 * re-encoding an event name inside the JSON would be strictly worse than the
 * field the protocol already has for it.
 */

/** `ready` — the subscription that was just granted. Always the first frame. */
export interface TailReady {
  hostId: string;
  /** The **resolved** path the guard produced, which may not be the one asked for. */
  path: string;
  /** Which source is behind it: a real `tail -F`, or the poller. */
  source: "tail" | "poll";
  /** True when this stream joined a source that was already running. */
  shared: boolean;
  /** True when a reconnect carried on from where this client left off. */
  resumed: boolean;
}

/** `lines` — whole lines, already framed, scrubbed and length-bounded. */
export interface TailLines {
  lines: string[];
}

/** `gap` — lines that will never arrive, and why. */
export interface TailGap {
  dropped: number;
  reason: "slow-client" | "truncated-line";
}

/** `rotated` — the file was replaced or truncated under the tail. */
export interface TailRotated {
  at: number;
}

/** `error` — the host stopped answering. `fatal` means the stream is over. */
export interface TailError {
  message: string;
  fatal: boolean;
}

export function tailStreamUrl(hostId: string, path: string, lines?: number): string {
  const query = new URLSearchParams({ hostId, path });
  if (lines !== undefined) query.set("lines", String(lines));
  return `${API_ORIGIN}/api/fs/tail?${query.toString()}`;
}

/**
 * Why an `EventSource` that never opened did not open.
 *
 * `EventSource` cannot see a status code. Per the spec a response that is not
 * 200 `text/event-stream` **fails the connection** rather than retrying it, so
 * the browser hands us a bare `error` with `readyState === CLOSED` and no way
 * to tell a 404 from a 429 from a host that is down — which are three different
 * sentences to a reader, and only one of them means "try later".
 *
 * So the refusal is asked for a second time as an ordinary request, where the
 * status and the API's own message are both readable. It costs one extra call
 * on a path that has already failed, and it is the difference between "that is
 * not a regular file" and a spinner that never resolves.
 *
 * Aborted rather than read: if this attempt happens to *succeed* it is a live
 * subscription, and reading it would leave a second stream open against the
 * same file for as long as the page lasts.
 */
export async function diagnoseTail(hostId: string, path: string): Promise<string> {
  const controller = new AbortController();

  try {
    const response = await fetch(tailStreamUrl(hostId, path), {
      credentials: "include",
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });

    if (response.ok) return "The stream closed before it delivered anything.";

    const payload: unknown = await response.json().catch(() => null);
    return messageOf(payload) ?? `The host refused the tail (${response.status}).`;
  } catch {
    // A network failure, or the abort below racing the response. Neither is a
    // sentence about this file, so the caller gets the honest general one.
    return "The tail could not be opened.";
  } finally {
    controller.abort();
  }
}

/** Nest's envelope, where `message` is a string or a ValidationPipe's array. */
function messageOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const message = (payload as { message?: unknown }).message;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) return message.filter((line) => typeof line === "string").join(" ");
  return null;
}
