import { BadRequestException, NotFoundException } from "@nestjs/common";
import { MAX_FILES_PER_JOB, MAX_JOB_BYTES } from "@hashes/hash-limits";
import { HashService } from "@hashes/hash.service";

import type { FileEntry, FileKind, FileStat } from "@hosts/drivers/host-driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import type { PathGuardService } from "@hosts/path-guard/path-guard.service";
import type { HashJob } from "@hashes/hash-runner.service";
import type { HashQueueService } from "@hashes/hash-queue.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * Accepting a job, and answering for one path (TRE-27).
 *
 * Two of these have a wrong answer that looks perfectly reasonable. A selection
 * over the bounds could be accepted and simply take an hour, which the ticket
 * forbids in as many words — "refused with the numbers". And a cached digest
 * could be served for a file that has since changed, which is the failure the
 * ticket calls out as worse than having no checksum at all.
 *
 * The third thing worth a test is the symlink: a link inside a selected
 * directory is not hashed, because the guard validated what the client sent and
 * nobody validated what a link three levels down points at.
 */

const USER = "user-1";
const HOST = "host-1";

interface Node {
  kind: FileKind;
  size?: number;
  mtimeMs?: number;
  /** For a directory: what `list()` returns. */
  children?: string[];
}

/** A host as a flat path → node map, which is all the walk ever asks about. */
class FakeDriver {
  readonly hostId = HOST;
  disposed = false;

  constructor(private readonly tree: Record<string, Node>) {}

  private node(path: string): Node {
    const node = this.tree[path];
    if (!node) throw Object.assign(new Error(`no such path ${path}`), { code: "ENOENT" });
    return node;
  }

  stat = (path: string): Promise<FileStat> => {
    const node = this.node(path);
    return Promise.resolve({
      path,
      name: path.split("/").pop() ?? path,
      kind: node.kind,
      size: node.size ?? 0,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtimeMs: node.mtimeMs ?? 100,
    });
  };

  list = (path: string): Promise<FileEntry[]> => {
    const node = this.node(path);
    if (node.kind !== "directory") throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    return Promise.resolve(
      (node.children ?? []).map((child) => {
        const entry = this.node(`${path}/${child}`);
        return {
          name: child,
          kind: entry.kind,
          size: entry.size ?? 0,
          mode: 0o644,
          uid: 0,
          gid: 0,
          mtimeMs: entry.mtimeMs ?? 100,
        };
      }),
    );
  };

  dispose = (): Promise<void> => {
    this.disposed = true;
    return Promise.resolve();
  };
}

interface Fixture {
  tree?: Record<string, Node>;
  /** The `FileHashes` row for the path under test, if there is one. */
  row?: { digest: string; size: bigint; mtimeMs: bigint; method: "REMOTE" | "STREAMED"; computedAt: Date } | null;
  covering?: { id: string; hostId: string; files: number; bytesTotal: bigint; queued: boolean } | null;
}

function build(fixture: Fixture = {}) {
  const driver = new FakeDriver(fixture.tree ?? { "/srv/a": { kind: "file", size: 4, mtimeMs: 100 } });
  const factory = { forHost: () => Promise.resolve(driver) } as unknown as HostDriverFactory;
  // The guard resolves and permits; refusing is its own spec's subject. What
  // matters here is that every path goes through it — see the test below.
  const validated: string[] = [];
  const guard = {
    validate: ({ path }: { path: string }) => {
      validated.push(path);
      return Promise.resolve({ realPath: path });
    },
  } as unknown as PathGuardService;

  const enqueued: HashJob[] = [];
  const queue = {
    enqueue: (job: HashJob) => {
      enqueued.push(job);
      // The real queue answers with what it decided, including whether the job
      // had to wait. A double that returned nothing would let the service read
      // `undefined` off it and nothing here would notice.
      return { id: job.id, hostId: job.hostId, files: job.targets.length, bytesTotal: job.bytesTotal, queued: false };
    },
    covering: () => fixture.covering ?? null,
    cancel: (_userId: string, jobId: string) => (jobId === "job-1" ? "running" : "unknown"),
  } as unknown as HashQueueService;

  const prisma = {
    fileHashes: { findUnique: () => Promise.resolve(fixture.row ?? null) },
  } as unknown as PrismaService;

  return { service: new HashService(prisma, factory, guard, queue), driver, enqueued, validated };
}

describe("accepting a job", () => {
  it("queues one file as one target", async () => {
    const { service, enqueued } = build();

    const view = await service.start(USER, { hostId: HOST, paths: ["/srv/a"] });

    expect(view).toMatchObject({ files: 1, bytesTotal: "4", queued: false });
    expect(enqueued[0].targets).toEqual([{ path: "/srv/a", size: 4n, mtimeMs: 100n }]);
  });

  it("sends every path through the guard", async () => {
    // Not a formality. The guard is what resolves a path to its real one, so a
    // selection that reaches the queue unvalidated is a selection that can walk
    // out of the configured roots.
    const { service, validated } = build({
      tree: { "/srv/a": { kind: "file", size: 1 }, "/srv/b": { kind: "file", size: 2 } },
    });

    await service.start(USER, { hostId: HOST, paths: ["/srv/a", "/srv/b"] });

    expect(validated).toEqual(["/srv/a", "/srv/b"]);
  });

  it("expands a directory into the files under it", async () => {
    const { service, enqueued } = build({
      tree: {
        "/srv": { kind: "directory", children: ["a", "sub"] },
        "/srv/a": { kind: "file", size: 4 },
        "/srv/sub": { kind: "directory", children: ["b"] },
        "/srv/sub/b": { kind: "file", size: 6 },
      },
    });

    const view = await service.start(USER, { hostId: HOST, paths: ["/srv"] });

    expect(view.files).toBe(2);
    expect(enqueued[0].targets.map((entry) => entry.path).sort()).toEqual(["/srv/a", "/srv/sub/b"]);
    expect(view.bytesTotal).toBe("10");
  });

  it("never hashes a symlink found inside a directory", async () => {
    // Hashing it would read whatever it points at, which may be anywhere. The
    // guard validated the directory the client named; it validated nothing
    // about a link discovered three levels down. Same rule the recursive chmod
    // and the transfer walk already follow.
    const { service, enqueued } = build({
      tree: {
        "/srv": { kind: "directory", children: ["a", "link"] },
        "/srv/a": { kind: "file", size: 4 },
        "/srv/link": { kind: "symlink", size: 9 },
      },
    });

    await service.start(USER, { hostId: HOST, paths: ["/srv"] });

    expect(enqueued[0].targets.map((entry) => entry.path)).toEqual(["/srv/a"]);
  });

  it("counts a file named twice once", async () => {
    // Selecting a directory and a file inside it is an ordinary gesture, and
    // hashing that file twice would double its bytes in the total and its
    // progress on the feed.
    const { service, enqueued } = build({
      tree: {
        "/srv": { kind: "directory", children: ["a"] },
        "/srv/a": { kind: "file", size: 4 },
      },
    });

    const view = await service.start(USER, { hostId: HOST, paths: ["/srv", "/srv/a"] });

    expect(view.files).toBe(1);
    expect(enqueued[0].bytesTotal).toBe(4n);
  });

  it("leaves a socket or a device out rather than refusing the selection", async () => {
    const { service, enqueued } = build({
      tree: {
        "/srv": { kind: "directory", children: ["a", "sock"] },
        "/srv/a": { kind: "file", size: 4 },
        "/srv/sock": { kind: "socket" },
      },
    });

    await service.start(USER, { hostId: HOST, paths: ["/srv"] });

    expect(enqueued[0].targets.map((entry) => entry.path)).toEqual(["/srv/a"]);
  });

  it("refuses a selection with nothing hashable in it", async () => {
    const { service, enqueued } = build({ tree: { "/srv": { kind: "directory", children: [] } } });

    await expect(service.start(USER, { hostId: HOST, paths: ["/srv"] })).rejects.toBeInstanceOf(BadRequestException);
    expect(enqueued).toHaveLength(0);
  });

  it("releases the driver before the job runs", async () => {
    // A job may wait minutes in line, and holding a pooled SSH channel for the
    // whole of it would take a connection out of circulation to do nothing.
    const { service, driver } = build();

    await service.start(USER, { hostId: HOST, paths: ["/srv/a"] });

    expect(driver.disposed).toBe(true);
  });
});

describe("the bounds", () => {
  it("refuses a tree over the file count, with the number", async () => {
    const tree: Record<string, Node> = {
      "/srv": { kind: "directory", children: [] },
    };
    const children: string[] = [];
    for (let index = 0; index <= MAX_FILES_PER_JOB + 1; index += 1) {
      children.push(`f${index}`);
      tree[`/srv/f${index}`] = { kind: "file", size: 1 };
    }
    tree["/srv"] = { kind: "directory", children };
    const { service, enqueued } = build({ tree });

    await expect(service.start(USER, { hostId: HOST, paths: ["/srv"] })).rejects.toThrow(
      new RegExp(String(MAX_FILES_PER_JOB)),
    );
    expect(enqueued).toHaveLength(0);
  });

  it("refuses a selection over the byte budget, with both figures", async () => {
    const huge = Number(MAX_JOB_BYTES / 2n) + 1;
    const { service, enqueued } = build({
      tree: { "/srv/a": { kind: "file", size: huge }, "/srv/b": { kind: "file", size: huge } },
    });

    // "Refused with the numbers", which is the difference between a refusal
    // somebody can act on and one they can only be annoyed by.
    await expect(service.start(USER, { hostId: HOST, paths: ["/srv/a", "/srv/b"] })).rejects.toThrow(/GiB/);
    expect(enqueued).toHaveLength(0);
  });

  it("accepts a selection right at the byte budget", async () => {
    const { service, enqueued } = build({
      tree: { "/srv/a": { kind: "file", size: Number(MAX_JOB_BYTES) } },
    });

    await service.start(USER, { hostId: HOST, paths: ["/srv/a"] });

    expect(enqueued).toHaveLength(1);
  });
});

describe("answering for one path", () => {
  const digest = "c".repeat(64);

  it("serves a cached digest that still describes the file", async () => {
    const { service } = build({
      row: { digest, size: 4n, mtimeMs: 100n, method: "REMOTE", computedAt: new Date(0) },
    });

    const state = await service.state(USER, HOST, "/srv/a");

    expect(state.hash).toMatchObject({ digest, method: "REMOTE", path: "/srv/a" });
    expect(state.superseded).toBe(false);
  });

  it("withholds a digest whose file has changed since", async () => {
    // The claim that makes the cache safe. A digest for bytes that are no
    // longer there is the one output somebody would act on without checking,
    // so it is not returned at all — not returned with a flag.
    const { service } = build({
      tree: { "/srv/a": { kind: "file", size: 9, mtimeMs: 900 } },
      row: { digest, size: 4n, mtimeMs: 100n, method: "REMOTE", computedAt: new Date(0) },
    });

    const state = await service.state(USER, HOST, "/srv/a");

    expect(state.hash).toBeNull();
    // Said out loud, so the panel can distinguish "never hashed" from "hashed,
    // and then the file moved on".
    expect(state.superseded).toBe(true);
  });

  it("says nothing is cached when nothing is", async () => {
    const { service } = build({ row: null });

    const state = await service.state(USER, HOST, "/srv/a");

    expect(state).toMatchObject({ hash: null, superseded: false, running: null });
  });

  it("reports the job that is about to produce one", async () => {
    const { service } = build({
      covering: { id: "job-7", hostId: HOST, files: 3, bytesTotal: 90n, queued: false },
    });

    const state = await service.state(USER, HOST, "/srv/a");

    expect(state.running).toMatchObject({ id: "job-7", files: 3, bytesTotal: "90" });
  });
});

describe("stopping one", () => {
  it("stops a job this account owns", () => {
    const { service } = build();

    expect(service.cancel(USER, "job-1")).toEqual({ id: "job-1", stopped: true });
  });

  it("answers 404 for a job the queue does not hold for this account", () => {
    // Never a 403: the response must not confirm the id exists.
    const { service } = build();

    expect(() => service.cancel(USER, "job-other")).toThrow(NotFoundException);
  });
});
