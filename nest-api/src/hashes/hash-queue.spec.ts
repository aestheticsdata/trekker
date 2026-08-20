import { HashQueueService } from "@hashes/hash-queue.service";
import { MAX_JOBS_IN_FLIGHT } from "@hashes/hash-limits";
import { CANCELLED_BY_SHUTDOWN, CANCELLED_BY_USER } from "@hashes/hash-signals";

import type { HashJob, HashRunnerService } from "@hashes/hash-runner.service";

/**
 * What runs, what waits, and who may stop it (TRE-27).
 *
 * There is no boot sweep to test here and that absence is the design: a hash
 * job is never a row, so a restart leaves nothing behind to reap. What is worth
 * pinning instead is the ownership check on cancel — a queue that answered "not
 * yours" rather than "no such job" would confirm another account's job ids one
 * guess at a time.
 */

function job(over: Partial<HashJob> = {}): HashJob {
  return {
    id: "job-1",
    hostId: "host-1",
    userId: "user-1",
    targets: [{ path: "/srv/a", size: 10n, mtimeMs: 1n }],
    bytesTotal: 10n,
    ...over,
  };
}

/** A runner whose jobs finish only when the spec says so. */
class FakeRunner {
  readonly started: Array<{ job: HashJob; signal: AbortSignal }> = [];
  private readonly finishers: Array<() => void> = [];

  run = (target: HashJob, signal: AbortSignal): Promise<void> => {
    this.started.push({ job: target, signal });
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
  const runner = new FakeRunner();
  const queue = new HashQueueService(runner as unknown as HashRunnerService);
  return { runner, queue };
}

describe("what runs at once", () => {
  it("runs up to the in-flight cap and holds the rest", () => {
    const { runner, queue } = build();

    for (let index = 0; index < MAX_JOBS_IN_FLIGHT + 2; index += 1) {
      queue.enqueue(job({ id: `job-${index}` }));
    }

    expect(runner.started).toHaveLength(MAX_JOBS_IN_FLIGHT);
  });

  it("starts a waiting job as soon as a slot frees", async () => {
    const { runner, queue } = build();

    for (let index = 0; index < MAX_JOBS_IN_FLIGHT + 1; index += 1) {
      queue.enqueue(job({ id: `job-${index}` }));
    }
    await runner.finishAll();

    expect(runner.started).toHaveLength(MAX_JOBS_IN_FLIGHT + 1);
  });

  it("runs several jobs on one host at once", () => {
    // Unlike a scan, which is one per host: two `du`s walking one filesystem
    // fight each other, and two `sha256sum`s over different files do not. Both
    // panes hashing on the same machine is an ordinary thing to ask for.
    const { runner, queue } = build();

    queue.enqueue(job({ id: "a" }));
    queue.enqueue(job({ id: "b" }));

    expect(runner.started.map((entry) => entry.job.id)).toEqual(["a", "b"]);
  });
});

describe("what the POST is told", () => {
  it("says a job with a free slot is not waiting", () => {
    // `pump` is synchronous, so this job is already reading by the time
    // `enqueue` returns. Reporting it as queued would have the panel showing
    // "waiting for a slot" over a job that is not waiting for anything.
    const { queue } = build();

    expect(queue.enqueue(job())).toMatchObject({ queued: false, files: 1 });
  });

  it("says a job over the cap is waiting", () => {
    const { queue } = build();
    for (let index = 0; index < MAX_JOBS_IN_FLIGHT; index += 1) {
      queue.enqueue(job({ id: `filler-${index}` }));
    }

    expect(queue.enqueue(job({ id: "last" }))).toMatchObject({ queued: true });
  });
});

describe("stopping one", () => {
  it("aborts a running job with the user's reason", () => {
    const { runner, queue } = build();
    queue.enqueue(job());

    expect(queue.cancel("user-1", "job-1")).toBe("running");
    expect(runner.started[0].signal.reason).toBe(CANCELLED_BY_USER);
  });

  it("drops a job that had not started, and says so", () => {
    // The caller needs the difference: a waiting job has no runner to write its
    // terminal frame, so nothing else will ever mention it again.
    const { runner, queue } = build();
    for (let index = 0; index < MAX_JOBS_IN_FLIGHT + 1; index += 1) {
      queue.enqueue(job({ id: `job-${index}` }));
    }

    expect(queue.cancel("user-1", `job-${MAX_JOBS_IN_FLIGHT}`)).toBe("waiting");
    expect(runner.started.map((entry) => entry.job.id)).not.toContain(`job-${MAX_JOBS_IN_FLIGHT}`);
  });

  it("answers another account exactly as it answers a made-up id", () => {
    // The security property. "Not yours" and "no such job" have to be the same
    // answer, or the route is an oracle over other people's job ids.
    const { runner, queue } = build();
    queue.enqueue(job());

    expect(queue.cancel("user-2", "job-1")).toBe("unknown");
    expect(queue.cancel("user-1", "job-nonexistent")).toBe("unknown");
    expect(runner.started[0].signal.aborted).toBe(false);
  });
});

describe("what a shutdown does", () => {
  it("aborts everything running with the shutdown reason", () => {
    const { runner, queue } = build();
    queue.enqueue(job());

    queue.onModuleDestroy();

    expect(runner.started[0].signal.reason).toBe(CANCELLED_BY_SHUTDOWN);
  });

  it("accepts nothing after it", () => {
    const { runner, queue } = build();

    queue.onModuleDestroy();
    queue.enqueue(job());

    expect(runner.started).toHaveLength(0);
  });
});

describe("what the inspector asks", () => {
  it("finds the job that is going to hash this path", () => {
    const { queue } = build();
    queue.enqueue(job({ targets: [{ path: "/srv/a", size: 1n, mtimeMs: 1n }] }));

    expect(queue.covering("user-1", "host-1", "/srv/a")?.id).toBe("job-1");
  });

  it("does not offer a job that is hashing something else", () => {
    // A panel told "computing…" by a job that will never mention this file is a
    // panel waiting for a frame that is not coming.
    const { queue } = build();
    queue.enqueue(job({ targets: [{ path: "/var/log/x", size: 1n, mtimeMs: 1n }] }));

    expect(queue.covering("user-1", "host-1", "/srv/a")).toBeNull();
  });

  it("does not show one account another's job", () => {
    const { queue } = build();
    queue.enqueue(job());

    expect(queue.covering("user-2", "host-1", "/srv/a")).toBeNull();
  });

  it("marks a job that is still in line as queued", () => {
    const { queue } = build();
    for (let index = 0; index < MAX_JOBS_IN_FLIGHT; index += 1) {
      queue.enqueue(job({ id: `filler-${index}`, targets: [{ path: `/f/${index}`, size: 1n, mtimeMs: 1n }] }));
    }
    queue.enqueue(job({ id: "waiting" }));

    expect(queue.covering("user-1", "host-1", "/srv/a")).toMatchObject({ id: "waiting", queued: true });
  });
});
