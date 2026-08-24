import { Injectable } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Old mode/uid/gid, one row per entry a chmod or chown actually changed
 * (TRE-75). Written from data the walk or a single `stat` already had in
 * hand; read back only when somebody undoes the operation that wrote them.
 */
export interface SnapshotEntry {
  activityLogId: string;
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

export interface RestoreEntry {
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

@Injectable()
export class PermissionSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entries: readonly SnapshotEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.prisma.permissionSnapshots.createMany({ data: entries as SnapshotEntry[] });
  }

  async listFor(activityLogId: string): Promise<RestoreEntry[]> {
    return this.prisma.permissionSnapshots.findMany({
      where: { activityLogId },
      select: { path: true, mode: true, uid: true, gid: true },
    });
  }
}
