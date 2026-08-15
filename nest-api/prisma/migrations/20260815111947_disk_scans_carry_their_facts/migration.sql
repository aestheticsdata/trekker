-- TRE-32. `DiskScans` and `DiskScanEntries` were laid out by TRE-6 and have
-- never had a writer: nothing in the application has created a scan until now,
-- so both tables are empty on every install. That is what lets the three new
-- `DiskScanEntries` columns be NOT NULL with no default — the same argument the
-- transfer-items migration made, and for the same reason. A default would have
-- to invent a parent for a rectangle that has none.
--
-- Every new column on `DiskScans` is either nullable or defaulted, because a
-- row written by a future version of the runner is not the only shape this
-- table will ever hold, and because NULL carries a meaning here that zero
-- cannot: a fact that was never gathered is not a fact whose value is nothing.
-- AlterTable
ALTER TABLE `DiskScanEntries` ADD COLUMN `depth` TINYINT NOT NULL,
    ADD COLUMN `kind` ENUM('DIRECTORY', 'FILE', 'OTHER') NOT NULL,
    ADD COLUMN `parentPath` VARCHAR(700) NOT NULL;

-- `CANCELLED` joins the status enum. A cancelled scan is not a failed one: the
-- host did nothing wrong and there is nothing to report to an operator, so the
-- panel says "stopped" rather than showing an error it would have to invent.
--
-- Widening an enum with a value nothing has yet written is safe in place —
-- MySQL appends it to the end of the list, which leaves every stored ordinal
-- where it was.
-- AlterTable
ALTER TABLE `DiskScans` ADD COLUMN `depth` TINYINT NOT NULL DEFAULT 3,
    ADD COLUMN `dupGroupsCandidate` INTEGER NULL,
    ADD COLUMN `dupGroupsConfirmed` INTEGER NULL,
    ADD COLUMN `dupGroupsSkipped` INTEGER NULL,
    ADD COLUMN `dupReclaimableBytes` BIGINT NULL,
    ADD COLUMN `error` VARCHAR(500) NULL,
    ADD COLUMN `flavour` ENUM('GNU', 'PORTABLE', 'SUBTOTALS') NOT NULL DEFAULT 'GNU',
    ADD COLUMN `largestBytes` BIGINT NULL,
    ADD COLUMN `largestPath` TEXT NULL,
    ADD COLUMN `niced` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `oldFileBefore` DATETIME(3) NULL,
    ADD COLUMN `oldFileBytes` BIGINT NULL,
    ADD COLUMN `oldFileCount` BIGINT NULL,
    ADD COLUMN `runningSlot` CHAR(36) NULL,
    ADD COLUMN `supersedesId` CHAR(36) NULL,
    ADD COLUMN `truncated` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `unreadableCount` INTEGER NOT NULL DEFAULT 0,
    MODIFY `status` ENUM('RUNNING', 'DONE', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'RUNNING';

-- One indexed read per treemap level. Prefixed at 191 characters because InnoDB
-- caps a key at 3072 bytes and utf8mb4 spends four per character, which a
-- VARCHAR(700) plus a CHAR(36) would otherwise exceed.
-- CreateIndex
CREATE INDEX `DiskScanEntries_scanId_parentPath_bytes_idx` ON `DiskScanEntries`(`scanId`, `parentPath`(191), `bytes` DESC);

-- "One scan per host at a time", enforced by the database rather than by a
-- field on a service.
--
-- MySQL has no partial unique index, so the column holds the hostId while the
-- scan is RUNNING and NULL once it has ended; a unique index counts every NULL
-- as distinct, so only a second *running* scan of one host collides. The same
-- trick `Users.ownerSlot` and `Hosts.localSlot` use.
--
-- The alternative — a Map on a singleton — loses the guarantee twice: it does
-- not survive a restart, and a check-then-insert spanning two Node ticks is a
-- race whose prize is two `du`s walking somebody's filesystem at once.
-- CreateIndex
CREATE UNIQUE INDEX `DiskScans_runningSlot_key` ON `DiskScans`(`runningSlot`);

-- CreateIndex
CREATE UNIQUE INDEX `DiskScans_supersedesId_key` ON `DiskScans`(`supersedesId`);

-- The panel's own query: the most recent scan of one root. The pre-existing
-- (hostId, startedAt) index cannot serve it, because `root` is not a prefix of
-- it and MySQL will not skip a middle column to satisfy a filter.
-- CreateIndex
CREATE INDEX `DiskScans_hostId_root_startedAt_idx` ON `DiskScans`(`hostId`, `root`(191), `startedAt` DESC);

-- SET NULL and deliberately not CASCADE. This points from the new scan at the
-- one it replaces, and the terminal transaction deletes the replaced row on
-- success — under CASCADE that delete would take the living scan with it.
-- AddForeignKey
ALTER TABLE `DiskScans` ADD CONSTRAINT `DiskScans_supersedesId_fkey` FOREIGN KEY (`supersedesId`) REFERENCES `DiskScans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
