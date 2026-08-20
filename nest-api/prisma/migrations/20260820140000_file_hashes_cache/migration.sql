-- TRE-27. One table, and no table for the jobs that fill it.
--
-- A hash job is deliberately not persisted. It writes one row per file as that
-- file finishes, so an API restart mid-job loses the job and keeps every digest
-- it had already earned — there is no partial state to reconcile and therefore
-- no `runningSlot` to hold and no boot sweep to write. That is the opposite of
-- `DiskScans`, which produces a single answer at the end and must be swept, and
-- the difference is the shape of the work rather than a preference.
--
-- The unique key is (hostId, path) and not (hostId, path, size, mtimeMs). Both
-- answer a lookup; only this one keeps the table the size of the filesystem
-- rather than the size of its history. A digest of bytes that have since been
-- overwritten is unreachable by every query this application makes, and keeping
-- it would mean growing a row per save of every file anybody ever hashed.
--
-- No prefix on that key: CHAR(36) plus VARCHAR(700) is 2 944 bytes at four per
-- character, inside InnoDB's 3 072-byte limit. The scan indexes next door are
-- prefixed at 191 because they carry a `startedAt` as well.
-- CreateTable
CREATE TABLE `FileHashes` (
    `id` CHAR(36) NOT NULL,
    `hostId` CHAR(36) NOT NULL,
    `path` VARCHAR(700) NOT NULL,
    `digest` CHAR(64) NOT NULL,
    `size` BIGINT NOT NULL,
    `mtimeMs` BIGINT NOT NULL,
    `method` ENUM('REMOTE', 'STREAMED') NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `FileHashes_hostId_computedAt_idx`(`hostId`, `computedAt` DESC),
    UNIQUE INDEX `FileHashes_hostId_path_key`(`hostId`, `path`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CASCADE, like every other table that only makes sense with its host. A
-- checksum of a path on a machine this install no longer knows is not a fact
-- anybody can act on, and the schema's first rule says it goes with the host.
-- AddForeignKey
ALTER TABLE `FileHashes` ADD CONSTRAINT `FileHashes_hostId_fkey` FOREIGN KEY (`hostId`) REFERENCES `Hosts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
