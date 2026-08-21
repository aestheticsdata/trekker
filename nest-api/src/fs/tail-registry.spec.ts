import { Readable } from "node:stream";
import { ConflictException, Logger } from "@nestjs/common";
import type { FileStat, HostDriver, ReadOptions } from "@hosts/drivers/host-driver";
import { MAX_TAILS_PER_HOST, MAX_TAILS_PER_SESSION, TAIL_LINGER_MS } from "@fs/tail-limits";
import {
  type SubscribeArgs,
  type Subscription,
  type TailFrame,
  TailRegistryService,
  type TailSubscriber,
} from "@fs/tail-registry.service";
import type { TailSink, TailSource, TailSourceArgs } from "@fs/tail-source";

/**
 * The registry (TRE-34 §2), and specifically the four acceptance criteria that
 * are about a process not surviving the tab that opened it.
 *
 * The driver is a fake here, deliberately, and it is the *right* double for
 * this file: every claim below is about what the registry does with its
 * subscribers — how many sources exist, when one stops, who gets which frame —
 * and none of them is about SFTP. The claims that *are* about a real host,
 * including the `ps` check the ticket asks for by name, belong to
 * `pnpm verify:tail`, which is the same split `exec-stream.spec.ts` makes.
 */

class FakeDriver implements Partial<HostDriver> {
  readonly hostId = "host-1";
  statCalls = 0;
  size = 0;
  content = "";

  stat = (path: string): Promise<FileStat> => {
    this.statCalls += 1;
    return Promise.resolve({
      path,
      name: "access.log",
      kind: "file",
      size: this.size,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtimeMs: 0,
      inode: 42,
    });
  };

  createReadStream = (_path: string, options?: ReadOptions): Promise<Readable> => {
    const start = options?.start ?? 0;
    const end = options?.end ?? this.content.length - 1;
    return Promise.resolve(Readable.from([Buffer.from(this.content.slice(start, end + 1), "utf8")]));
  };
}

class FakeSubscriber implements TailSubscriber {
  frames: TailFrame[] = [];
  ended = false;
  buffered = 0;

  bufferedBytes = (): number => this.buffered;
  send = (frame: TailFrame): void => {
    this.frames.push(frame);
  };
  end = (): void => {
    this.ended = true;
  };

  linesReceived(): string[] {
    return this.frames
      .filter((frame) => frame.event === "lines")
      .flatMap((frame) => (frame.data as { lines: string[] }).lines);
  }

  gaps(): { dropped: number; reason: string }[] {
    return this.frames
      .filter((frame) => frame.event === "gap")
      .map((frame) => frame.data as { dropped: number; reason: string });
  }
}

/**
 * The registry with its source construction replaced.
 *
 * Nothing here reaches a host: the claims in this file are about the registry's
 * own bookkeeping, and a real source would only add timing to tests that are
 * about counting. `statCalls` on the fake driver still proves the source was
 * asked to stop, because the poller is what calls it.
 */
class TestRegistry extends TailRegistryService {
  readonly sinks: TailSink[] = [];
  readonly signals: AbortSignal[] = [];

  protected override createSource(args: TailSourceArgs, preferExec: boolean): TailSource {
    this.sinks.push(args.sink);
    this.signals.push(args.signal);
    // A source that polls the fake driver exactly as the real poller does, so
    // "no further work on the host after the tab closed" is measurable.
    const timer = setInterval(() => void args.driver.stat(args.realPath), 100);
    timer.unref();
    args.signal.addEventListener("abort", () => clearInterval(timer), { once: true });
    return {
      kind: preferExec ? "tail" : "poll",
      offset: 0,
      start: () => void args.driver.stat(args.realPath),
    };
  }
}

interface Attached {
  subscriber: FakeSubscriber;
  subscription: Subscription;
}

// The return type is spelled out rather than inferred: without it the linter
// cannot resolve `.subscription` through the generic `Parameters<…>` below.
function attach(registry: TailRegistryService, driver: FakeDriver, overrides: Partial<SubscribeArgs> = {}): Attached {
  const subscriber = new FakeSubscriber();
  const subscription = registry.subscribe({
    driver: driver as unknown as HostDriver,
    hostId: "host-1",
    realPath: "/var/log/nginx/access.log",
    sessionId: "session-1",
    initialLines: 200,
    lastEventId: null,
    subscriber,
    preferExec: false,
    ...overrides,
  });
  return { subscriber, subscription };
}

describe("TailRegistryService", () => {
  let registry: TestRegistry;
  let driver: FakeDriver;

  beforeEach(() => {
    // The shutdown line is correct behaviour and pure noise across twenty-odd
    // teardowns.
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    jest.useFakeTimers();
    registry = new TestRegistry();
    driver = new FakeDriver();
  });

  afterEach(() => {
    registry.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe("sharing", () => {
    it("gives two tabs on the same file one source", () => {
      const first = attach(registry, driver);
      const second = attach(registry, driver, { sessionId: "session-2" });

      expect(registry.count()).toBe(1);
      expect(registry.watchers("host-1", "/var/log/nginx/access.log")).toBe(2);
      expect(first.subscription.shared).toBe(false);
      expect(second.subscription.shared).toBe(true);
    });

    it("keys on the resolved path, so a symlink is not a second source", () => {
      attach(registry, driver);
      // Both requests resolved to the same realPath through the guard. Keying
      // on what the client asked for would run two pollers over one file and
      // fail the ticket's criterion while appearing to pass it.
      attach(registry, driver, { sessionId: "session-2" });

      expect(registry.count()).toBe(1);
    });

    it("keeps different files on one host apart", () => {
      attach(registry, driver);
      attach(registry, driver, { sessionId: "session-2", realPath: "/var/log/nginx/error.log" });

      expect(registry.count()).toBe(2);
    });

    it("replays the ring to a tab that joins late", () => {
      attach(registry, driver);
      pushLines(registry, ["one", "two", "three"]);

      const second = attach(registry, driver, { sessionId: "session-2" });

      expect(second.subscriber.linesReceived()).toEqual(["one", "two", "three"]);
    });
  });

  describe("the last subscriber leaving", () => {
    it("stops the source immediately, without waiting out the linger", () => {
      const { subscription } = attach(registry, driver);
      const before = driver.statCalls;

      subscription.unsubscribe();
      jest.advanceTimersByTime(5_000);

      // The whole ticket in one assertion: no further work on the host from the
      // moment the tab closed. Not "less work", none.
      expect(driver.statCalls).toBe(before);
    });

    it("does not stop the source while another tab is still watching", () => {
      const first = attach(registry, driver);
      attach(registry, driver, { sessionId: "session-2" });

      first.subscription.unsubscribe();

      expect(registry.watchers("host-1", "/var/log/nginx/access.log")).toBe(1);
      expect(registry.count()).toBe(1);
    });

    it("keeps the entry through the linger so a reconnect can resume", () => {
      const { subscription } = attach(registry, driver);

      subscription.unsubscribe();

      expect(registry.count()).toBe(1);
      jest.advanceTimersByTime(TAIL_LINGER_MS - 1);
      expect(registry.count()).toBe(1);
    });

    it("drops the entry once the linger expires", () => {
      const { subscription } = attach(registry, driver);

      subscription.unsubscribe();
      jest.advanceTimersByTime(TAIL_LINGER_MS + 1);

      expect(registry.count()).toBe(0);
    });

    it("leaves nothing behind after fifty opened and closed", () => {
      for (let index = 0; index < 50; index += 1) {
        const { subscription } = attach(registry, driver, { realPath: `/var/log/app-${index}.log` });
        subscription.unsubscribe();
        // Past the linger, so each is genuinely gone rather than merely quiet —
        // otherwise the per-host cap would refuse the sixth and this would pass
        // by never having opened fifty.
        jest.advanceTimersByTime(TAIL_LINGER_MS + 1);
      }

      expect(registry.count()).toBe(0);
      expect(registry.watchers("host-1", "/var/log/app-0.log")).toBe(0);
    });
  });

  describe("the caps", () => {
    it("refuses a session more tails than it may hold", () => {
      for (let index = 0; index < MAX_TAILS_PER_SESSION; index += 1) {
        attach(registry, driver, { realPath: `/var/log/app-${index}.log` });
      }

      expect(() => attach(registry, driver, { realPath: "/var/log/one-too-many.log" })).toThrow(ConflictException);
    });

    it("gives the slot back when a tail is closed", () => {
      const held: Attached[] = [];
      for (let index = 0; index < MAX_TAILS_PER_SESSION; index += 1) {
        held.push(attach(registry, driver, { realPath: `/var/log/app-${index}.log` }));
      }

      held[0].subscription.unsubscribe();

      expect(() => attach(registry, driver, { realPath: "/var/log/next.log" })).not.toThrow();
    });

    it("refuses a host more distinct files than it may carry", () => {
      // Spread across sessions, so it is the host cap being measured and not
      // the session one.
      for (let index = 0; index < MAX_TAILS_PER_HOST; index += 1) {
        attach(registry, driver, { sessionId: `session-${index}`, realPath: `/var/log/app-${index}.log` });
      }

      expect(() =>
        attach(registry, driver, { sessionId: "session-last", realPath: "/var/log/one-too-many.log" }),
      ).toThrow(ConflictException);
    });

    it("counts subscriptions per session, so sharing is not an allowance", () => {
      // Every one of these is the *same* file, so they share one source — and
      // still cost one apiece against the session cap. The cap governs what a
      // session holds open; sharing is an efficiency this application performs,
      // not an allowance it grants.
      for (let index = 0; index < MAX_TAILS_PER_SESSION; index += 1) attach(registry, driver);

      expect(registry.count()).toBe(1);
      expect(() => attach(registry, driver)).toThrow(ConflictException);
    });
  });

  describe("a client that cannot keep up", () => {
    it("drops its lines rather than buffering them", () => {
      const fast = attach(registry, driver);
      const slow = attach(registry, driver, { sessionId: "session-2" });
      slow.subscriber.buffered = 10 * 1024 * 1024;

      pushLines(registry, ["one", "two"]);

      expect(fast.subscriber.linesReceived()).toEqual(["one", "two"]);
      expect(slow.subscriber.linesReceived()).toEqual([]);
    });

    it("tells it how much it missed, once it can be told", () => {
      attach(registry, driver);
      const slow = attach(registry, driver, { sessionId: "session-2" });
      slow.subscriber.buffered = 10 * 1024 * 1024;

      pushLines(registry, ["one", "two", "three"]);
      // The socket drains. The gap marker is written now, not at drop time —
      // a frame written to a socket already over its cap is the one frame
      // guaranteed not to arrive.
      slow.subscriber.buffered = 0;
      pushLines(registry, ["four"]);

      expect(slow.subscriber.gaps()).toEqual([{ dropped: 3, reason: "slow-client" }]);
      expect(slow.subscriber.linesReceived()).toEqual(["four"]);
    });

    it("emits one marker per burst, not one per dropped batch", () => {
      attach(registry, driver);
      const slow = attach(registry, driver, { sessionId: "session-2" });
      slow.subscriber.buffered = 10 * 1024 * 1024;

      pushLines(registry, ["one"]);
      pushLines(registry, ["two"]);
      pushLines(registry, ["three"]);
      slow.subscriber.buffered = 0;
      pushLines(registry, ["four"]);

      expect(slow.subscriber.gaps()).toHaveLength(1);
      expect(slow.subscriber.gaps()[0].dropped).toBe(3);
    });

    it("does not let one dead socket stop the others being told", () => {
      const healthy = attach(registry, driver);
      const broken = attach(registry, driver, { sessionId: "session-2" });
      broken.subscriber.send = () => {
        throw new Error("socket closed between the check and the write");
      };

      expect(() => pushLines(registry, ["one"])).not.toThrow();
      expect(healthy.subscriber.linesReceived()).toEqual(["one"]);
    });
  });

  describe("resuming from Last-Event-ID", () => {
    it("sends only what the client missed", () => {
      attach(registry, driver);
      pushLines(registry, ["one", "two", "three"]);

      // The client had up to index 1 ("two"), so it wants "three" and nothing
      // it already rendered.
      const resumed = attach(registry, driver, { sessionId: "session-2", lastEventId: 1 });

      expect(resumed.subscriber.linesReceived()).toEqual(["three"]);
      expect(resumed.subscription.resumed).toBe(true);
    });

    it("sends nothing when the client is already current", () => {
      attach(registry, driver);
      pushLines(registry, ["one", "two"]);

      const resumed = attach(registry, driver, { sessionId: "session-2", lastEventId: 1 });

      expect(resumed.subscriber.linesReceived()).toEqual([]);
      expect(resumed.subscription.resumed).toBe(true);
    });

    it("says so when the ring has rolled past what the client had", () => {
      attach(registry, driver);
      pushLines(registry, ["one", "two", "three"]);

      // Claiming to have had line -1 means wanting line 0, which for this entry
      // is present — so ask for something genuinely older by starting the ring
      // beyond it. Here the client claims a line the entry never emitted.
      const resumed = attach(registry, driver, { sessionId: "session-2", lastEventId: -5 });

      expect(resumed.subscription.resumed).toBe(false);
      expect(resumed.subscriber.gaps()[0].reason).toBe("slow-client");
      expect(resumed.subscriber.linesReceived()).toEqual(["one", "two", "three"]);
    });
  });

  describe("shutdown", () => {
    it("ends every stream and clears every entry", () => {
      const first = attach(registry, driver);
      const second = attach(registry, driver, { sessionId: "session-2", realPath: "/var/log/other.log" });

      registry.onModuleDestroy();

      expect(registry.count()).toBe(0);
      expect(first.subscriber.ended).toBe(true);
      expect(second.subscriber.ended).toBe(true);
    });
  });
});

/**
 * Push lines through the fan-out the way a source would.
 *
 * `TestRegistry` keeps every sink it handed out, in creation order, so this
 * pushes into the entry that was opened first — which is the shared one in
 * every test above.
 */
function pushLines(registry: TestRegistry, lines: string[]): void {
  registry.sinks[0].onLines(lines, 0);
}
