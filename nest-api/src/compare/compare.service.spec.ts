import { CompareService } from "@compare/compare.service";

import type { FileEntry } from "@hosts/drivers/host-driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PathGuardService } from "@hosts/path-guard/path-guard.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Turning a walk into an answer (TRE-28 §2).
 *
 * The walk itself is `compare-tree.spec.ts`. What is left here is the part that
 * needs a database and two hosts, and it comes down to three claims:
 *
 *   - both roots go through the guard, on their own host and under this
 *     account, which is what makes "a pane on a host the user does not own is
 *     impossible" true of the code rather than of the UI;
 *   - a cached digest settles a row **only while it still describes the file**,
 *     the same rule TRE-27 serves a single digest under;
 *   - both drivers are released, including when the second host refuses.
 */

const USER = "user-1";
const HOST_A = "host-a";
const HOST_B = "host-b";

function file(name: string, size = 10, mtimeMs = 1_000): FileEntry {
  return { name, kind: "file", size, mode: 0o644, uid: 0, gid: 0, mtimeMs };
}

class FakeDriver {
  disposed = false;

  constructor(
    readonly hostId: string,
    private readonly tree: Record<string, FileEntry[]>,
  ) {}

  list = (path: string): Promise<FileEntry[]> => {
    const children = this.tree[path];
    if (!children) return Promise.reject(new Error(`cannot list ${path}`));
    return Promise.resolve(children);
  };

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
}

interface Fixture {
  a?: Record<string, FileEntry[]>;
  b?: Record<string, FileEntry[]>;
  /** `FileHashes` rows, per host. */
  digests?: Record<string, Row[]>;
  /** The second `forHost` rejects — a host that has gone away. */
  secondHostFails?: boolean;
}

function build(fixture: Fixture = {}) {
  const driverA = new FakeDriver(HOST_A, fixture.a ?? { "/a": [file("x")] });
  const driverB = new FakeDriver(HOST_B, fixture.b ?? { "/b": [file("x")] });

  const opened: string[] = [];
  const factory = {
    forHost: (hostId: string) => {
      opened.push(hostId);
      if (fixture.secondHostFails && opened.length === 2) return Promise.reject(new Error("host is gone"));
      return Promise.resolve(hostId === HOST_A ? driverA : driverB);
    },
  } as unknown as HostDriverFactory;

  const validated: Array<{ hostId: string; path: string; intent: string; userId: string }> = [];
  const guard = {
    validate: ({
      driver,
      userId,
      path,
      intent,
    }: {
      driver: { hostId: string };
      userId: string;
      path: string;
      intent: string;
    }) => {
      validated.push({ hostId: driver.hostId, userId, path, intent });
      return Promise.resolve({ realPath: path });
    },
  } as unknown as PathGuardService;

  const queries: Array<{ hostId: string; paths: string[] }> = [];
  const prisma = {
    fileHashes: {
      findMany: ({ where }: { where: { hostId: string; path: { in: string[] } } }) => {
        queries.push({ hostId: where.hostId, paths: where.path.in });
        const rows = (fixture.digests?.[where.hostId] ?? []).filter((row) => where.path.in.includes(row.path));
        return Promise.resolve(rows);
      },
    },
  } as unknown as PrismaService;

  return { service: new CompareService(prisma, factory, guard), driverA, driverB, validated, queries };
}

const pair = { a: { hostId: HOST_A, path: "/a" }, b: { hostId: HOST_B, path: "/b" } };

describe("what reaches the hosts", () => {
  it("validates both roots, on their own host, for this account", async () => {
    const { service, validated } = build();

    await service.compare(USER, pair);

    expect(validated).toEqual([
      { hostId: HOST_A, userId: USER, path: "/a", intent: "read" },
      { hostId: HOST_B, userId: USER, path: "/b", intent: "read" },
    ]);
  });

  it("answers about the resolved roots, not the ones asked for", async () => {
    // A symlinked root is stored — and later joined against — under its real
    // name, which is the same rule the scan panel follows.
    const { service } = build();

    const result = await service.compare(USER, pair);

    expect(result.a).toEqual({ hostId: HOST_A, path: "/a" });
    expect(result.b).toEqual({ hostId: HOST_B, path: "/b" });
  });

  it("releases both drivers", async () => {
    const { service, driverA, driverB } = build();

    await service.compare(USER, pair);

    expect([driverA.disposed, driverB.disposed]).toEqual([true, true]);
  });

  it("releases the first driver when the second host refuses", async () => {
    // Nothing else would ever release it, and over SSH that is a pooled
    // connection held until the idle timer notices.
    const { service, driverA } = build({ secondHostFails: true });

    await expect(service.compare(USER, pair)).rejects.toThrow();
    expect(driverA.disposed).toBe(true);
  });
});

describe("what the cache settles", () => {
  const same = { a: { "/a": [file("x", 10, 1_000)] }, b: { "/b": [file("x", 10, 1_000)] } };

  it("calls two current digests that agree identical", async () => {
    const { service } = build({
      ...same,
      digests: {
        [HOST_A]: [{ path: "/a/x", digest: "aa", size: 10n, mtimeMs: 1_000n }],
        [HOST_B]: [{ path: "/b/x", digest: "aa", size: 10n, mtimeMs: 1_000n }],
      },
    });

    const result = await service.compare(USER, pair);

    expect(result.entries[0]).toMatchObject({ verdict: "identical", reason: "hash" });
    expect(result.summary).toMatchObject({ identical: 1, inconclusive: 0, hashable: 0 });
  });

  it("calls two current digests that disagree a difference", async () => {
    // The case level 2 could never reach: same name, same size, same mtime,
    // different bytes.
    const { service } = build({
      ...same,
      digests: {
        [HOST_A]: [{ path: "/a/x", digest: "aa", size: 10n, mtimeMs: 1_000n }],
        [HOST_B]: [{ path: "/b/x", digest: "bb", size: 10n, mtimeMs: 1_000n }],
      },
    });

    const result = await service.compare(USER, pair);

    expect(result.entries[0]).toMatchObject({ verdict: "differs", reason: "hash" });
  });

  it("ignores a digest the file has moved on from", async () => {
    // A checksum of bytes that have since been overwritten is the one output
    // somebody would act on without checking, so it settles nothing.
    const { service } = build({
      ...same,
      digests: {
        [HOST_A]: [{ path: "/a/x", digest: "aa", size: 10n, mtimeMs: 5n }],
        [HOST_B]: [{ path: "/b/x", digest: "aa", size: 10n, mtimeMs: 1_000n }],
      },
    });

    const result = await service.compare(USER, pair);

    expect(result.entries[0]).toMatchObject({ verdict: "inconclusive", reason: "hash" });
  });

  it("settles nothing on one digest alone", async () => {
    const { service } = build({
      ...same,
      digests: { [HOST_A]: [{ path: "/a/x", digest: "aa", size: 10n, mtimeMs: 1_000n }] },
    });

    const result = await service.compare(USER, pair);

    expect(result.entries[0]).toMatchObject({ verdict: "inconclusive" });
  });

  it("asks for the digests in two queries, not two per row", async () => {
    // A comparison can carry two thousand rows, and a round trip each would be
    // the slowest part of the whole feature.
    const many = Array.from({ length: 40 }, (_, index) => file(`f${index}`));
    const { service, queries } = build({ a: { "/a": [...many] }, b: { "/b": [...many] } });

    await service.compare(USER, pair);

    expect(queries).toHaveLength(2);
    expect(queries[0].paths).toHaveLength(40);
  });

  it("asks for nothing when no row could be settled by a checksum", async () => {
    const { service, queries } = build({ a: { "/a": [file("x", 1)] }, b: { "/b": [file("x", 2)] } });

    await service.compare(USER, pair);

    expect(queries).toHaveLength(0);
  });
});

describe("the summary", () => {
  it("counts every verdict, and the hashable rows within them", async () => {
    const { service } = build({
      a: { "/a": [file("onlyA"), file("same", 5, 5), file("bigger", 1, 1)] },
      b: { "/b": [file("onlyB"), file("same", 5, 5), file("bigger", 2, 1)] },
    });

    const result = await service.compare(USER, pair);

    expect(result.summary).toEqual({
      total: 4,
      onlyA: 1,
      onlyB: 1,
      differs: 1,
      identical: 0,
      inconclusive: 1,
      hashable: 1,
    });
  });

  it("hands over the absolute paths a checksum pass would ask for", async () => {
    const { service } = build({ a: { "/a": [file("x", 5, 5)] }, b: { "/b": [file("x", 5, 5)] } });

    const result = await service.compare(USER, pair);

    expect(result.hashable).toEqual({ a: ["/a/x"], b: ["/b/x"] });
  });

  it("sends the ceiling that was in force, so the client hardcodes nothing", async () => {
    const { service } = build();

    const result = await service.compare(USER, pair);

    expect(result.maxEntries).toBeGreaterThan(0);
    expect(result.depth).toBe(3);
  });
});
