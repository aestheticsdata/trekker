-- AlterTable
ALTER TABLE `Users` ADD COLUMN `role` ENUM('OWNER', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    ADD COLUMN `ownerSlot` BOOLEAN NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Users_ownerSlot_key` ON `Users`(`ownerSlot`);

-- The first account on an existing install is its owner (TRE-48).
--
-- The only data write in this repo's migration history, and it belongs here
-- rather than in a script because the deploy applies migrations unattended
-- before the new code serves: the flag has to be live at the same moment the
-- bypass is, or the deployment refuses its own owner.
--
-- Earliest by (createdAt, id). The id is a uuid v7 and therefore time-ordered,
-- so the tiebreak agrees with creation order instead of being arbitrary. The
-- subquery is wrapped in a derived table because MySQL error 1093 forbids
-- selecting from the table being updated. On an empty database this matches
-- nothing, deliberately: a fresh install gets its owner from the account that
-- registers first, not from here.
--
-- The unique index above is created first on purpose. A backfill that somehow
-- matched two rows has to fail rather than mint two owners.
UPDATE `Users` SET `role` = 'OWNER', `ownerSlot` = TRUE
WHERE `id` = (SELECT `id` FROM (SELECT `id` FROM `Users` ORDER BY `createdAt` ASC, `id` ASC LIMIT 1) AS `first_account`);
