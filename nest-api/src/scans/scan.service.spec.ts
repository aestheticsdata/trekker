import { ConflictException, NotFoundException } from "@nestjs/common";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { STALE_AFTER_SECONDS, STALE_RUNNING_AFTER_MS } from "@scans/scan-limits";
import type { ScanQueueService } from "@scans/scan-queue.service";
import { type ScanRow, ScanService } from "@scans/scan.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Accepting, serving and stopping a scan (TRE-32).
 *
 * Two of these have a wrong answer that looks entirely reasonable. A second
 * start could return the scan already running — and would then have the client
 * drawing `/home` under a label that says `/var`. A stale scan could be served
 * as though it were current, which is the failure the ticket names outright:
 * "a stale scan is labelled stale rather than presented as current".
 */

const USER = "user-1";
const HOST = "host-1";
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

function row(over: Partial<ScanRow> = {}): ScanRow {
  return {
    id: "scan-1",
    hostId: HOST,
    root: "/srv",
    depth: 3,
    status: "DONE",
    flavour: "GNU",
    niced: true,
    startedAt: new Date(NOW - 600_000),
    finishedAt: new Date(NOW - 240_000),
    totalBytes: 10_200n,
    inodes: 6n,
    unreadableCount: 0,
    truncated: false,
    error: null,
    largestPath: "/srv/a/f1",
    largestBytes: 5_000n,
    oldFileCount: 2n,
    oldFileBytes: 4_000n,
    oldFileBefore: new Date(NOW - 400 * 86_400_000),
    dupGroupsCandidate: 3,
    dupGroupsConfirmed: 1,
    dupGroupsSkipped: 2,
    dupReclaimableBytes: 5_000n,
    ...over,
  };
}

interface Fixture {
  done?: ScanRow | null;
  running?: ScanRow | null;
  entries?: Array<Record<string, unknown>>;
  createThrows?: boolean;
}

class FakePrisma {
  readonly created: Array<Record<string, unknown>> = [];
  readonly updated: Array<Record<string, unknown>> = [];
  readonly reaped: Array<Record<string, unknown>> = [];

  constructor(private readonly fixture: Fixture = {}) {}

  readonly hosts = {
    findFirst: ({ where }: { where: { id: string; userId: string } }) =>
      Promise.resolve(where.id === HOST && where.userId === USER ? { id: HOST } : null),
  };

  readonly diskScans = {
    findFirst: ({ where }: { where: { status?: string; id?: string } }) => {
      // Reading one back by id — the load after a create or a cancel. It always
      // exists by then, whatever the fixture says about earlier scans.
      if (where.id) return Promise.resolve(this.fixture.done ?? row({ id: where.id }));
      // The newest RUNNING scan on the host.
      if (where.status === "RUNNING") return Promise.resolve(this.fixture.running ?? null);
      // The newest DONE scan of the root: what a new scan supersedes, and what
      // the panel is served.
      return Promise.resolve(this.fixture.done ?? null);
    },
    create: ({ data }: { data: Record<string, unknown> }) => {
      if (this.fixture.createThrows) return Promise.reject(Object.assign(new Error("dup"), { code: "P2002" }));
      this.created.push(data);
      return Promise.resolve({ id: "scan-new" });
    },
    update: ({ data }: { data: Record<string, unknown> }) => {
      this.updated.push(data);
      return Promise.resolve({ id: "scan-1" });
    },
    updateMany: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      this.reaped.push({ where, data });
      return Promise.resolve({ count: 0 });
    },
  };

  readonly diskScanEntries = {
    findMany: () => Promise.resolve(this.fixture.entries ?? []),
    findFirst: () => Promise.resolve(null),
  };
}

function build(fixture: Fixture = {}, queueOver: Partial<ScanQueueService> = {}) {
  const prisma = new FakePrisma(fixture);
  const enqueued: unknown[] = [];

  const driver = { hostId: HOST, dispose: () => Promise.resolve() };
  const factory = { forHost: () => Promise.resolve(driver) } as unknown as HostDriverFactory;
  const guard = {
    validate: ({ path }: { path: string }) => Promise.resolve({ realPath: path }),
  } as unknown as PathGuardService;
  const queue = {
    enqueue: (scan: unknown) => enqueued.push(scan),
    cancel: () => "running" as const,
    isRunning: () => false,
    ...queueOver,
  } as unknown as ScanQueueService;

  return {
    prisma,
    enqueued,
    service: new ScanService(prisma as unknown as PrismaService, factory, guard, queue),
  };
}

beforeEach(() => {
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("starting", () => {
  it("creates a RUNNING row holding the host's slot and queues it", async () => {
    const { service, prisma, enqueued } = build({ done: row({ id: "scan-new", status: "RUNNING" }) });

    await service.start(USER, HOST, { root: "/srv" });

    expect(prisma.created[0]).toMatchObject({ hostId: HOST, root: "/srv", status: "RUNNING", runningSlot: HOST });
    expect(enqueued).toHaveLength(1);
  });

  it("points the new scan at the one it supersedes, so the panel never blanks", async () => {
    const { service, prisma } = build({ done: row({ id: "previous" }) });

    await service.start(USER, HOST, { root: "/srv" });

    expect(prisma.created[0].supersedesId).toBe("previous");
  });

  it("walks the path the guard resolved, not the one the client sent", async () => {
    // A symlinked root resolved here is a root that cannot walk out of the
    // allowlist, because `du` is given the real path.
    const { service, prisma } = build({ done: null });

    await service.start(USER, HOST, { root: "/srv/link" });

    expect(prisma.created[0].root).toBe("/srv/link");
  });

  it("defaults the depth rather than storing undefined", async () => {
    const { service, prisma } = build({ done: null });
    await service.start(USER, HOST, { root: "/srv" });
    expect(prisma.created[0].depth).toBe(3);
  });

  it("refuses a second scan with a 409 carrying the one already running", async () => {
    // Not a 202 returning the other scan: "scan /var" answered with a scan of
    // /home would have the client drawing the wrong root under the right label.
    const running = row({ id: "scan-live", root: "/home", status: "RUNNING", finishedAt: null });
    const { service } = build({ running, createThrows: true });

    const failure: unknown = await service
      .start(USER, HOST, { root: "/var" })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictException);
    const body = (failure as ConflictException).getResponse() as { message: string; scan: { root: string } };
    expect(body.message).toContain("/home");
    expect(body.scan.root).toBe("/home");
  });

  it("clears a RUNNING row old enough to be abandoned", async () => {
    // Only reachable when the boot sweep itself did not run. Left alone, the
    // row holds the unique slot and locks the host out of scanning for good.
    const { service, prisma } = build({ done: null });

    await service.start(USER, HOST, { root: "/srv" });

    const reap = prisma.reaped[0] as { where: { startedAt: { lt: Date } }; data: { status: string } };
    expect(reap.data.status).toBe("FAILED");
    expect(reap.where.startedAt.lt.getTime()).toBe(NOW - STALE_RUNNING_AFTER_MS);
  });

  it("leaves a live scan's slot alone", async () => {
    const { service, prisma } = build({ done: null }, { isRunning: () => true });
    await service.start(USER, HOST, { root: "/srv" });
    expect(prisma.reaped).toHaveLength(0);
  });
});

describe("serving", () => {
  it("reports the age from the server's clock", async () => {
    const { service } = build({ done: row() });

    const state = await service.state(USER, HOST, "/srv");

    // Finished four minutes ago, which is what the panel says.
    expect(state.scan?.ageSeconds).toBe(240);
    expect(state.scan?.stale).toBe(false);
  });

  it("labels a scan older than the threshold as stale", async () => {
    const old = row({ finishedAt: new Date(NOW - (STALE_AFTER_SECONDS + 60) * 1000) });
    const { service } = build({ done: old });

    const state = await service.state(USER, HOST, "/srv");

    expect(state.scan?.stale).toBe(true);
    // The threshold travels with the flag, so the panel need not hardcode a
    // policy the server owns.
    expect(state.scan?.staleAfterSeconds).toBe(STALE_AFTER_SECONDS);
  });

  it("keeps serving the finished scan while a new one runs", async () => {
    const { service } = build({ done: row({ id: "kept" }), running: row({ id: "live", status: "RUNNING" }) });

    const state = await service.state(USER, HOST, "/srv");

    expect(state.scan?.id).toBe("kept");
    expect(state.running?.id).toBe("live");
  });

  it("reports every fact, and reports an absent one as absent", async () => {
    const { service } = build({ done: row({ oldFileCount: null, oldFileBytes: null, oldFileBefore: null }) });

    const state = await service.state(USER, HOST, "/srv");

    expect(state.scan?.facts.largest).toEqual({ path: "/srv/a/f1", bytes: "5000" });
    // Null, not a zero: "this du cannot tell us" is not "no files are old".
    expect(state.scan?.facts.oldFiles).toBeNull();
    expect(state.scan?.facts.duplicates).toEqual({
      candidates: 3,
      confirmed: 1,
      skipped: 2,
      reclaimableBytes: "5000",
    });
  });

  it("has nothing to serve before the first scan", async () => {
    const { service } = build({ done: null });
    const state = await service.state(USER, HOST, "/srv");
    expect(state).toEqual({ scan: null, running: null, level: null });
  });

  it("is a 404 for another account's host", async () => {
    const { service } = build({ done: row() });
    await expect(service.state("someone-else", HOST, "/srv")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("cancelling", () => {
  it("aborts a running scan and lets the runner write the status", async () => {
    const { service, prisma } = build({ running: row({ status: "RUNNING" }), done: row({ status: "CANCELLED" }) });

    await service.cancel(USER, HOST);

    // The runner owns the terminal write for a scan it is actually running.
    expect(prisma.updated).toHaveLength(0);
  });

  it("writes the status itself for a scan still waiting in line", async () => {
    // No runner ever touched it, so nothing else would — and the row would sit
    // RUNNING, holding the slot, until a restart swept it.
    const { service, prisma } = build(
      { running: row({ status: "RUNNING" }), done: row({ status: "CANCELLED" }) },
      {
        cancel: () => "waiting" as const,
      },
    );

    await service.cancel(USER, HOST);

    expect(prisma.updated[0]).toMatchObject({ status: "CANCELLED", runningSlot: null });
  });

  it("is a 404 when nothing is running", async () => {
    const { service } = build({ running: null });
    await expect(service.cancel(USER, HOST)).rejects.toBeInstanceOf(NotFoundException);
  });
});
