import { RetentionService } from "@audit/retention.service";

import type { PrismaService } from "../prisma/prisma.service";

interface FakeSnapshotRow {
  id: string;
  createdAt: Date;
}

function fakePrisma(rows: FakeSnapshotRow[]): PrismaService {
  return {
    activityLog: {
      findMany: () => Promise.resolve([]),
      deleteMany: () => Promise.resolve({ count: 0 }),
    },
    permissionSnapshots: {
      findMany: ({ where, take }: { where: { createdAt: { lt: Date } }; take: number }) =>
        Promise.resolve(
          rows
            .filter((row) => row.createdAt < where.createdAt.lt)
            .slice(0, take)
            .map((row) => ({ id: row.id })),
        ),
      deleteMany: ({ where }: { where: { id: { in: string[] } } }) => {
        const before = rows.length;
        const doomed = new Set(where.id.in);
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (doomed.has(rows[index].id)) rows.splice(index, 1);
        }
        return Promise.resolve({ count: before - rows.length });
      },
    },
  } as unknown as PrismaService;
}

describe("RetentionService — permission snapshots (TRE-75)", () => {
  it("removes a snapshot older than 30 days and keeps a recent one", async () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    const old = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const recent = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const rows: FakeSnapshotRow[] = [
      { id: "old-1", createdAt: old },
      { id: "recent-1", createdAt: recent },
    ];

    const service = new RetentionService(fakePrisma(rows));
    const result = await service.prune(now);

    expect(result.snapshots).toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["recent-1"]);
  });

  it("removes nothing when every snapshot is within the window", async () => {
    const now = new Date("2026-08-24T00:00:00.000Z");
    const rows: FakeSnapshotRow[] = [{ id: "recent-1", createdAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) }];

    const service = new RetentionService(fakePrisma(rows));
    const result = await service.prune(now);

    expect(result.snapshots).toBe(0);
    expect(rows).toHaveLength(1);
  });
});
