-- CreateTable
CREATE TABLE `Users` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `recoveryPassphraseHash` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Hosts` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `slug` VARCHAR(64) NOT NULL,
    `label` VARCHAR(64) NOT NULL,
    `transport` ENUM('LOCAL', 'SSH') NOT NULL,
    `address` VARCHAR(255) NULL,
    `port` INTEGER NOT NULL DEFAULT 22,
    `username` VARCHAR(64) NULL,
    `colour` VARCHAR(16) NOT NULL DEFAULT '#7fa8c9',
    `homePath` VARCHAR(700) NOT NULL DEFAULT '/',
    `localSlot` BOOLEAN NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Hosts_userId_slug_key`(`userId`, `slug`),
    UNIQUE INDEX `Hosts_userId_localSlot_key`(`userId`, `localSlot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HostCredentials` (
    `id` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NOT NULL,
    `kind` ENUM('PRIVATE_KEY', 'PASSWORD', 'AGENT') NOT NULL,
    `ciphertext` BLOB NOT NULL,
    `iv` BINARY(12) NOT NULL,
    `authTag` BINARY(16) NOT NULL,
    `keyVersion` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `HostCredentials_hostId_key`(`hostId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HostKnownKeys` (
    `id` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NOT NULL,
    `algorithm` VARCHAR(32) NOT NULL,
    `fingerprint` VARCHAR(128) NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `verifiedAt` DATETIME(3) NULL,

    UNIQUE INDEX `HostKnownKeys_hostId_algorithm_key`(`hostId`, `algorithm`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `HostRoots` (
    `id` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NOT NULL,
    `path` VARCHAR(700) NOT NULL,
    `access` ENUM('READ', 'WRITE') NOT NULL DEFAULT 'READ',

    UNIQUE INDEX `HostRoots_hostId_path_key`(`hostId`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Bookmarks` (
    `id` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NOT NULL,
    `path` VARCHAR(700) NOT NULL,
    `label` VARCHAR(64) NOT NULL,
    `hint` VARCHAR(128) NULL,
    `position` INTEGER NOT NULL DEFAULT 0,

    INDEX `Bookmarks_hostId_position_idx`(`hostId`, `position`),
    UNIQUE INDEX `Bookmarks_hostId_path_key`(`hostId`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Views` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `shortcut` VARCHAR(32) NULL,
    `userId` CHAR(36) NOT NULL,
    `panes` JSON NOT NULL,
    `split` INTEGER NOT NULL DEFAULT 50,
    `solo` VARCHAR(16) NULL,
    `inspector` BOOLEAN NOT NULL DEFAULT true,
    `heat` BOOLEAN NOT NULL DEFAULT false,
    `glob` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Views_userId_name_key`(`userId`, `name`),
    UNIQUE INDEX `Views_userId_shortcut_key`(`userId`, `shortcut`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransferJobs` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `srcHostId` CHAR(36) NULL,
    `srcPath` TEXT NOT NULL,
    `dstHostId` CHAR(36) NULL,
    `dstPath` TEXT NOT NULL,
    `operation` ENUM('COPY', 'MOVE') NOT NULL,
    `options` JSON NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'PAUSED', 'DONE', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `bytesTotal` BIGINT NOT NULL DEFAULT 0,
    `bytesDone` BIGINT NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TransferJobs_userId_status_idx`(`userId`, `status`),
    INDEX `TransferJobs_userId_createdAt_idx`(`userId`, `createdAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransferItems` (
    `id` CHAR(36) NOT NULL,
    `jobId` CHAR(36) NOT NULL,
    `name` VARCHAR(700) NOT NULL,
    `bytes` BIGINT NOT NULL DEFAULT 0,
    `conflict` ENUM('ASK', 'OVERWRITE', 'SKIP', 'RENAME', 'RESUME') NOT NULL DEFAULT 'ASK',
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'SKIPPED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `error` TEXT NULL,

    INDEX `TransferItems_jobId_status_idx`(`jobId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DiskScans` (
    `id` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NOT NULL,
    `root` VARCHAR(700) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `totalBytes` BIGINT NULL,
    `inodes` BIGINT NULL,
    `status` ENUM('RUNNING', 'DONE', 'FAILED') NOT NULL DEFAULT 'RUNNING',

    INDEX `DiskScans_hostId_startedAt_idx`(`hostId`, `startedAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DiskScanEntries` (
    `id` CHAR(36) NOT NULL,
    `scanId` CHAR(36) NOT NULL,
    `path` TEXT NOT NULL,
    `bytes` BIGINT NOT NULL,
    `percent` DECIMAL(5, 2) NOT NULL,

    INDEX `DiskScanEntries_scanId_bytes_idx`(`scanId`, `bytes` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ActivityLog` (
    `id` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NULL,
    `kind` VARCHAR(32) NOT NULL,
    `summary` VARCHAR(255) NOT NULL,
    `tag` VARCHAR(32) NULL,
    `payload` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ActivityLog_userId_createdAt_idx`(`userId`, `createdAt` DESC),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Hosts` ADD CONSTRAINT `Hosts_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HostCredentials` ADD CONSTRAINT `HostCredentials_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Hosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HostKnownKeys` ADD CONSTRAINT `HostKnownKeys_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Hosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `HostRoots` ADD CONSTRAINT `HostRoots_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Hosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Bookmarks` ADD CONSTRAINT `Bookmarks_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Hosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Views` ADD CONSTRAINT `Views_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferJobs` ADD CONSTRAINT `TransferJobs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferJobs` ADD CONSTRAINT `TransferJobs_srcHostId_fkey` FOREIGN KEY (`srcHostId`) REFERENCES `Hosts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferJobs` ADD CONSTRAINT `TransferJobs_dstHostId_fkey` FOREIGN KEY (`dstHostId`) REFERENCES `Hosts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransferItems` ADD CONSTRAINT `TransferItems_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `TransferJobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DiskScans` ADD CONSTRAINT `DiskScans_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Hosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DiskScanEntries` ADD CONSTRAINT `DiskScanEntries_scanId_fkey` FOREIGN KEY (`scanId`) REFERENCES `DiskScans`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ActivityLog` ADD CONSTRAINT `ActivityLog_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `Users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ActivityLog` ADD CONSTRAINT `ActivityLog_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Hosts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
