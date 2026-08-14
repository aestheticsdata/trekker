import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { DriverError } from "@hosts/drivers/driver-error";
import { LocalDriver } from "@hosts/drivers/local.driver";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { TransferEventsService } from "@transfers/transfer-events.service";
import { TransferQueueService } from "@transfers/transfer-queue.service";
import { TransferRunnerService } from "@transfers/transfer-runner.service";
import { CANCELLED_BY_SHUTDOWN, CANCELLED_BY_USER } from "@transfers/transfer-signals";
import { type CreateInput, TransferService } from "@transfers/transfer.service";

import type { AuditService } from "@audit/audit.service";
import type { HostDriver } from "@hosts/drivers/host-driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";
import type { Writable } from "node:stream";

/**
 * TRE-23, against the real LocalDriver on a real tree.
 *
 * The same trade `delete.spec.ts` makes, and it matters here for the same
 * reason: nearly every claim in this ticket is a claim about what is on disk
 * afterwards. "The source was not deleted", "no partial file was left under a
 * real name", "the mode was preserved" — a mock that reports those proves only
 * that the mock was asked. These read the filesystem.
 *
 * Two hosts, both local. A cross-host transfer here is two `LocalDriver`s with
 * different host ids, which is not a network and is exactly the code path: the
 * whole point of the driver abstraction is that `src.createReadStream() →
 * dst.createWriteStream()` has no branch for whether either end is remote. What
 * it does not exercise is SFTP itself, which `verify:drivers` covers.
 */

const HOST_A = "host-a";
const HOST_B = "host-b";
const USER_ID = "user-1";

let base: string;

// ---------------------------------------------------------------- the doubles

interface JobRow {
  id: string;
  userId: string;
  srcHostId: string | null;
  srcPath: string;
  dstHostId: string | null;
  dstPath: string;
  operation: string;
  options: unknown;
  status: string;
  bytesTotal: bigint;
  bytesDone: bigint;
  itemsTotal: number;
  itemsDone: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
}

interface ItemRow {
  id: string;
  jobId: string;
  name: string;
  kind: string;
  bytes: bigint;
  mode: number | null;
  mtimeMs: bigint | null;
  conflict: string;
  status: string;
  finalName: string | null;
  error: string | null;
}

function unsupported(call: string, args: unknown): never {
  throw new Error(`FakePrisma.${call} got a shape it does not implement: ${JSON.stringify(args)}`);
}

/**
 * Jobs and items in memory, with the host row the path guard needs.
 *
 * Deliberately strict, like the double in `http-guards.spec.ts`: a query shape
 * it does not implement throws rather than answering "no rows". A permissive
 * fake would let a test that asserts "nothing was transferred" pass because the
 * service asked a question the double silently ignored.
 */
class FakePrisma {
  jobs: JobRow[] = [];
  items: ItemRow[] = [];
  roots: Array<{ path: string; access: "READ" | "WRITE" }> = [];
  private sequence = 0;

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  readonly hosts = {
    findFirst: ({ where }: { where: { id: string; userId: string } }) =>
      Promise.resolve(
        where.userId === USER_ID && (where.id === HOST_A || where.id === HOST_B)
          ? { id: where.id, userId: USER_ID, transport: "LOCAL", roots: this.roots, user: { role: "MEMBER" } }
          : null,
      ),
  };

  readonly transferJobs = {
    create: ({ data }: { data: Partial<JobRow> }) => {
      const row: JobRow = {
        id: this.id("job"),
        userId: data.userId as string,
        srcHostId: data.srcHostId ?? null,
        srcPath: data.srcPath as string,
        dstHostId: data.dstHostId ?? null,
        dstPath: data.dstPath as string,
        operation: data.operation as string,
        options: data.options ?? null,
        status: (data.status as string) ?? "QUEUED",
        bytesTotal: data.bytesTotal ?? 0n,
        bytesDone: 0n,
        itemsTotal: data.itemsTotal ?? 0,
        itemsDone: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        createdAt: new Date(),
      };
      this.jobs.push(row);
      return Promise.resolve(row);
    },

    findUnique: ({ where, include }: { where: { id: string }; include?: { items?: boolean } }) => {
      const job = this.jobs.find((row) => row.id === where.id);
      if (!job) return Promise.resolve(null);
      return Promise.resolve(include?.items ? { ...job, items: this.items.filter((i) => i.jobId === job.id) } : job);
    },

    findFirst: ({ where }: { where: { id: string; userId: string } }) =>
      Promise.resolve(this.jobs.find((row) => row.id === where.id && row.userId === where.userId) ?? null),

    findMany: ({ where }: { where?: { userId?: string; status?: { in?: string[] } } }) => {
      if (typeof where?.userId === "string") {
        return Promise.resolve(this.jobs.filter((row) => row.userId === where.userId));
      }
      if (Array.isArray(where?.status?.in)) {
        const wanted = where.status.in;
        return Promise.resolve(this.jobs.filter((row) => wanted.includes(row.status)));
      }
      return unsupported("transferJobs.findMany", where);
    },

    update: ({ where, data }: { where: { id: string }; data: Partial<JobRow> }) => {
      const job = this.jobs.find((row) => row.id === where.id);
      if (!job) return Promise.reject(new Error("No TransferJobs found"));
      Object.assign(job, data);
      return Promise.resolve(job);
    },
  };

  readonly transferItems = {
    createMany: ({ data }: { data: Array<Partial<ItemRow>> }) => {
      for (const entry of data) {
        this.items.push({
          id: this.id("item"),
          jobId: entry.jobId as string,
          name: entry.name as string,
          kind: entry.kind as string,
          bytes: entry.bytes ?? 0n,
          mode: entry.mode ?? null,
          mtimeMs: entry.mtimeMs ?? null,
          conflict: (entry.conflict as string) ?? "ASK",
          status: (entry.status as string) ?? "PENDING",
          finalName: null,
          error: null,
        });
      }
      return Promise.resolve({ count: data.length });
    },

    findMany: ({ where }: { where?: { jobId?: string; status?: string } }) => {
      if (typeof where?.jobId !== "string") return unsupported("transferItems.findMany", where);
      return Promise.resolve(
        this.items.filter((row) => row.jobId === where.jobId && (!where.status || row.status === where.status)),
      );
    },

    update: ({ where, data }: { where: { id: string }; data: Partial<ItemRow> }) => {
      const item = this.items.find((row) => row.id === where.id);
      if (!item) return Promise.reject(new Error("No TransferItems found"));
      Object.assign(item, data);
      return Promise.resolve(item);
    },

    updateMany: ({
      where,
      data,
    }: {
      where: { jobId?: string | { in?: string[] }; status?: string };
      data: Partial<ItemRow>;
    }) => {
      const ids = typeof where.jobId === "string" ? [where.jobId] : (where.jobId?.in ?? []);
      const touched = this.items.filter(
        (row) => ids.includes(row.jobId) && (!where.status || row.status === where.status),
      );
      for (const row of touched) Object.assign(row, data);
      return Promise.resolve({ count: touched.length });
    },

    count: ({ where }: { where: { jobId: string; status?: string } }) =>
      Promise.resolve(
        this.items.filter((row) => row.jobId === where.jobId && (!where.status || row.status === where.status)).length,
      ),

    groupBy: ({ where }: { where: { jobId: { in: string[] }; status: string } }) => {
      const counts = new Map<string, number>();
      for (const row of this.items) {
        if (!where.jobId.in.includes(row.jobId) || row.status !== where.status) continue;
        counts.set(row.jobId, (counts.get(row.jobId) ?? 0) + 1);
      }
      return Promise.resolve([...counts].map(([jobId, count]) => ({ jobId, _count: { _all: count } })));
    },
  };
}

function memoryLimits(): RateLimitService {
  const counts = new Map<string, number>();
  return new RateLimitService({
    getClient: () => ({
      incrBy: (key: string, amount: number) => {
        const next = (counts.get(key) ?? 0) + amount;
        counts.set(key, next);
        return Promise.resolve(next);
      },
      expire: () => Promise.resolve(true),
      ttl: () => Promise.resolve(30),
    }),
  } as unknown as RedisService);
}

const silentAudit = {
  refused: () => Promise.resolve(),
  open: () => Promise.resolve("audit-row"),
  settle: () => Promise.resolve(),
} as unknown as AuditService;

/**
 * A driver whose write stream can be made to fail on demand.
 *
 * The `move` tests need a write that goes wrong *after* the read succeeded,
 * which is the only arrangement in which "delete the source too early" is a
 * mistake anybody could make. Breaking the destination filesystem is the
 * alternative and it needs root.
 */
class BreakableDriver implements HostDriver {
  breakWritesMatching: RegExp | null = null;

  constructor(private readonly inner: LocalDriver) {}

  get hostId(): string {
    return this.inner.hostId;
  }

  createWriteStream(path: string, options?: Parameters<HostDriver["createWriteStream"]>[1]): Promise<Writable> {
    if (this.breakWritesMatching?.test(path)) {
      return Promise.reject(new DriverError("EACCES", `Refused for the test: ${path}`, path));
    }
    return this.inner.createWriteStream(path, options);
  }

  list: HostDriver["list"] = (path) => this.inner.list(path);
  stat: HostDriver["stat"] = (path) => this.inner.stat(path);
  realpath: HostDriver["realpath"] = (path) => this.inner.realpath(path);
  createReadStream: HostDriver["createReadStream"] = (path, options) => this.inner.createReadStream(path, options);
  mkdir: HostDriver["mkdir"] = (path, options) => this.inner.mkdir(path, options);
  rename: HostDriver["rename"] = (from, to) => this.inner.rename(from, to);
  chmod: HostDriver["chmod"] = (path, mode) => this.inner.chmod(path, mode);
  chown: HostDriver["chown"] = (path, uid, gid) => this.inner.chown(path, uid, gid);
  utimes: HostDriver["utimes"] = (path, a, m) => this.inner.utimes(path, a, m);
  unlink: HostDriver["unlink"] = (path) => this.inner.unlink(path);
  rmdir: HostDriver["rmdir"] = (path, options) => this.inner.rmdir(path, options);
  exec: HostDriver["exec"] = (program, args, options) => this.inner.exec(program, args, options);
  dispose: HostDriver["dispose"] = () => this.inner.dispose();
}

interface Harness {
  prisma: FakePrisma;
  service: TransferService;
  runner: TransferRunnerService;
  drivers: Map<string, BreakableDriver>;
  queued: string[];
  /** Plan, queue and run one transfer to completion. */
  transfer: (input: CreateInput) => Promise<string>;
  run: (jobId: string, signal?: AbortSignal) => Promise<void>;
}

function harness(
  roots: Array<{ path: string; access: "READ" | "WRITE" }> = [{ path: base, access: "WRITE" }],
): Harness {
  const prisma = new FakePrisma();
  prisma.roots = roots;

  const drivers = new Map<string, BreakableDriver>([
    [HOST_A, new BreakableDriver(new LocalDriver(HOST_A))],
    [HOST_B, new BreakableDriver(new LocalDriver(HOST_B))],
  ]);

  const factory = {
    forHost: (hostId: string) => {
      const driver = drivers.get(hostId);
      if (!driver) return Promise.reject(new DriverError("ENOENT", `No such host: ${hostId}`));
      return Promise.resolve(driver);
    },
  } as unknown as HostDriverFactory;

  const guard = new PathGuardService(prisma as unknown as PrismaService, [], memoryLimits(), silentAudit);
  const queued: string[] = [];
  const queue = { enqueue: (jobId: string) => queued.push(jobId) } as unknown as TransferQueueService;

  const service = new TransferService(prisma as unknown as PrismaService, factory, guard, queue);
  const runner = new TransferRunnerService(
    prisma as unknown as PrismaService,
    factory,
    guard,
    new TransferEventsService(),
    silentAudit,
  );

  const run = (jobId: string, signal?: AbortSignal) => runner.run(jobId, signal ?? new AbortController().signal);

  return {
    prisma,
    service,
    runner,
    drivers,
    queued,
    run,
    transfer: async (input) => {
      const job = await service.create(USER_ID, input);
      await run(job.id);
      return job.id;
    },
  };
}

// ---------------------------------------------------------------- the fixtures

function copyInput(paths: string[], destination: string, overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    srcHostId: HOST_A,
    srcPaths: paths,
    dstHostId: HOST_A,
    dstPath: destination,
    operation: "copy",
    strategy: "ask",
    ...overrides,
  };
}

async function tree(name: string): Promise<string> {
  const root = join(base, name);
  await mkdir(join(root, "nested", "deeper"), { recursive: true });
  await mkdir(join(root, "empty"), { recursive: true });
  await writeFile(join(root, "top.txt"), "top");
  await writeFile(join(root, "nested", "one.txt"), "one");
  await writeFile(join(root, "nested", "deeper", "two.txt"), "two");
  return root;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function statusOf(error: unknown): number {
  return error instanceof HttpException ? error.getStatus() : 0;
}

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  return (error.getResponse() as { code?: string }).code;
}

async function refusal(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("Expected a refusal, got a result.");
    },
    (error: unknown) => error,
  );
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "trekker-transfer-"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------- copy

describe("copying", () => {
  it("copies one file, byte for byte", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "the contents");

    const kit = harness();
    await kit.transfer(copyInput([join(from, "a.txt")], to));

    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("the contents");
    // A copy leaves the source alone. Stating it, because the same code path
    // does the move and one missing `if` is the difference.
    expect(await exists(join(from, "a.txt"))).toBe(true);
  });

  it("copies a whole tree, empty directories included", async () => {
    const source = await tree("source");
    const to = join(base, "to");
    await mkdir(to);

    const kit = harness();
    await kit.transfer(copyInput([source], to));

    expect(await readFile(join(to, "source", "top.txt"), "utf8")).toBe("top");
    expect(await readFile(join(to, "source", "nested", "one.txt"), "utf8")).toBe("one");
    expect(await readFile(join(to, "source", "nested", "deeper", "two.txt"), "utf8")).toBe("two");
    // An empty directory carries no file to recreate it, so it is the one that
    // gets lost by an implementation that only copies what it can read bytes from.
    expect(await exists(join(to, "source", "empty"))).toBe(true);
  });

  it("preserves the mode and the modification time", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    const file = join(from, "script.sh");
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o750);
    const when = new Date("2021-03-04T05:06:07.000Z");
    await utimes(file, when, when);

    const kit = harness();
    await kit.transfer(copyInput([file], to));

    const landed = await stat(join(to, "script.sh"));
    expect(landed.mode & 0o777).toBe(0o750);
    // To the second: SFTP carries no sub-second field, so the interface floors
    // and both drivers agree on that much and no more.
    expect(Math.floor(landed.mtimeMs / 1000)).toBe(Math.floor(when.getTime() / 1000));
  });

  it("leaves nothing partial behind when everything works", async () => {
    const source = await tree("source");
    const to = join(base, "to");
    await mkdir(to);

    const kit = harness();
    await kit.transfer(copyInput([source], to));

    const landed = await readdir(join(to, "source"));
    expect(landed.filter((name) => name.includes(".part"))).toEqual([]);
  });

  it("copies between two hosts with no branch of its own", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "across");

    const kit = harness();
    await kit.transfer(copyInput([join(from, "a.txt")], to, { dstHostId: HOST_B }));

    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("across");
  });
});

// ------------------------------------------------------------------ conflicts

describe("conflicts", () => {
  async function collision(): Promise<{ from: string; to: string }> {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "new");
    await writeFile(join(to, "a.txt"), "old");
    return { from, to };
  }

  it("reports one in the plan, with a line about it", async () => {
    const { from, to } = await collision();
    const kit = harness();

    const plan = await kit.service.plan(USER_ID, {
      srcHostId: HOST_A,
      srcPaths: [join(from, "a.txt")],
      dstHostId: HOST_A,
      dstPath: to,
      operation: "copy",
    });

    expect(plan.conflicts).toBe(1);
    expect(plan.items[0].target).not.toBeNull();
    expect(plan.items[0].note).toContain("identical size");
  });

  it("refuses to start with a conflict nobody answered", async () => {
    const { from, to } = await collision();
    const kit = harness();

    const error = await refusal(kit.service.create(USER_ID, copyInput([join(from, "a.txt")], to)));

    // 409, and it names what is in the way. Starting and stalling would leave a
    // job half-done in a tab nobody has open.
    expect(statusOf(error)).toBe(409);
    expect(codeOf(error)).toBe("ECONFLICT");
    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("old");
  });

  it("overwrites when told to", async () => {
    const { from, to } = await collision();
    const kit = harness();
    await kit.transfer(copyInput([join(from, "a.txt")], to, { strategy: "overwrite" }));

    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("new");
  });

  it("skips when told to, and moves no bytes doing it", async () => {
    const { from, to } = await collision();
    const kit = harness();
    const jobId = await kit.transfer(copyInput([join(from, "a.txt")], to, { strategy: "skip" }));

    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("old");
    expect(kit.prisma.items.find((item) => item.jobId === jobId)?.status).toBe("SKIPPED");
    expect(Number(kit.prisma.jobs[0].bytesDone)).toBe(0);
  });

  it("keeps both under a predictable name", async () => {
    const { from, to } = await collision();
    const kit = harness();
    await kit.transfer(copyInput([join(from, "a.txt")], to, { strategy: "keepBoth" }));

    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("old");
    expect(await readFile(join(to, "a (2).txt"), "utf8")).toBe("new");
    // The name it took, recorded — a UI that did not say so would leave
    // somebody hunting for a file under a name they never chose.
    expect(kit.prisma.items[0].finalName).toBe("a (2).txt");
  });

  it("lets one row override the blanket answer", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    for (const name of ["a.txt", "b.txt"]) {
      await writeFile(join(from, name), "new");
      await writeFile(join(to, name), "old");
    }

    const kit = harness();
    await kit.transfer(
      copyInput([join(from, "a.txt"), join(from, "b.txt")], to, {
        strategy: "overwrite",
        overrides: { "b.txt": "skip" },
      }),
    );

    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("new");
    expect(await readFile(join(to, "b.txt"), "utf8")).toBe("old");
  });

  it("skips an item that gained a conflict after the plan was drawn", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "new");

    const kit = harness();
    const job = await kit.service.create(USER_ID, copyInput([join(from, "a.txt")], to));

    // Somebody else put a file there between the plan and the run. Nobody was
    // asked about this, so it is not overwritten and not renamed — it is left,
    // and the reason is written down.
    await writeFile(join(to, "a.txt"), "appeared");
    await kit.run(job.id);

    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("appeared");
    const item = kit.prisma.items.find((row) => row.jobId === job.id);
    expect(item?.status).toBe("SKIPPED");
    expect(item?.error).toContain("changed at the destination");
  });
});

// ---------------------------------------------------------------------- move

describe("moving", () => {
  it("removes the source once it is at the destination", async () => {
    const source = await tree("source");
    const to = join(base, "to");
    await mkdir(to);

    const kit = harness();
    await kit.transfer(copyInput([source], to, { operation: "move" }));

    expect(await readFile(join(to, "source", "nested", "one.txt"), "utf8")).toBe("one");
    expect(await exists(source)).toBe(false);
  });

  it("moves within one filesystem by renaming, with no bytes read", async () => {
    const source = await tree("source");
    const to = join(base, "to");
    await mkdir(to);

    const kit = harness();
    // A read stream would be the general path. Same host, same mount, no
    // conflicts: the whole tree should move as one directory entry.
    const opened: string[] = [];
    const driver = kit.drivers.get(HOST_A) as BreakableDriver;
    const realRead: HostDriver["createReadStream"] = driver.createReadStream.bind(driver);
    driver.createReadStream = (path, options) => {
      opened.push(path);
      return realRead(path, options);
    };

    await kit.transfer(copyInput([source], to, { operation: "move" }));

    expect(opened).toEqual([]);
    expect(await readFile(join(to, "source", "nested", "one.txt"), "utf8")).toBe("one");
    expect(await exists(source)).toBe(false);
  });

  it("never deletes the source when the destination write fails", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "precious");

    const kit = harness();
    // Cross-host, so the rename fast path is off and the bytes really are
    // streamed — which is the arrangement in which deleting too early is a
    // mistake somebody could make.
    (kit.drivers.get(HOST_B) as BreakableDriver).breakWritesMatching = /\.part$/;

    await kit.transfer(copyInput([join(from, "a.txt")], to, { operation: "move", dstHostId: HOST_B }));

    // The claim the whole paragraph in the runner exists for.
    expect(await readFile(join(from, "a.txt"), "utf8")).toBe("precious");
    expect(await exists(join(to, "a.txt"))).toBe(false);
    expect(kit.prisma.jobs[0].status).toBe("FAILED");
  });

  it("leaves the source of a skipped item alone", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "new");
    await writeFile(join(to, "a.txt"), "old");

    const kit = harness();
    await kit.transfer(
      copyInput([join(from, "a.txt")], to, { operation: "move", strategy: "skip", dstHostId: HOST_B }),
    );

    // Skipping means "leave the destination alone", so removing the source
    // would be deleting the only copy of something nobody agreed to lose.
    expect(await readFile(join(from, "a.txt"), "utf8")).toBe("new");
    expect(await readFile(join(to, "a.txt"), "utf8")).toBe("old");
  });
});

// ------------------------------------------------------------------- failures

describe("failures", () => {
  it("keeps going past one unreadable file, and retries only that one", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "readable-1.txt"), "one");
    await writeFile(join(from, "locked.txt"), "secret");
    await writeFile(join(from, "readable-2.txt"), "two");
    await chmod(join(from, "locked.txt"), 0o000);

    const kit = harness();
    const job = await kit.service.create(
      USER_ID,
      copyInput([join(from, "readable-1.txt"), join(from, "locked.txt"), join(from, "readable-2.txt")], to),
    );
    await kit.run(job.id);

    expect(await readFile(join(to, "readable-1.txt"), "utf8")).toBe("one");
    expect(await readFile(join(to, "readable-2.txt"), "utf8")).toBe("two");
    expect(kit.prisma.jobs[0].status).toBe("FAILED");

    const failed = kit.prisma.items.filter((item) => item.status === "FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0].name).toBe("locked.txt");
    // Names the permission rather than shrugging. It said "The host refused"
    // until this test was written: `stat` succeeds on a `0o000` file, so
    // `LocalDriver.assertReadable` was not asserting readability at all and the
    // EACCES arrived later as a raw errno the driver never mapped.
    expect(failed[0].error).toBe("Permission denied on the host.");

    // The retry re-runs the one that failed and nothing else — which is the
    // whole reason the item is the unit of failure.
    await chmod(join(from, "locked.txt"), 0o600);
    await kit.service.retry(USER_ID, job.id);
    expect(kit.prisma.items.filter((item) => item.status === "PENDING")).toHaveLength(1);

    await kit.run(job.id);
    expect(await readFile(join(to, "locked.txt"), "utf8")).toBe("secret");
    expect(kit.prisma.jobs[0].status).toBe("DONE");
  });

  it("refuses a retry when nothing failed", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "fine");

    const kit = harness();
    const jobId = await kit.transfer(copyInput([join(from, "a.txt")], to));

    expect(statusOf(await refusal(kit.service.retry(USER_ID, jobId)))).toBe(400);
  });

  it("leaves no partial file under a real name when a write dies mid-stream", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "big.bin"), Buffer.alloc(4 * 1024 * 1024, 7));

    const kit = harness();
    (kit.drivers.get(HOST_B) as BreakableDriver).breakWritesMatching = /\.part$/;
    await kit.transfer(copyInput([join(from, "big.bin")], to, { dstHostId: HOST_B }));

    // Neither the real name nor the litter: a `.part` left behind after a
    // failure we caught would make one that survives a hard crash impossible
    // to tell apart.
    expect(await readdir(to)).toEqual([]);
  });
});

// ----------------------------------------------------------------- cancelling

describe("cancelling", () => {
  it("stops the job and leaves nothing under a real name", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    // Several files, so the abort lands between two of them rather than
    // needing to interrupt one — the check the runner makes per item.
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(from, `f-${index}.bin`), Buffer.alloc(256 * 1024, index));
    }

    const kit = harness();
    const job = await kit.service.create(
      USER_ID,
      copyInput(
        Array.from({ length: 40 }, (_, index) => join(from, `f-${index}.bin`)),
        to,
      ),
    );

    const controller = new AbortController();
    const running = kit.run(job.id, controller.signal);
    setTimeout(() => controller.abort(CANCELLED_BY_USER), 5);
    await running;

    expect(kit.prisma.jobs[0].status).toBe("CANCELLED");
    const landed = await readdir(to);
    expect(landed.filter((name) => name.includes(".part"))).toEqual([]);
    // Whatever did land is whole: every one of them was renamed into place
    // only after its stream ended.
    for (const name of landed) {
      expect((await stat(join(to, name))).size).toBe(256 * 1024);
    }
  });

  it("treats a shutdown as an interruption, not an outcome", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(from, `f-${index}.bin`), Buffer.alloc(256 * 1024, index));
    }

    const kit = harness();
    const job = await kit.service.create(
      USER_ID,
      copyInput(
        Array.from({ length: 40 }, (_, index) => join(from, `f-${index}.bin`)),
        to,
      ),
    );

    const controller = new AbortController();
    const running = kit.run(job.id, controller.signal);
    setTimeout(() => controller.abort(CANCELLED_BY_SHUTDOWN), 5);
    await running;

    // Left RUNNING on purpose: that is the state the reclaim at the next boot
    // looks for. Marking it cancelled would decide, without asking, that a
    // deploy abandons every transfer in flight.
    expect(kit.prisma.jobs[0].status).toBe("RUNNING");

    // And it finishes when it is picked up again.
    await kit.run(job.id);
    expect(kit.prisma.jobs[0].status).toBe("DONE");
    expect(await readdir(to)).toHaveLength(40);
    expect(Number(kit.prisma.jobs[0].bytesDone)).toBe(40 * 256 * 1024);
  });

  /**
   * The row a hard kill leaves behind, built by hand.
   *
   * An `AbortController` cannot produce it, and finding that out is what
   * this test is worth: an aborted copy unwinds through `copyOne`'s catch,
   * which hands its in-flight bytes back precisely because the `.part` they
   * were in is discarded. A `SIGKILL` runs no catch. What it leaves is
   * whatever the progress tick last wrote — bytes for an item that is still
   * `PENDING` — and that is the state the reclaim actually meets.
   */
  it("counts the bytes that exist after a crash, not the ones it tried twice", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "done.bin"), Buffer.alloc(4096, 1));
    await writeFile(join(from, "interrupted.bin"), Buffer.alloc(4096, 2));

    const kit = harness();
    const job = await kit.service.create(
      USER_ID,
      copyInput([join(from, "done.bin"), join(from, "interrupted.bin")], to),
    );

    // One item finished; the other was half-written when the process died, and
    // the last tick had already persisted 3000 of its bytes.
    const [first, second] = kit.prisma.items;
    first.status = "DONE";
    kit.prisma.jobs[0].status = "RUNNING";
    kit.prisma.jobs[0].bytesDone = BigInt(Number(first.bytes) + 3000);
    kit.prisma.jobs[0].itemsDone = 1;
    expect(second.status).toBe("PENDING");

    await kit.run(job.id);

    expect(kit.prisma.jobs[0].status).toBe("DONE");
    expect(await readFile(join(to, "interrupted.bin"))).toHaveLength(4096);
    // 8192, not 11192. Carrying the stored counter into the second run counts
    // the interrupted bytes twice — a real 755 MB transfer killed and
    // restarted finished claiming 819 MB before this was fixed.
    expect(Number(kit.prisma.jobs[0].bytesDone)).toBe(8192);
    expect(Number(kit.prisma.jobs[0].bytesDone)).toBe(Number(kit.prisma.jobs[0].bytesTotal));
  });

  it("refuses to cancel a transfer that has already finished", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "done");

    const kit = harness();
    const jobId = await kit.transfer(copyInput([join(from, "a.txt")], to));

    expect(statusOf(await refusal(kit.service.cancel(USER_ID, jobId)))).toBe(400);
  });
});

// -------------------------------------------------------------------- refusals

describe("what is refused before anything moves", () => {
  it("refuses a destination outside the roots", async () => {
    const inside = join(base, "inside");
    const outside = await mkdtemp(join(tmpdir(), "trekker-elsewhere-"));
    await mkdir(inside);
    await writeFile(join(inside, "a.txt"), "a");

    try {
      const kit = harness([{ path: inside, access: "WRITE" }]);
      const error = await refusal(kit.service.create(USER_ID, copyInput([join(inside, "a.txt")], outside)));

      expect(statusOf(error)).toBe(403);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a read-only destination root", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "a");

    // Readable is not writable, and validating one intent for both ends is the
    // mistake the two separate `validate` calls exist to prevent.
    const kit = harness([
      { path: from, access: "WRITE" },
      { path: to, access: "READ" },
    ]);
    expect(statusOf(await refusal(kit.service.create(USER_ID, copyInput([join(from, "a.txt")], to))))).toBe(403);
    expect(await readdir(to)).toEqual([]);
  });

  it("refuses a destination inside the source", async () => {
    const source = await tree("source");

    const kit = harness();
    const error = await refusal(kit.service.create(USER_ID, copyInput([source], join(source, "nested"))));

    expect(statusOf(error)).toBe(400);
    expect((error as HttpException).message).toContain("inside");
  });

  it("refuses a selection spread over two directories", async () => {
    await mkdir(join(base, "one"));
    await mkdir(join(base, "two"));
    await writeFile(join(base, "one", "a.txt"), "a");
    await writeFile(join(base, "two", "b.txt"), "b");
    const to = join(base, "to");
    await mkdir(to);

    const kit = harness();
    const error = await refusal(
      kit.service.create(USER_ID, copyInput([join(base, "one", "a.txt"), join(base, "two", "b.txt")], to)),
    );

    expect(statusOf(error)).toBe(400);
    expect((error as HttpException).message).toContain("same directory");
  });

  it("refuses a destination that is a file", async () => {
    const from = join(base, "from");
    await mkdir(from);
    await writeFile(join(from, "a.txt"), "a");
    await writeFile(join(base, "not-a-directory"), "x");

    const kit = harness();
    expect(
      statusOf(
        await refusal(kit.service.create(USER_ID, copyInput([join(from, "a.txt")], join(base, "not-a-directory")))),
      ),
    ).toBe(400);
  });

  it("does not show one account another's transfer", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);
    await writeFile(join(from, "a.txt"), "a");

    const kit = harness();
    const jobId = await kit.transfer(copyInput([join(from, "a.txt")], to));

    // Absent, not forbidden: a 403 would confirm the id is real.
    expect(statusOf(await refusal(kit.service.get("someone-else", jobId)))).toBe(404);
  });
});

// --------------------------------------------------------------------- memory

// ---------------------------------------------------------------------- queue

describe("the queue", () => {
  /** A runner that starts on demand and finishes when the test says so. */
  function pausableRunner(): { runner: TransferRunnerService; started: string[]; finish: (jobId: string) => void } {
    const started: string[] = [];
    const pending = new Map<string, () => void>();

    const runner = {
      run: (jobId: string) => {
        started.push(jobId);
        return new Promise<void>((resolve) => pending.set(jobId, resolve));
      },
    } as unknown as TransferRunnerService;

    return { runner, started, finish: (jobId) => pending.get(jobId)?.() };
  }

  function jobRow(id: string, hosts: [string, string], status = "QUEUED"): JobRow {
    return {
      id,
      userId: USER_ID,
      srcHostId: hosts[0],
      srcPath: "/src",
      dstHostId: hosts[1],
      dstPath: "/dst",
      operation: "COPY",
      options: null,
      status,
      bytesTotal: 0n,
      bytesDone: 0n,
      itemsTotal: 1,
      itemsDone: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      createdAt: new Date(),
    };
  }

  /** A settled promise, so the queue's `.finally` chain has run. */
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("runs up to the in-flight cap and holds the rest in line", async () => {
    process.env.TREKKER_TRANSFERS_IN_FLIGHT = "2";
    process.env.TREKKER_TRANSFERS_PER_HOST = "9";

    const prisma = new FakePrisma();
    const { runner, started, finish } = pausableRunner();
    const queue = new TransferQueueService(prisma as unknown as PrismaService, runner);

    for (const id of ["a", "b", "c"]) queue.enqueue(id, [HOST_A, HOST_B]);
    expect(started).toEqual(["a", "b"]);

    // A slot freeing is what lets the third one in, and it must not need
    // another enqueue to notice.
    finish("a");
    await settle();
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("never runs more than the per-host cap against one machine", async () => {
    process.env.TREKKER_TRANSFERS_IN_FLIGHT = "9";
    process.env.TREKKER_TRANSFERS_PER_HOST = "2";

    const prisma = new FakePrisma();
    const { runner, started, finish } = pausableRunner();
    const queue = new TransferQueueService(prisma as unknown as PrismaService, runner);

    // Three jobs all touching HOST_A, and one that touches neither.
    queue.enqueue("a1", [HOST_A, HOST_B]);
    queue.enqueue("a2", [HOST_A, HOST_B]);
    queue.enqueue("a3", [HOST_A, HOST_B]);
    queue.enqueue("elsewhere", ["host-c", "host-d"]);

    // The third is blocked on HOST_A, and `elsewhere` runs past it rather than
    // waiting behind a queue position nobody can see. That is the whole reason
    // `pump` scans the line instead of only looking at its head.
    expect(started).toEqual(["a1", "a2", "elsewhere"]);

    finish("a1");
    await settle();
    expect(started).toContain("a3");
  });

  it("picks up what a restart interrupted, and resets its in-flight items", async () => {
    process.env.TREKKER_TRANSFERS_IN_FLIGHT = "4";
    process.env.TREKKER_TRANSFERS_PER_HOST = "4";

    const prisma = new FakePrisma();
    prisma.jobs.push(jobRow("stranded", [HOST_A, HOST_B], "RUNNING"), jobRow("waiting", [HOST_A, HOST_B], "QUEUED"));
    prisma.items.push(
      {
        id: "i1",
        jobId: "stranded",
        name: "a",
        kind: "file",
        bytes: 1n,
        mode: null,
        mtimeMs: null,
        conflict: "ASK",
        status: "RUNNING",
        finalName: null,
        error: null,
      },
      {
        id: "i2",
        jobId: "stranded",
        name: "b",
        kind: "file",
        bytes: 1n,
        mode: null,
        mtimeMs: null,
        conflict: "ASK",
        status: "DONE",
        finalName: null,
        error: null,
      },
    );

    const { runner, started } = pausableRunner();
    const queue = new TransferQueueService(prisma as unknown as PrismaService, runner);
    await queue.onApplicationBootstrap();

    expect(started.sort()).toEqual(["stranded", "waiting"]);
    // The item that was mid-flight runs again from the top — safe precisely
    // because it left a `.part` rather than anything under a real name.
    expect(prisma.items.find((item) => item.id === "i1")?.status).toBe("PENDING");
    // The one that finished keeps its outcome. Re-running it would move
    // gigabytes to redo work that is already at the destination.
    expect(prisma.items.find((item) => item.id === "i2")?.status).toBe("DONE");
  });

  it("stops handing out work once it is shutting down", async () => {
    process.env.TREKKER_TRANSFERS_IN_FLIGHT = "2";
    process.env.TREKKER_TRANSFERS_PER_HOST = "2";

    const prisma = new FakePrisma();
    const { runner, started } = pausableRunner();
    const queue = new TransferQueueService(prisma as unknown as PrismaService, runner);

    queue.enqueue("a", [HOST_A, HOST_B]);
    queue.onModuleDestroy();
    queue.enqueue("b", [HOST_A, HOST_B]);
    await settle();

    expect(started).toEqual(["a"]);
  });

  it("drops a queued job from the line rather than pretending to stop it", () => {
    process.env.TREKKER_TRANSFERS_IN_FLIGHT = "1";
    process.env.TREKKER_TRANSFERS_PER_HOST = "1";

    const prisma = new FakePrisma();
    const { runner, started } = pausableRunner();
    const queue = new TransferQueueService(prisma as unknown as PrismaService, runner);

    queue.enqueue("running", [HOST_A, HOST_B]);
    queue.enqueue("waiting", [HOST_A, HOST_B]);

    expect(queue.cancel("waiting")).toBe("waiting");
    expect(queue.cancel("running")).toBe("running");
    expect(queue.cancel("never-existed")).toBe("unknown");
    expect(started).toEqual(["running"]);
  });

  afterEach(() => {
    delete process.env.TREKKER_TRANSFERS_IN_FLIGHT;
    delete process.env.TREKKER_TRANSFERS_PER_HOST;
  });
});

/**
 * What the process is holding, counting the memory a stream actually uses.
 *
 * `heapUsed` alone is the wrong number here, and quietly so: a `Buffer` lives
 * outside V8's heap. A version of the runner that pushed every chunk into an
 * array and released none passed a `heapUsed`-only assertion while holding the
 * entire file — verified by writing that version and watching the test stay
 * green. `arrayBuffers` is where those bytes are counted; against the same
 * broken runner this measure reports 2.13 GB, which is what makes the test
 * below able to fail.
 */
function held(): number {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

describe("memory", () => {
  it("moves a large file without holding it", async () => {
    const from = join(base, "from");
    const to = join(base, "to");
    await mkdir(from);
    await mkdir(to);

    // Sparse on the read side, the same trick `download.spec.ts` uses:
    // `truncate` costs no disk and no write time, and the stream cannot tell.
    // The write side is real bytes, which is what bounds the size chosen here —
    // two gigabytes rather than the ticket's five, because this runs inside
    // `pnpm test` and therefore inside the pre-deploy gate.
    const size = 2 * 1024 ** 3;
    const handle = await open(join(from, "big.bin"), "w");
    await handle.truncate(size);
    await handle.close();

    const before = held();

    const kit = harness();
    await kit.transfer(copyInput([join(from, "big.bin")], to));

    const after = held();

    expect((await stat(join(to, "big.bin"))).size).toBe(size);
    // A hundred megabytes of headroom against two gigabytes moved, which is the
    // ratio `download.spec.ts` uses and for the same reason: the number is not
    // zero because a stream that never ran a garbage collection still holds a
    // few tens of megabytes of chunks it has finished with. Anything that
    // *accumulated* would be an order of magnitude past this — verified by
    // writing that version, which came in at the full two gigabytes.
    expect(after - before).toBeLessThan(100 * 1024 ** 2);
  }, 120_000);
});
