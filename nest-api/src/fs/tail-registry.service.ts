import { ConflictException, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { HostDriver } from "@hosts/drivers/host-driver";
import {
  MAX_TAILS_PER_HOST,
  MAX_TAILS_PER_SESSION,
  TAIL_LINGER_MS,
  TAIL_RING_LINES,
  TAIL_SUBSCRIBER_BUFFER_BYTES,
} from "@fs/tail-limits";
import { CLOSED_BY_LAST_SUBSCRIBER, CLOSED_BY_SHUTDOWN } from "@fs/tail-signals";
import { ExecTailSource, PollTailSource, type TailSource, type TailSourceArgs } from "@fs/tail-source";

/**
 * Who is tailing what, and the one process behind each file (TRE-34 §2).
 *
 * Unlike `ScanEventsService` and its siblings this is not a fan-out over work
 * happening elsewhere — the work *is* here, and its lifetime is exactly the
 * lifetime of the subscribers. That inversion is the ticket: "the process ends
 * when the SSE connection closes. Every one of them, including the ones that
 * closed because the browser was killed."
 *
 * Same single-process assumption as the other three, stated for the same
 * reason: a second API process would need a shared bus as well as shared state,
 * and neither is a small change.
 */

/**
 * The SSE vocabulary, in one place.
 *
 * `ready` is written by the controller rather than by the registry — it
 * describes the subscription that was just granted, which is the one fact the
 * registry returns instead of emitting — but it belongs in this union because
 * the union is the protocol, and a client reading it wants all five names
 * together.
 */
export type TailFrameName = "ready" | "lines" | "gap" | "rotated" | "error";

export interface TailFrame {
  event: TailFrameName;
  data: unknown;
  /** The absolute index of the last line in the frame, for `Last-Event-ID`. */
  id?: number;
}

/**
 * One open stream, as the registry sees it.
 *
 * Deliberately not an Express `Response`. The drop policy needs one number and
 * the fan-out needs one verb, and stating them as an interface is what lets the
 * spec drive a hundred subscribers without a socket in sight.
 */
export interface TailSubscriber {
  /** Bytes queued in this client's socket and not yet flushed to the network. */
  bufferedBytes(): number;
  send(frame: TailFrame): void;
  end(): void;
}

export interface SubscribeArgs {
  driver: HostDriver;
  hostId: string;
  realPath: string;
  sessionId: string;
  initialLines: number;
  /** From `Last-Event-ID`. The client has everything up to and including this. */
  lastEventId: number | null;
  subscriber: TailSubscriber;
  preferExec: boolean;
}

export interface Subscription {
  /** True when this stream joined a source that was already running. */
  shared: boolean;
  /** True when the ring could carry on from where this client left off. */
  resumed: boolean;
  source: "tail" | "poll";
  unsubscribe: () => void;
}

interface Held {
  id: string;
  subscriber: TailSubscriber;
  dropped: number;
  wantsGap: boolean;
}

interface TailEntry {
  key: string;
  hostId: string;
  realPath: string;
  source: TailSource;
  controller: AbortController;
  subscribers: Map<string, Held>;
  /** The last `TAIL_RING_LINES` lines, for a second tab and for a reconnect. */
  ring: string[];
  /** Lines emitted since this entry began, ever. The `id:` on every frame. */
  total: number;
  reaper: NodeJS.Timeout | null;
}

@Injectable()
export class TailRegistryService implements OnModuleDestroy {
  private readonly logger = new Logger(TailRegistryService.name);
  private readonly entries = new Map<string, TailEntry>();
  private readonly perSession = new Map<string, number>();
  private nextSubscriberId = 1;

  constructor() {
    // `main.ts` does not call `enableShutdownHooks()`, so `onModuleDestroy`
    // never fires on a `pm2 reload` — see the design note. The poller does not
    // care, but a LOCAL `tail` child would outlive the redeploy, so the
    // registry listens for itself rather than relying on a hook that does not
    // run. Removing this is correct only once that call exists.
    process.once("SIGTERM", this.closeAll);
    process.once("SIGINT", this.closeAll);
  }

  /**
   * Attach to a file, starting a source only if nothing is following it yet.
   *
   * The key is `hostId:realPath` — the **resolved** path, so that a symlink and
   * the file it points at are one entry rather than two processes over one
   * file. It is deliberately not scoped by user: the guard has independently
   * authorised each subscriber for this exact `realPath`, so sharing leaks
   * nothing, and two accounts watching one deploy should cost the host once.
   */
  subscribe(args: SubscribeArgs): Subscription {
    const key = `${args.hostId}:${args.realPath}`;
    const existing = this.entries.get(key);

    if (existing === undefined) this.admitNewEntry(args.hostId);
    this.admitSession(args.sessionId);

    const entry = existing ?? this.open(key, args);
    const shared = existing !== undefined;

    if (entry.reaper !== null) {
      clearTimeout(entry.reaper);
      entry.reaper = null;
    }

    const held: Held = {
      id: String(this.nextSubscriberId++),
      subscriber: args.subscriber,
      dropped: 0,
      wantsGap: false,
    };
    entry.subscribers.set(held.id, held);

    const resumed = shared ? this.replay(entry, held, args) : false;

    return {
      shared,
      resumed,
      source: entry.source.kind,
      unsubscribe: () => this.unsubscribe(key, held.id, args.sessionId),
    };
  }

  /** Live entries, for the specs and for `verify:tail`. */
  count(): number {
    return this.entries.size;
  }

  /** Subscribers on one file, for the specs. */
  watchers(hostId: string, realPath: string): number {
    return this.entries.get(`${hostId}:${realPath}`)?.subscribers.size ?? 0;
  }

  onModuleDestroy(): void {
    this.closeAll();
    // Removed as well as fired: a module torn down and rebuilt — which is every
    // test in this suite — would otherwise leave a listener per instance on a
    // process-wide emitter, and the tenth one warns about a leak that is real.
    process.removeListener("SIGTERM", this.closeAll);
    process.removeListener("SIGINT", this.closeAll);
  }

  // ------------------------------------------------------------------ admission

  private admitNewEntry(hostId: string): void {
    let onHost = 0;
    for (const entry of this.entries.values()) if (entry.hostId === hostId) onHost += 1;
    if (onHost >= MAX_TAILS_PER_HOST) {
      throw new ConflictException(
        `This host already has ${MAX_TAILS_PER_HOST} files being tailed, which is the limit. ` +
          `Close one, or raise TREKKER_TAIL_MAX_PER_HOST.`,
      );
    }
  }

  private admitSession(sessionId: string): void {
    const held = this.perSession.get(sessionId) ?? 0;
    if (held >= MAX_TAILS_PER_SESSION) {
      throw new ConflictException(
        `This session already has ${MAX_TAILS_PER_SESSION} live tails open, which is the limit. ` +
          `Close one, or raise TREKKER_TAIL_MAX_PER_SESSION.`,
      );
    }
    this.perSession.set(sessionId, held + 1);
  }

  // ------------------------------------------------------------------ lifecycle

  private open(key: string, args: SubscribeArgs): TailEntry {
    const controller = new AbortController();
    const entry: TailEntry = {
      key,
      hostId: args.hostId,
      realPath: args.realPath,
      // Assigned below: the source needs a sink that closes over the entry.
      source: undefined as unknown as TailSource,
      controller,
      subscribers: new Map(),
      ring: [],
      total: 0,
      reaper: null,
    };

    const sourceArgs = {
      driver: args.driver,
      realPath: args.realPath,
      initialLines: args.initialLines,
      resumeFrom: null,
      signal: controller.signal,
      sink: {
        onLines: (lines: string[], truncated: number) => this.publish(entry, lines, truncated),
        onRotated: () => this.broadcast(entry, { event: "rotated", data: { at: Date.now() } }),
        onError: (message: string, fatal: boolean) => {
          this.broadcast(entry, { event: "error", data: { message, fatal } });
          if (fatal) this.closeEntry(entry, CLOSED_BY_LAST_SUBSCRIBER, true);
        },
      },
    };

    entry.source = this.createSource(sourceArgs, args.preferExec);
    this.entries.set(key, entry);
    entry.source.start();
    return entry;
  }

  /**
   * Which source an entry gets, as a seam rather than a `new` in the middle of
   * `open`.
   *
   * The spec needs to push lines through the fan-out without a host on the
   * other end, and the alternative was reaching into a private map to find the
   * sink — a test that breaks when a field is renamed and proves nothing about
   * the rename. Overriding one method is honest about what is being replaced.
   */
  protected createSource(args: TailSourceArgs, preferExec: boolean): TailSource {
    return preferExec ? new ExecTailSource(args) : new PollTailSource(args);
  }

  /**
   * The heart of the ticket, and it is two clocks rather than one.
   *
   * The **source** stops the instant the last subscriber leaves — no grace, no
   * delay — which is what makes `ps` on the host clean while the tab is still
   * animating shut. The **entry** then lingers, holding nothing but its ring,
   * its total and a timer, so that an `EventSource` reconnecting three seconds
   * later resumes instead of re-reading and showing the reader the same lines
   * twice.
   */
  private unsubscribe(key: string, subscriberId: string, sessionId: string): void {
    const held = this.perSession.get(sessionId);
    if (held !== undefined) {
      if (held <= 1) this.perSession.delete(sessionId);
      else this.perSession.set(sessionId, held - 1);
    }

    const entry = this.entries.get(key);
    if (entry === undefined) return;

    entry.subscribers.delete(subscriberId);
    if (entry.subscribers.size > 0) return;

    entry.controller.abort(CLOSED_BY_LAST_SUBSCRIBER);

    entry.reaper = setTimeout(() => this.entries.delete(key), TAIL_LINGER_MS);
    entry.reaper.unref();
  }

  private closeEntry(entry: TailEntry, reason: string, drop: boolean): void {
    entry.controller.abort(reason);
    if (entry.reaper !== null) clearTimeout(entry.reaper);
    entry.reaper = null;
    for (const held of entry.subscribers.values()) held.subscriber.end();
    entry.subscribers.clear();
    if (drop) this.entries.delete(entry.key);
  }

  private readonly closeAll = (): void => {
    if (this.entries.size > 0) this.logger.log(`Stopping ${this.entries.size} live tail(s)`);
    for (const entry of [...this.entries.values()]) this.closeEntry(entry, CLOSED_BY_SHUTDOWN, true);
    this.perSession.clear();
  };

  // ------------------------------------------------------------------ delivery

  /**
   * Ring first, then fan out.
   *
   * The order matters: the ring is what a second tab and a reconnecting tab
   * replay from, so a line dropped from one slow socket is still available to
   * everyone else and to that same client when it catches up. Dropping is a
   * property of one connection, never of the data.
   */
  private publish(entry: TailEntry, lines: string[], truncated: number): void {
    entry.ring.push(...lines);
    if (entry.ring.length > TAIL_RING_LINES) entry.ring = entry.ring.slice(-TAIL_RING_LINES);
    entry.total += lines.length;

    this.broadcast(entry, { event: "lines", data: { lines }, id: entry.total - 1 });

    if (truncated > 0) {
      this.broadcast(entry, { event: "gap", data: { dropped: truncated, reason: "truncated-line" } });
    }
  }

  /**
   * Write to every subscriber that can still take it, and to no others.
   *
   * `res.write()` never blocks — it buffers — so a backgrounded tab whose socket
   * has stopped draining would grow an unbounded queue inside this process. The
   * cap is checked *before* writing, and `bufferedBytes()` is Node's own count
   * of what is sitting in that socket: the honest measure of "not keeping up",
   * free to read, and needing no queue of ours to grow alongside it.
   *
   * The gap marker is emitted on the next write that succeeds, never at the
   * moment of dropping — a frame written to a socket already over its cap is
   * the one frame guaranteed not to arrive. Emitting on recovery also gives one
   * marker per burst rather than one per dropped batch.
   */
  private broadcast(entry: TailEntry, frame: TailFrame): void {
    for (const held of entry.subscribers.values()) {
      try {
        if (held.subscriber.bufferedBytes() > TAIL_SUBSCRIBER_BUFFER_BYTES) {
          held.dropped += countOf(frame);
          held.wantsGap = true;
          continue;
        }

        if (held.wantsGap) {
          held.subscriber.send({ event: "gap", data: { dropped: held.dropped, reason: "slow-client" } });
          held.dropped = 0;
          held.wantsGap = false;
        }

        held.subscriber.send(frame);
      } catch {
        // A socket that died between the check and the write. Its own `close`
        // handler removes it; one broken stream must not stop the others being
        // told, nor abandon the source's own read loop.
      }
    }
  }

  /**
   * What a joining or reconnecting client gets before the live lines start.
   *
   * Returns whether the ring could genuinely carry on from where this client
   * left off — which is what makes the reconnect indicator honest rather than
   * decorative. When it could not, a gap frame says so before the replay.
   */
  private replay(entry: TailEntry, held: Held, args: SubscribeArgs): boolean {
    const firstIndex = entry.total - entry.ring.length;

    if (args.lastEventId === null) {
      const lines = entry.ring.slice(-args.initialLines);
      if (lines.length > 0) held.subscriber.send({ event: "lines", data: { lines }, id: entry.total - 1 });
      return false;
    }

    // An entry with no history at all is one that was created for this very
    // subscription — the linger elapsed and the old one was reaped. A client
    // presenting an id cannot have got it from *this* incarnation, and the
    // sequence is about to start again at zero, so what follows is a fresh
    // backfill and not a resume. Without this the ordinary case of a laptop
    // closed for a minute reports `resumed` and the strip keeps the lines it
    // already had, which the backfill then repeats underneath them.
    if (entry.total === 0) return false;

    const wantFrom = args.lastEventId + 1;
    if (wantFrom >= entry.total) return true;

    if (wantFrom < firstIndex) {
      // The ring rolled past what this client had. Say so rather than letting
      // the lines simply not be there.
      held.subscriber.send({
        event: "gap",
        data: { dropped: firstIndex - wantFrom, reason: "slow-client" },
      });
      const lines = entry.ring.slice();
      if (lines.length > 0) held.subscriber.send({ event: "lines", data: { lines }, id: entry.total - 1 });
      return false;
    }

    const lines = entry.ring.slice(wantFrom - firstIndex);
    if (lines.length > 0) held.subscriber.send({ event: "lines", data: { lines }, id: entry.total - 1 });
    return true;
  }
}

function countOf(frame: TailFrame): number {
  const data = frame.data as { lines?: string[] } | undefined;
  return data?.lines?.length ?? 1;
}
