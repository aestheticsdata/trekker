import { type QueuedScan, ScanQueueService } from "@scans/scan-queue.service";
import { MAX_SCANS_IN_FLIGHT } from "@scans/scan-limits";
import { CANCELLED_BY_SHUTDOWN, CANCELLED_BY_USER } from "@scans/scan-signals";
import type { ScanRunnerService } from "@scans/scan-runner.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * What runs, and what a restart does to it (TRE-32).
 *
 * The sweep is the case worth the most care, because getting it wrong is not
 * visibly broken: a scan stranded by a deploy keeps `runningSlot`, and that
 * host can then never be scanned again. Nothing reports it. Somebody presses
 * the button, gets a 409 about a scan that has not existed since Tuesday, and
 * has no way to tell why.
 */

function scan(over: Partial<QueuedScan> = {}): QueuedScan {
  return { id: "scan-1", hostId: "host-1", userId: "user-1", root: "/srv", realPath: "/srv", depth: 3, ...over };
}

class FakePrisma {
  swept: Array<Record<string, unknown>> = [];
  throwOnSweep = false;

  readonly diskScans = {
    updateMany: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (this.throwOnSweep) return Promise.reject(new Error("database is down"));
      this.swept.push({ where, data });
      return Promise.resolve({ count: 2 });
    },
  };
}

/** A runner whose scans finish only when the spec says so. */
class FakeRunner {
  readonly started: Array<{ scan: QueuedScan; signal: AbortSignal }> = [];
  private readonly finishers: Array<() => void> = [];

  run = (target: QueuedScan, signal: AbortSignal): Promise<void> => {
    this.started.push({ scan: target, signal });
    return new Promise<void>((resolve) => this.finishers.push(resolve));
  };

  finishAll(): Promise<void> {
    for (const finish of this.finishers.splice(0)) finish();
    // Two turns: one for the runner's promise, one for the `finally` that
    // re-pumps the queue.
    return Promise.resolve().then(() => undefined);
  }
}

function build() {
  const prisma = new FakePrisma();
  const runner = new FakeRunner();
  const queue = new ScanQueueService(prisma as unknown as PrismaService, runner as unknown as ScanRunnerService);
  return { prisma, runner, queue };
}

describe("the boot sweep", () => {
  it("fails every scan a restart stranded and frees its slot", async () => {
    const { prisma, queue } = build();

    await queue.onApplicationBootstrap();

    const sweep = prisma.swept[0] as { where: { status: string }; data: Record<string, unknown> };
    expect(sweep.where.status).toBe("RUNNING");
    // The slot is the point. A stranded row holding it locks the host out of
    // scanning until something nulls it, and nothing else ever would.
    expect(sweep.data).toMatchObject({ status: "FAILED", runningSlot: null });
    expect(sweep.data.error).toMatch(/restarted/i);
  });

  it("does not resume them", async () => {
    // Where this parts company with the transfer queue. A scan stopped halfway
    // produced nothing — entries exist only in the terminal transaction — so
    // there is no state to reconcile, and resuming would start a fresh
    // multi-minute walk on every host that had one, minutes after a deploy.
    const { runner, queue } = build();

    await queue.onApplicationBootstrap();

    expect(runner.started).toHaveLength(0);
  });

  it("lets the module boot when the sweep itself fails", async () => {
    // An API that will not start because it could not tidy up is worse at its
    // job than one that starts untidy. The POST path has its own stale-slot
    // escape for exactly this.
    const { prisma, queue } = build();
    prisma.throwOnSweep = true;

    await expect(queue.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

describe("running", () => {
  it("starts a queued scan immediately when there is room", () => {
    const { runner, queue } = build();

    queue.enqueue(scan());

    expect(runner.started).toHaveLength(1);
    expect(queue.isRunning("host-1")).toBe(true);
  });

  it("holds a scan back past the in-flight cap", () => {
    const { runner, queue } = build();

    for (let index = 0; index < MAX_SCANS_IN_FLIGHT + 2; index += 1) {
      queue.enqueue(scan({ id: `scan-${index}`, hostId: `host-${index}` }));
    }

    expect(runner.started).toHaveLength(MAX_SCANS_IN_FLIGHT);
  });

  it("never runs two on one host, whatever the cap allows", () => {
    const { runner, queue } = build();

    queue.enqueue(scan({ id: "a", hostId: "host-1" }));
    queue.enqueue(scan({ id: "b", hostId: "host-1" }));

    expect(runner.started).toHaveLength(1);
  });

  it("takes the next waiting scan when one finishes", async () => {
    const { runner, queue } = build();

    for (let index = 0; index < MAX_SCANS_IN_FLIGHT + 1; index += 1) {
      queue.enqueue(scan({ id: `scan-${index}`, hostId: `host-${index}` }));
    }
    expect(runner.started).toHaveLength(MAX_SCANS_IN_FLIGHT);

    await runner.finishAll();
    await Promise.resolve();

    expect(runner.started).toHaveLength(MAX_SCANS_IN_FLIGHT + 1);
  });
});

describe("cancelling", () => {
  it("aborts a running scan with the user's reason", () => {
    const { runner, queue } = build();
    queue.enqueue(scan());

    expect(queue.cancel("scan-1")).toBe("running");
    expect(runner.started[0].signal.aborted).toBe(true);
    expect(runner.started[0].signal.reason).toBe(CANCELLED_BY_USER);
  });

  it("drops a scan still waiting in line", () => {
    const { queue } = build();
    for (let index = 0; index < MAX_SCANS_IN_FLIGHT + 1; index += 1) {
      queue.enqueue(scan({ id: `scan-${index}`, hostId: `host-${index}` }));
    }

    expect(queue.cancel(`scan-${MAX_SCANS_IN_FLIGHT}`)).toBe("waiting");
  });

  it("says so about a scan it has never heard of", () => {
    expect(build().queue.cancel("nothing")).toBe("unknown");
  });
});

describe("shutting down", () => {
  it("aborts with the shutdown reason and writes no status", () => {
    // The rows stay RUNNING, which is exactly what the boot sweep looks for.
    const { prisma, runner, queue } = build();
    queue.enqueue(scan());

    queue.onModuleDestroy();

    expect(runner.started[0].signal.reason).toBe(CANCELLED_BY_SHUTDOWN);
    expect(prisma.swept).toHaveLength(0);
  });

  it("refuses to start anything after it", () => {
    const { runner, queue } = build();
    queue.onModuleDestroy();

    queue.enqueue(scan());

    expect(runner.started).toHaveLength(0);
  });
});
