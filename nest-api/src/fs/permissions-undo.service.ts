import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isDriverError } from "@hosts/drivers/driver-error";
import type { HostDriver } from "@hosts/drivers/host-driver";
import { HostDriverFactory } from "@hosts/drivers/host-driver.factory";
import { PathGuardService } from "@hosts/path-guard/path-guard.service";
import { chmodArgv, chownArgv } from "@hosts/sudo/sudo-argv";
import { isPermissionRefusal, SudoRunnerService } from "@hosts/sudo/sudo-runner.service";
import { toHttp } from "@fs/driver-http";
import { failure } from "@fs/permissions.service";
import { PermissionSnapshotService, type RestoreEntry } from "@fs/permission-snapshot.service";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Undoing a chmod or chown (TRE-75) — restoring exactly what a previous
 * operation changed, from the snapshot it left behind.
 *
 * Deliberately not a call into `PermissionsService.apply()`: an undo never
 * re-walks (the paths are exactly the snapshot's, not rediscovered), each
 * entry can restore a *different* value (a mass chmod's undo puts back
 * whatever each file individually had, not one shared mode), and a path
 * that has vanished or changed is skipped and the rest continue — where the
 * original operation deliberately stops at the first failure on a path.
 */

export interface UndoOutcome {
  path: string;
  ok: boolean;
  code?: string;
  message?: string;
}

export interface UndoResult {
  results: UndoOutcome[];
  restored: number;
  failed: number;
  elevated: number;
  hostId: string;
}

type Elevated = { program: "chmod" | "chown"; argv: (target: string) => string[] };

@Injectable()
export class PermissionsUndoService {
  private readonly logger = new Logger(PermissionsUndoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: HostDriverFactory,
    private readonly guard: PathGuardService,
    private readonly sudoRunner: SudoRunnerService,
    private readonly snapshots: PermissionSnapshotService,
  ) {}

  async undoChmod(userId: string, activityLogId: string, sessionId?: string): Promise<UndoResult> {
    const { hostId } = await this.rowFor(userId, activityLogId, "file.chmod");
    const entries = await this.snapshots.listFor(activityLogId);
    const driver = await this.driverFor(hostId, userId);

    const result = await this.restore(
      driver,
      userId,
      entries,
      (target, entry) => driver.chmod(target, entry.mode),
      (entry) => ({ program: "chmod", argv: (target: string) => chmodArgv(entry.mode, target) }),
      sessionId,
      hostId,
    );
    return { ...result, hostId };
  }

  async undoChown(userId: string, activityLogId: string, sessionId?: string): Promise<UndoResult> {
    const { hostId } = await this.rowFor(userId, activityLogId, "file.chown");
    const entries = await this.snapshots.listFor(activityLogId);
    const driver = await this.driverFor(hostId, userId);

    const result = await this.restore(
      driver,
      userId,
      entries,
      (target, entry) => driver.chown(target, entry.uid, entry.gid),
      (entry) => ({ program: "chown", argv: (target: string) => chownArgv(entry.uid, entry.gid, target) }),
      sessionId,
      hostId,
    );
    return { ...result, hostId };
  }

  /**
   * One field set restored per entry — never both, even though every
   * snapshot row carries mode, uid and gid (free, from the same walk): the
   * caller passes exactly the `change`/`elevatedFor` pair for the operation
   * being undone, and nothing else is touched.
   */
  private async restore(
    driver: HostDriver,
    userId: string,
    entries: readonly RestoreEntry[],
    change: (target: string, entry: RestoreEntry) => Promise<void>,
    elevatedFor: (entry: RestoreEntry) => Elevated,
    sessionId: string | undefined,
    hostId: string,
  ): Promise<Omit<UndoResult, "hostId">> {
    const results: UndoOutcome[] = [];
    let restored = 0;
    let elevatedCount = 0;

    for (const entry of entries) {
      let realPath: string;
      try {
        const validated = await this.guard.validate({ driver, userId, path: entry.path, intent: "write" });
        realPath = validated.realPath;
      } catch (error) {
        results.push(toUndoOutcome(entry.path, error));
        continue;
      }

      try {
        await change(realPath, entry);
        results.push({ path: entry.path, ok: true });
        restored += 1;
      } catch (error) {
        if (isPermissionRefusal(error) && this.sudoRunner.isOpen(sessionId, hostId)) {
          const elevated = elevatedFor(entry);
          try {
            await this.sudoRunner.run(driver, sessionId, hostId, elevated.program, elevated.argv(realPath));
            results.push({ path: entry.path, ok: true });
            restored += 1;
            elevatedCount += 1;
            continue;
          } catch (elevatedError) {
            results.push(toUndoOutcome(entry.path, elevatedError));
            continue;
          }
        }
        results.push(toUndoOutcome(entry.path, error));
      }
    }

    return { results, restored, failed: results.length - restored, elevated: elevatedCount };
  }

  private async rowFor(
    userId: string,
    activityLogId: string,
    kind: "file.chmod" | "file.chown",
  ): Promise<{ hostId: string }> {
    const row = await this.prisma.activityLog.findUnique({
      where: { id: activityLogId },
      select: { userId: true, kind: true, hostId: true },
    });
    if (!row || row.userId !== userId || row.kind !== kind || row.hostId === null) {
      // The same answer either way: an id that does not exist, one that
      // belongs to someone else, and one of the wrong kind are all "there is
      // nothing here for you to undo" — never distinguished, so a guess
      // teaches an attacker nothing about ids that are not theirs.
      throw new NotFoundException("Nothing to undo.");
    }
    return { hostId: row.hostId };
  }

  private async driverFor(hostId: string, userId: string): Promise<HostDriver> {
    try {
      return await this.factory.forHost(hostId, userId);
    } catch (error) {
      if (isDriverError(error)) throw toHttp(error);
      throw error;
    }
  }
}

function toUndoOutcome(path: string, error: unknown): UndoOutcome {
  const outcome = failure(path, error);
  return { path: outcome.path, ok: false, code: outcome.code, message: outcome.message };
}
