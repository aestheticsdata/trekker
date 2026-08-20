import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { DriverError } from "@hosts/drivers/driver-error";
import { HashEventsService, type HashProgress } from "@hashes/hash-events.service";
import { type HashJob, HashRunnerService, type HashTarget } from "@hashes/hash-runner.service";
import { PROGRESS_TICK_MS } from "@hashes/hash-limits";
import { CANCELLED_BY_USER } from "@hashes/hash-signals";

import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { ExecStream } from "@hosts/drivers/host-driver";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * One checksum job, end to end (TRE-27).
 *
 * Four claims the ticket makes, each of which is a wrong answer waiting to
 * happen:
 *
 *   - the hashing runs **on the host**, and only crosses the network when the
 *     host cannot do it — the difference between seconds and an afternoon;
 *   - the fallback produces the **same digest**, and the answer says which one
 *     ran, because a checksum nobody can trace the provenance of is one nobody
 *     can act on;
 *   - the cache **invalidates itself**, because a stale hash is worse than no
 *     hash — it is the one output somebody would trust without checking;
 *   - a cancelled job **keeps what it earned**, which is the whole reason a
 *     digest is written per file rather than in a terminal transaction.
 */

const USER = "user-1";
const HOST = "host-1";

function target(path: string, size = 4n, mtimeMs = 100n): HashTarget {
  return { path, size, mtimeMs };
}

function job(over: Partial<HashJob> = {}): HashJob {
  const targets = over.targets ?? [target("/srv/a")];
  return {
    id: "job-1",
    hostId: HOST,
    userId: USER,
    targets,
    bytesTotal: targets.reduce((sum, entry) => sum + entry.size, 0n),
    ...over,
  };
}

/** The digest the fake host would report, so both routes can be compared. */
function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface HostShape {
  /** Path → contents. A path missing from this is a file that cannot be read. */
  files: Record<string, string>;
  /** No `sha256sum` on this machine, so only the streamed route can work. */
  noSha256sum?: boolean;
  /** `sha256sum` is there and refuses. */
  execFails?: boolean;
  /** Hold every read open until the spec lets it go, so a tick can be forced. */
  gated?: boolean;
}

class FakeDriver {
  readonly hostId = HOST;
  readonly execCalls: string[][] = [];
  readonly reads: string[] = [];
  disposed = false;
  /** Settles once a read has been asked for, so a spec can wait for that moment. */
  readonly reached: Promise<void>;
  private announce!: () => void;
  private open!: () => void;
  private readonly gate: Promise<void>;

  constructor(private readonly shape: HostShape) {
    this.reached = new Promise<void>((resolve) => {
      this.announce = resolve;
    });
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  execStream = (program: string, args: readonly string[]): Promise<ExecStream> => {
    this.execCalls.push([program, ...args]);
    const paths = args.filter((argument) => argument !== "--");

    if (this.shape.noSha256sum) {
      // How it arrives over SSH: the remote shell could not find it.
      return Promise.resolve({
        stdout: Readable.from([]),
        done: Promise.resolve({ code: 127, signal: null, stderr: "sha256sum: not found", stderrTruncated: false }),
      });
    }
    if (this.shape.execFails) {
      return Promise.resolve({
        stdout: Readable.from([]),
        done: Promise.resolve({ code: 1, signal: null, stderr: "refused", stderrTruncated: false }),
      });
    }

    const lines = paths
      .filter((path) => this.shape.files[path] !== undefined)
      .map((path) => `${digestOf(this.shape.files[path])}  ${path}`)
      .join("\n");

    return Promise.resolve({
      stdout: Readable.from([Buffer.from(lines.length > 0 ? `${lines}\n` : "", "utf8")]),
      done: Promise.resolve({ code: 0, signal: null, stderr: "", stderrTruncated: false }),
    });
  };

  createReadStream = async (path: string): Promise<Readable> => {
    this.reads.push(path);
    this.announce();
    if (this.shape.gated) await this.gate;

    const content = this.shape.files[path];
    if (content === undefined) throw new DriverError("ENOENT", "gone");
    // Two pieces, so the digest is genuinely folded rather than hashed whole.
    const half = Math.ceil(content.length / 2);
    return Readable.from([Buffer.from(content.slice(0, half)), Buffer.from(content.slice(half))]);
  };

  /** Let the held read finish. */
  release(): void {
    this.open();
  }

  dispose = (): Promise<void> => {
    this.disposed = true;
    return Promise.resolve();
  };
}

interface Row {
  path: string;
  digest: string;
  size: bigint;
  mtimeMs: bigint;
  method: string;
}

class FakePrisma {
  readonly rows = new Map<string, Row>();
  /** Every upsert, in order — how "written per file" is observed. */
  readonly writes: string[] = [];
  /** Run just before a row lands, so a spec can interrupt the job mid-write. */
  onWrite: ((path: string) => void) | null = null;

  readonly fileHashes = {
    findMany: ({ where }: { where: { hostId: string; path: { in: string[] } } }) =>
      Promise.resolve([...this.rows.values()].filter((row) => where.path.in.includes(row.path))),
    upsert: ({
      where,
      create,
    }: {
      where: { hostId_path: { hostId: string; path: string } };
      create: Row & { hostId: string };
    }) => {
      this.onWrite?.(where.hostId_path.path);
      this.writes.push(where.hostId_path.path);
      this.rows.set(where.hostId_path.path, create);
      return Promise.resolve(create);
    },
  };
}

function build(shape: HostShape) {
  const prisma = new FakePrisma();
  const driver = new FakeDriver(shape);
  const factory = { forHost: () => Promise.resolve(driver) } as unknown as HostDriverFactory;
  const events = new HashEventsService();
  const frames: HashProgress[] = [];
  events.subscribe(USER, (frame) => frames.push(frame));

  const runner = new HashRunnerService(prisma as unknown as PrismaService, factory, events);
  return { prisma, driver, runner, frames };
}

/** The terminal frame — the one the panel settles on. */
function last(frames: readonly HashProgress[]): HashProgress {
  return frames[frames.length - 1];
}

describe("hashing on the host", () => {
  it("runs sha256sum there and stores what it printed", async () => {
    const { prisma, driver, runner, frames } = build({ files: { "/srv/a": "hello" } });

    await runner.run(job(), new AbortController().signal);

    expect(driver.execCalls[0]).toEqual(["sha256sum", "--", "/srv/a"]);
    // Never read across the network when the host could do it in place.
    expect(driver.reads).toEqual([]);
    expect(prisma.rows.get("/srv/a")).toMatchObject({ digest: digestOf("hello"), method: "REMOTE" });
    expect(last(frames)).toMatchObject({ status: "DONE", method: "REMOTE", filesDone: 1, filesFailed: 0 });
  });

  it("records the size and mtime the digest was taken against", async () => {
    // Without these the row is a digest with nothing to invalidate it, and the
    // cache becomes a claim about a file that may not exist any more.
    const { prisma, runner } = build({ files: { "/srv/a": "hello" } });

    await runner.run(job({ targets: [target("/srv/a", 5n, 1234n)] }), new AbortController().signal);

    expect(prisma.rows.get("/srv/a")).toMatchObject({ size: 5n, mtimeMs: 1234n });
  });

  it("counts a file the command could not read and hashes the rest", async () => {
    // One vanished file must not lose the other three hundred. It has no line
    // in the output, which is how it is noticed at all.
    const { prisma, runner, frames } = build({ files: { "/srv/a": "hello" } });

    await runner.run(job({ targets: [target("/srv/a"), target("/srv/gone")] }), new AbortController().signal);

    expect(prisma.rows.has("/srv/a")).toBe(true);
    expect(prisma.rows.has("/srv/gone")).toBe(false);
    expect(last(frames)).toMatchObject({ status: "DONE", filesDone: 1, filesFailed: 1 });
  });
});

describe("the fallback", () => {
  it("streams the bytes here when the host has no sha256sum", async () => {
    const { prisma, driver, runner, frames } = build({ files: { "/srv/a": "hello" }, noSha256sum: true });

    await runner.run(job(), new AbortController().signal);

    expect(driver.reads).toEqual(["/srv/a"]);
    expect(prisma.rows.get("/srv/a")).toMatchObject({ method: "STREAMED" });
    expect(last(frames)).toMatchObject({ status: "DONE", method: "STREAMED", filesDone: 1 });
  });

  it("produces the digest the host would have produced", async () => {
    // The claim the ticket makes about the fallback, and the only one that
    // matters: two routes, one answer. A comparison built on these (TRE-28)
    // would report every cross-host pair as differing if this drifted.
    const remote = build({ files: { "/srv/a": "the same bytes" } });
    const streamed = build({ files: { "/srv/a": "the same bytes" }, noSha256sum: true });

    await remote.runner.run(job(), new AbortController().signal);
    await streamed.runner.run(job(), new AbortController().signal);

    expect(streamed.prisma.rows.get("/srv/a")?.digest).toBe(remote.prisma.rows.get("/srv/a")?.digest);
    expect(streamed.prisma.rows.get("/srv/a")?.digest).toBe(digestOf("the same bytes"));
  });

  it("does not take the slow route when the command merely refused", async () => {
    // A host that refused will refuse again, and reading every file across the
    // network to find that out is the most expensive possible way to fail.
    const { driver, runner, frames } = build({ files: { "/srv/a": "hello" }, execFails: true });

    await runner.run(job(), new AbortController().signal);

    expect(driver.reads).toEqual([]);
    expect(last(frames)).toMatchObject({ status: "DONE", filesFailed: 1 });
  });

  it("carries on past a file it cannot open", async () => {
    const { prisma, runner, frames } = build({ files: { "/srv/b": "kept" }, noSha256sum: true });

    await runner.run(job({ targets: [target("/srv/gone"), target("/srv/b")] }), new AbortController().signal);

    expect(prisma.rows.has("/srv/b")).toBe(true);
    expect(last(frames)).toMatchObject({ status: "DONE", filesDone: 1, filesFailed: 1 });
  });
});

describe("the cache", () => {
  it("does not re-read a file whose size and mtime still match", async () => {
    const { prisma, driver, runner, frames } = build({ files: { "/srv/a": "hello" } });
    prisma.rows.set("/srv/a", {
      path: "/srv/a",
      digest: digestOf("hello"),
      size: 4n,
      mtimeMs: 100n,
      method: "REMOTE",
    });

    await runner.run(job(), new AbortController().signal);

    expect(driver.execCalls).toEqual([]);
    expect(last(frames)).toMatchObject({ status: "DONE", filesDone: 1, filesCached: 1 });
  });

  it("re-reads a file whose mtime moved", async () => {
    // The cheap correct answer the ticket asks for. Every ordinary write moves
    // the mtime, so this is the branch that keeps a stale digest from being
    // served as current.
    const { prisma, driver, runner } = build({ files: { "/srv/a": "changed" } });
    prisma.rows.set("/srv/a", { path: "/srv/a", digest: "stale", size: 4n, mtimeMs: 1n, method: "REMOTE" });

    await runner.run(job({ targets: [target("/srv/a", 4n, 999n)] }), new AbortController().signal);

    expect(driver.execCalls).toHaveLength(1);
    expect(prisma.rows.get("/srv/a")?.digest).toBe(digestOf("changed"));
  });

  it("re-reads a file whose size changed under an unchanged mtime", async () => {
    const { driver, runner, prisma } = build({ files: { "/srv/a": "changed" } });
    prisma.rows.set("/srv/a", { path: "/srv/a", digest: "stale", size: 99n, mtimeMs: 100n, method: "REMOTE" });

    await runner.run(job({ targets: [target("/srv/a", 4n, 100n)] }), new AbortController().signal);

    expect(driver.execCalls).toHaveLength(1);
  });

  it("hashes only the files the cache does not cover", async () => {
    const { prisma, driver, runner, frames } = build({ files: { "/srv/a": "one", "/srv/b": "two" } });
    prisma.rows.set("/srv/a", { path: "/srv/a", digest: digestOf("one"), size: 4n, mtimeMs: 100n, method: "REMOTE" });

    await runner.run(job({ targets: [target("/srv/a"), target("/srv/b")] }), new AbortController().signal);

    expect(driver.execCalls[0]).toEqual(["sha256sum", "--", "/srv/b"]);
    expect(last(frames)).toMatchObject({ filesDone: 2, filesCached: 1 });
  });
});

describe("stopping one", () => {
  it("keeps every digest it had already earned", async () => {
    // The property the whole per-file write exists for. A job stopped after
    // forty of a hundred files has forty true sha256s, and the fact that the
    // rest were interrupted takes nothing away from them.
    const controller = new AbortController();
    const { prisma, runner, frames } = build({ files: { "/srv/a": "one", "/srv/b": "two" }, noSha256sum: true });

    // Cancelled as the first file lands, which is the moment the claim is about.
    prisma.onWrite = () => controller.abort(CANCELLED_BY_USER);

    await runner.run(job({ targets: [target("/srv/a"), target("/srv/b")] }), controller.signal);

    expect(prisma.rows.has("/srv/a")).toBe(true);
    expect(prisma.rows.has("/srv/b")).toBe(false);
    expect(last(frames)).toMatchObject({ status: "CANCELLED" });
  });

  it("reports a job cancelled before it read anything", async () => {
    const controller = new AbortController();
    controller.abort(CANCELLED_BY_USER);
    const { driver, runner, frames } = build({ files: { "/srv/a": "hello" } });

    await runner.run(job(), controller.signal);

    expect(driver.execCalls).toEqual([]);
    expect(last(frames)).toMatchObject({ status: "CANCELLED" });
  });
});

describe("what the feed says", () => {
  it("names the file being read, while it is being read", async () => {
    // The feed emits on a timer rather than per file: a job of four thousand
    // small files would otherwise send four thousand frames to say it is going
    // fine. So the file being read is only ever visible on a tick, and this
    // forces one while a read is held open.
    jest.useFakeTimers();
    try {
      const { driver, runner, frames } = build({ files: { "/srv/a": "hello" }, noSha256sum: true, gated: true });

      const running = runner.run(job(), new AbortController().signal);
      // Microtasks are not faked, so awaiting a real promise still works.
      await driver.reached;
      jest.advanceTimersByTime(PROGRESS_TICK_MS);

      expect(frames.some((frame) => frame.path === "/srv/a" && frame.status === "RUNNING")).toBe(true);

      driver.release();
      await running;
      // Null on the terminal frame: there is nothing being read any more, and a
      // panel left showing the last filename reads as a job still going.
      expect(last(frames).path).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("carries byte counts as strings", async () => {
    // A job can be tens of gigabytes, which outgrows what a double counts
    // exactly. The client formats these and never adds them up.
    const { runner, frames } = build({ files: { "/srv/a": "hello" } });

    await runner.run(job(), new AbortController().signal);

    expect(typeof last(frames).bytesTotal).toBe("string");
    expect(last(frames).bytesDone).toBe("4");
  });

  it("reports a host that could not be reached as failed, with no remote text", async () => {
    const events = new HashEventsService();
    const frames: HashProgress[] = [];
    events.subscribe(USER, (frame) => frames.push(frame));
    const factory = {
      forHost: () => Promise.reject(new DriverError("EUNREACHABLE", "ssh: connect to host prod-db-07 port 22")),
    } as unknown as HostDriverFactory;
    const runner = new HashRunnerService(new FakePrisma() as unknown as PrismaService, factory, events);

    await runner.run(job(), new AbortController().signal);

    expect(last(frames).status).toBe("FAILED");
    // Fixed English chosen from the error's class. The remote message can name
    // a machine the reader has no business seeing in this panel.
    expect(last(frames).error).toBe("The connection to the host dropped while the job was running.");
  });

  it("releases the driver whatever happened", async () => {
    const { driver, runner } = build({ files: {}, execFails: true });

    await runner.run(job(), new AbortController().signal);

    expect(driver.disposed).toBe(true);
  });
});
