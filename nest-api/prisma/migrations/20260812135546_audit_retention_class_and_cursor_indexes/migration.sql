-- AlterTable
ALTER TABLE `ActivityLog` ADD COLUMN `destructive` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `ActivityLog_userId_id_idx` ON `ActivityLog`(`userId`, `id` DESC);

-- CreateIndex
CREATE INDEX `ActivityLog_destructive_createdAt_idx` ON `ActivityLog`(`destructive`, `createdAt`);
