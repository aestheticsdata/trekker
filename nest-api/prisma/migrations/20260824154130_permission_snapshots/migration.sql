-- The old mode/uid/gid of every entry a chmod or chown actually changed,
-- saved so an undo has something to restore (TRE-75).
--
-- One row per entry — the walk (or a single `stat` for a non-recursive
-- change) already has these values in hand, so writing them is never a
-- second fetch. `path` is `TEXT` and unindexed, matching `DiskScanEntries`:
-- every lookup here is by `activityLogId`, never by path.
--
-- Pruned on its own 30-day schedule by `RetentionService`, independent of
-- `ActivityLog`'s own 90/365-day retention — the audit summary line should
-- outlive the ability to undo it. `ON DELETE CASCADE` is a referential
-- backstop for the case an `ActivityLog` row is ever deleted before its own
-- snapshots have aged out; the independent 30-day pass is what actually
-- removes these rows in the ordinary case.

-- CreateTable
CREATE TABLE `PermissionSnapshots` (
    `id` CHAR(36) NOT NULL,
    `activityLogId` CHAR(36) NOT NULL,
    `path` TEXT NOT NULL,
    `mode` INTEGER NOT NULL,
    `uid` INTEGER NOT NULL,
    `gid` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PermissionSnapshots_activityLogId_idx`(`activityLogId`),
    INDEX `PermissionSnapshots_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PermissionSnapshots` ADD CONSTRAINT `PermissionSnapshots_activityLogId_fkey` FOREIGN KEY (`activityLogId`) REFERENCES `ActivityLog`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
