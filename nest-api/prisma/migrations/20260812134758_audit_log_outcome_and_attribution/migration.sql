-- AlterTable
ALTER TABLE `ActivityLog` ADD COLUMN `bytes` BIGINT NULL,
    ADD COLUMN `detail` VARCHAR(255) NULL,
    ADD COLUMN `durationMs` INTEGER NULL,
    ADD COLUMN `elevated` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `outcome` ENUM('pending', 'success', 'failure', 'refused') NOT NULL DEFAULT 'pending',
    ADD COLUMN `sessionId` VARCHAR(128) NULL;

-- CreateIndex
CREATE INDEX `ActivityLog_userId_kind_id_idx` ON `ActivityLog`(`userId`, `kind`, `id` DESC);

-- CreateIndex
CREATE INDEX `ActivityLog_userId_hostId_id_idx` ON `ActivityLog`(`userId`, `hostId`, `id` DESC);

-- CreateIndex
CREATE INDEX `ActivityLog_outcome_id_idx` ON `ActivityLog`(`outcome`, `id`);
