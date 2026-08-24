import { PermissionSnapshotService } from "@fs/permission-snapshot.service";

import type { PrismaService } from "../prisma/prisma.service";

function fakePrisma(): { prisma: PrismaService; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const prisma = {
    permissionSnapshots: {
      createMany: ({ data }: { data: Array<Record<string, unknown>> }) => {
        rows.push(...data);
        return Promise.resolve({ count: data.length });
      },
      findMany: ({ where }: { where: { activityLogId: string } }) =>
        Promise.resolve(
          rows
            .filter((row) => row.activityLogId === where.activityLogId)
            .map((row) => ({ path: row.path, mode: row.mode, uid: row.uid, gid: row.gid })),
        ),
    },
  } as unknown as PrismaService;
  return { prisma, rows };
}

describe("PermissionSnapshotService", () => {
  it("records nothing for an empty batch", async () => {
    const { prisma, rows } = fakePrisma();
    const service = new PermissionSnapshotService(prisma);

    await service.record([]);

    expect(rows).toEqual([]);
  });

  it("round-trips what it records, scoped to one activity row", async () => {
    const { prisma } = fakePrisma();
    const service = new PermissionSnapshotService(prisma);

    await service.record([
      { activityLogId: "a1", path: "/tmp/one", mode: 0o644, uid: 1000, gid: 1000 },
      { activityLogId: "a1", path: "/tmp/two", mode: 0o600, uid: 1000, gid: 1000 },
      { activityLogId: "a2", path: "/tmp/other", mode: 0o755, uid: 0, gid: 0 },
    ]);

    const restored = await service.listFor("a1");

    expect(restored).toEqual([
      { path: "/tmp/one", mode: 0o644, uid: 1000, gid: 1000 },
      { path: "/tmp/two", mode: 0o600, uid: 1000, gid: 1000 },
    ]);
  });
});
