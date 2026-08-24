import { chmod, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { RateLimitService } from "@audit/rate-limit.service";
import { LocalDriver } from "@hosts/drivers/local.driver";
import type { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { SudoService } from "@hosts/sudo/sudo.service";
import { PermissionSnapshotService } from "@fs/permission-snapshot.service";
import { PermissionsUndoService } from "@fs/permissions-undo.service";

import type { AuditService } from "@audit/audit.service";
import type { PrismaService } from "../prisma/prisma.service";
import type { RedisService } from "@redis/redis.service";

const HOST_ID = "host-under-test";
const USER_ID = "user-1";

let base: string;

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

const silentAudit = { refused: () => Promise.resolve() } as unknown as AuditService;
const writeRoot = () => [{ path: base, access: "WRITE" as const }];

interface FakeRow {
  id: string;
  userId: string;
  kind: string;
  hostId: string | null;
}

interface FakeSnapshotRow {
  activityLogId: string;
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

function serviceFor(
  roots: { path: string; access: "READ" | "WRITE" }[],
  rows: FakeRow[],
): { service: PermissionsUndoService; snapshotRows: FakeSnapshotRow[] } {
  const snapshotRows: FakeSnapshotRow[] = [];

  const prisma = {
    hosts: {
      findFirst: ({ where }: { where: { id: string; userId: string } }) =>
        Promise.resolve(
          where.id === HOST_ID && where.userId === USER_ID
            ? { id: HOST_ID, userId: USER_ID, transport: "LOCAL", roots, user: { role: "MEMBER" } }
            : null,
        ),
    },
    activityLog: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
    },
    permissionSnapshots: {
      findMany: ({ where }: { where: { activityLogId: string } }) =>
        Promise.resolve(
          snapshotRows
            .filter((row) => row.activityLogId === where.activityLogId)
            .map((row) => ({ path: row.path, mode: row.mode, uid: row.uid, gid: row.gid })),
        ),
    },
  } as unknown as PrismaService;

  const guard = new PathGuardService(prisma, [join(base, "install")], memoryLimits(), silentAudit);
  const factory = { forHost: () => Promise.resolve(new LocalDriver(HOST_ID)) } as unknown as HostDriverFactory;
  const snapshots = new PermissionSnapshotService(prisma);
  const service = new PermissionsUndoService(
    prisma,
    factory,
    guard,
    new SudoRunnerService(new SudoService()),
    snapshots,
  );

  return { service, snapshotRows };
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "trekker-permissions-undo-")));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("PermissionsUndoService.undoChmod", () => {
  it("restores each entry's own previous mode, not one shared value", async () => {
    const a = join(base, "undo-a.txt");
    const b = join(base, "undo-b.txt");
    await writeFile(a, "x");
    await writeFile(b, "y");
    await chmod(a, 0o755);
    await chmod(b, 0o755);

    const { service, snapshotRows } = serviceFor(writeRoot(), [
      { id: "activity-1", userId: USER_ID, kind: "file.chmod", hostId: HOST_ID },
    ]);
    snapshotRows.push(
      { activityLogId: "activity-1", path: a, mode: 0o644, uid: -1, gid: -1 },
      { activityLogId: "activity-1", path: b, mode: 0o600, uid: -1, gid: -1 },
    );

    const result = await service.undoChmod(USER_ID, "activity-1");

    expect(result.restored).toBe(2);
    expect(await modeOf(a)).toBe(0o644);
    expect(await modeOf(b)).toBe(0o600);
  });

  it("skips a path that has since been removed, and reports it rather than stopping", async () => {
    const gone = join(base, "undo-gone.txt");
    const still = join(base, "undo-still.txt");
    await writeFile(still, "x");
    await chmod(still, 0o755);

    const { service, snapshotRows } = serviceFor(writeRoot(), [
      { id: "activity-2", userId: USER_ID, kind: "file.chmod", hostId: HOST_ID },
    ]);
    snapshotRows.push(
      { activityLogId: "activity-2", path: gone, mode: 0o644, uid: -1, gid: -1 },
      { activityLogId: "activity-2", path: still, mode: 0o600, uid: -1, gid: -1 },
    );

    const result = await service.undoChmod(USER_ID, "activity-2");

    expect(result.restored).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.find((row) => row.path === gone)?.ok).toBe(false);
    expect(await modeOf(still)).toBe(0o600);
  });

  it("refuses an id that belongs to a different user, the same way as one that does not exist", async () => {
    const { service } = serviceFor(writeRoot(), [
      { id: "activity-3", userId: "someone-else", kind: "file.chmod", hostId: HOST_ID },
    ]);

    await expect(service.undoChmod(USER_ID, "activity-3")).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.undoChmod(USER_ID, "does-not-exist")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses to undo a chown as though it were a chmod", async () => {
    const { service } = serviceFor(writeRoot(), [
      { id: "activity-4", userId: USER_ID, kind: "file.chown", hostId: HOST_ID },
    ]);

    await expect(service.undoChmod(USER_ID, "activity-4")).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("PermissionsUndoService.undoChown", () => {
  it("restores uid and gid, and leaves mode alone", async () => {
    const file = join(base, "undo-chown.txt");
    await writeFile(file, "x");
    await chmod(file, 0o640);
    const before = await modeOf(file);

    const { service, snapshotRows } = serviceFor(writeRoot(), [
      { id: "activity-5", userId: USER_ID, kind: "file.chown", hostId: HOST_ID },
    ]);
    const currentUid = process.getuid?.() ?? 0;
    const currentGid = process.getgid?.() ?? 0;
    snapshotRows.push({ activityLogId: "activity-5", path: file, mode: 0o600, uid: currentUid, gid: currentGid });

    const result = await service.undoChown(USER_ID, "activity-5");

    expect(result.restored).toBe(1);
    expect(await modeOf(file)).toBe(before);
  });
});
