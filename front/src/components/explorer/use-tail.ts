"use client";

import { diagnoseTail, tailStreamUrl } from "@lib/api/tail";
import { useEffect, useState } from "react";

import type { TailError, TailGap, TailLines, TailReady, TailRotated } from "@lib/api/tail";

/**
 * One open tail, as the strip needs to see it (TRE-34 §3).
 *
 * Beside the component rather than inside it, and beside it rather than in
 * `lib/query`, for the reason `row-window.ts` is here: this is not a query. It
 * is a connection with a lifetime, a bounded buffer and a small state machine,
 * and the component that draws it should read as drawing rather than as
 * protocol.
 *
 * The three streams that came before this one — scans, hashes, transfers — each
 * open their `EventSource` inline in the component that consumes them, and that
 * is right for a progress feed with one frame shape and nothing to remember.
 * This one has five frame kinds, a ring to keep, markers to interleave and a
 * refusal path the other three do not have, which is what earns it a file.
 */

/** The client's ring, matching `TAIL_RING_LINES` on the server exactly. */
const MAX_ENTRIES = 2_000;

/**
 * What the strip draws, in the order it happened.
 *
 * Markers are in the same list as the lines rather than beside it, because
 * where a gap fell is the entire information a gap carries. A count in a corner
 * saying "12 lines were dropped" tells a reader nothing about which twelve.
 */
export interface TailEntry {
  key: number;
  kind: "line" | "gap" | "rotated" | "restart";
  text: string;
}

export type TailStatus = "connecting" | "live" | "reconnecting" | "ended";

export interface TailFeed {
  entries: readonly TailEntry[];
  status: TailStatus;
  /** What the server said about the subscription. Null until the first frame. */
  ready: TailReady | null;
  /**
   * A host that answered badly without the stream giving up — one failed poll,
   * a dropped packet. Cleared by the next line that arrives.
   *
   * It can therefore go stale on a log that is both failing and quiet, and the
   * window is bounded rather than unbounded: the server gives up after ten
   * consecutive failures, which at the poll interval is about seven seconds,
   * and giving up is a `fatal` that ends the stream and says so.
   */
  warning: string | null;
  /** Why the stream is over, when `status` is `ended`. */
  ended: string | null;
  /** Lines received on this connection, for the header's count. */
  received: number;
}

const EMPTY: TailFeed = {
  entries: [],
  status: "connecting",
  ready: null,
  warning: null,
  ended: null,
  received: 0,
};

/**
 * @param attempt Bumped by the caller to open the stream again after it ended.
 *
 * A number rather than a `retry()` the hook hands back, because reopening a
 * connection is exactly "run the effect again" and the effect already knows how
 * to tear the old one down. A callback would need its own copy of that.
 */
export function useTail(hostId: string | null, path: string | null, attempt = 0): TailFeed {
  const [feed, setFeed] = useState<TailFeed>(EMPTY);

  useEffect(() => {
    if (hostId === null || path === null) {
      setFeed(EMPTY);
      return;
    }

    setFeed(EMPTY);

    // Monotonic and per-connection, which is all a React key has to be. Kept
    // outside the updater deliberately: an updater is not a place to have a
    // side effect, and StrictMode calls each one twice.
    let sequence = 0;
    let closed = false;
    // A `ready` frame is sent on every open, so it is the second one and later
    // that describe a *re*connection. Without this the first would announce
    // itself as one, since a stream with no `Last-Event-ID` to present cannot
    // resume and is honestly reported as not having.
    let connected = false;
    const source = new EventSource(tailStreamUrl(hostId, path), { withCredentials: true });

    const append = (added: readonly Omit<TailEntry, "key">[], lines: number): void => {
      const keyed = added.map((entry) => ({ ...entry, key: sequence++ }));
      setFeed((current) => {
        const entries = [...current.entries, ...keyed];
        return {
          ...current,
          entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries,
          received: current.received + lines,
          // Any line at all is the host answering, which is what the warning
          // was about.
          warning: lines > 0 ? null : current.warning,
        };
      });
    };

    const parse = <T>(event: MessageEvent<string>): T | null => {
      // `event.data` is absent on a DOM event that merely shares a name with an
      // SSE one, which is the `error` collision below. Checked here rather than
      // there so every listener is covered by the same rule.
      if (typeof event.data !== "string") return null;

      try {
        return JSON.parse(event.data) as T;
      } catch {
        // A frame this app cannot read is not a reason to tear down a stream
        // that is otherwise delivering. It is dropped, and the next one is
        // given the same chance.
        return null;
      }
    };

    source.addEventListener("ready", (event: MessageEvent<string>) => {
      const ready = parse<TailReady>(event);
      if (ready === null) return;

      // A reconnection the server could not carry on from is a different
      // position in the file, not a continuation: what follows is a fresh
      // backfill, and keeping the lines already on screen would have it repeat
      // them underneath. So the buffer goes and a marker says why, which is
      // the honest version of what the reader is about to see.
      const restarted = connected && !ready.resumed;
      connected = true;

      setFeed((current) => ({
        ...current,
        status: "live",
        ready,
        warning: null,
        ended: null,
        entries: restarted ? [] : current.entries,
      }));

      if (restarted) {
        append([{ kind: "restart", text: "reconnected — the stream restarted from the end of the file" }], 0);
      }
    });

    source.addEventListener("lines", (event: MessageEvent<string>) => {
      const frame = parse<TailLines>(event);
      if (frame === null || frame.lines.length === 0) return;
      append(
        frame.lines.map((text) => ({ kind: "line" as const, text })),
        frame.lines.length,
      );
    });

    source.addEventListener("gap", (event: MessageEvent<string>) => {
      const frame = parse<TailGap>(event);
      if (frame === null) return;
      const why =
        frame.reason === "truncated-line"
          ? `${frame.dropped} line${frame.dropped === 1 ? "" : "s"} cut short — too long to render`
          : `${frame.dropped} line${frame.dropped === 1 ? "" : "s"} dropped — this tab fell behind`;
      append([{ kind: "gap", text: why }], 0);
    });

    source.addEventListener("rotated", (event: MessageEvent<string>) => {
      if (parse<TailRotated>(event) === null) return;
      append([{ kind: "rotated", text: "the file rotated — following the new one" }], 0);
    });

    // Named `error` on the wire, which collides with `EventSource`'s own DOM
    // error event — both are dispatched as `error` on this object, and there is
    // nothing in the spec that keeps them apart. `parse` is what separates
    // them: only the SSE frame carries `data`. The connection's own errors are
    // `onerror`'s below, and both handlers run on a failure.
    source.addEventListener("error", (event: MessageEvent<string>) => {
      const frame = parse<TailError>(event);
      if (frame === null) return;

      if (!frame.fatal) {
        setFeed((current) => ({ ...current, warning: frame.message }));
        return;
      }

      // The server ends the response after a fatal error, and a response that
      // ends cleanly is one `EventSource` reconnects to — which would restart
      // the tail against the host that just gave up, for ever. Closing it here
      // is what makes "giving up" mean it.
      closed = true;
      source.close();
      setFeed((current) => ({ ...current, status: "ended", ended: frame.message }));
    });

    source.onerror = () => {
      if (closed) return;

      // `CONNECTING` means the browser intends to retry, which is its business
      // and not ours — the same position the other three streams take. What is
      // ours is saying so, because a tail that has quietly stopped arriving
      // looks exactly like a log nobody is writing to.
      if (source.readyState === EventSource.CONNECTING) {
        setFeed((current) => (current.status === "ended" ? current : { ...current, status: "reconnecting" }));
        return;
      }

      // `CLOSED` is the spec's "fail the connection": the response was not 200
      // `text/event-stream`, so the browser will not retry and there is a real
      // refusal behind it. It cannot tell us which one, so we ask.
      closed = true;
      source.close();
      setFeed((current) => ({ ...current, status: "ended", ended: "The tail was refused." }));
      void diagnoseTail(hostId, path).then((message) => {
        setFeed((current) => (current.status === "ended" ? { ...current, ended: message } : current));
      });
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [hostId, path, attempt]);

  return feed;
}
