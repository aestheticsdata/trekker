import { HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import type { TailFrame, TailSubscriber } from "@fs/tail-registry.service";
import { TAIL_HEARTBEAT_MS } from "@fs/tail-limits";

/**
 * An Express response, as the registry wants to see it (TRE-34 §2).
 *
 * Kept out of the registry so the fan-out can be driven by a spec with a
 * hundred subscribers and no sockets, and kept out of the controller so the
 * handler reads as routing rather than as protocol.
 *
 * **Named events, unlike the other three streams in this application.** They
 * all use a bare `onmessage` with one payload shape, which is right for a
 * progress feed. A tail has four disjoint frame kinds and honours
 * `Last-Event-ID`, and re-encoding an event name inside the JSON would be
 * strictly worse than the field SSE already has for it.
 *
 * One of those names is `error`, and anybody writing a client for this needs to
 * know that it collides with `EventSource`'s own DOM error event: both are
 * dispatched under that name on the same object and nothing in the spec keeps
 * them apart. What does keep them apart is `data` — an SSE frame has it, a
 * connection failure does not. The name stays because it is the accurate one
 * for what the frame says, and because renaming it would only move the trap to
 * whoever next assumes the obvious name means the obvious thing.
 */

/** The headers, verbatim from the three streams that came before. */
export function openStream(res: Response): void {
  res.writeHead(HttpStatus.OK, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx buffers a response by default and would hold the whole stream until
    // the tail ended, which is the opposite of a live tail.
    "X-Accel-Buffering": "no",
  });
  // Immediately, so `EventSource` fires `open` now rather than at the first log
  // line — which on a quiet log could be tomorrow.
  res.write(": connected\n\n");
}

/**
 * An idle stream is indistinguishable from a dead one to every proxy between
 * here and the browser. On a tail that is the ordinary state rather than the
 * exception, which makes the heartbeat load-bearing here and merely prudent on
 * the other three.
 */
export function heartbeat(res: Response): NodeJS.Timeout {
  const timer = setInterval(() => res.write(": ping\n\n"), TAIL_HEARTBEAT_MS);
  timer.unref();
  return timer;
}

export function sendFrame(res: Response, frame: TailFrame): void {
  // `JSON.stringify` is what makes a frame safe: a log line cannot contain a
  // newline once it has been through the framer, but the encoding is what
  // guarantees it rather than an assumption about the framer.
  const id = frame.id === undefined ? "" : `id: ${frame.id}\n`;
  res.write(`${id}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
}

/** The registry's view of one open response. */
export function subscriberFor(res: Response): TailSubscriber {
  return {
    // Node's own count of bytes queued on this socket and not yet flushed. The
    // honest measure of "this client is not keeping up", free to read, and
    // needing no queue of ours to grow beside it.
    bufferedBytes: () => res.writableLength,
    send: (frame) => sendFrame(res, frame),
    end: () => res.end(),
  };
}

/**
 * `Last-Event-ID`, as a number or nothing.
 *
 * The browser sends back whatever it last saw in an `id:` field, so this is
 * client-supplied and is parsed as such: anything that is not a non-negative
 * integer becomes `null` and the client is treated as new, which costs it one
 * replay rather than an error.
 */
export function lastEventIdOf(header: string | string[] | undefined): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
