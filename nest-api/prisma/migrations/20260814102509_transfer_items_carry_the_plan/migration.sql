-- TRE-23. The transfer tables were laid out by TRE-6 and have never had a
-- writer: nothing in the application has created a job until now, so both are
-- empty on every install and `kind` can be NOT NULL with no default.
--
-- A default would have been worse than the warning Prisma raises about it.
-- There is no honest value: an item is a file, a directory or a symlink, the
-- runner does something different for each, and a row that arrived without one
-- is a row nobody knows how to place.
--
-- `finalName` is nullable and stays null for the ordinary case — it is only
-- written when a `keepBoth` decision renames the copy, so a non-null value
-- means "this is not called what you asked for".
-- AlterTable
ALTER TABLE `TransferItems` ADD COLUMN `finalName` VARCHAR(700) NULL,
    ADD COLUMN `kind` VARCHAR(16) NOT NULL,
    ADD COLUMN `mode` INTEGER NULL,
    ADD COLUMN `mtimeMs` BIGINT NULL;

-- The two numbers the progress bar is drawn from, on the job rather than
-- counted from its items. A running job emits progress several times a second
-- and a GROUP BY over ten thousand item rows per tick is a query with nothing
-- to show for itself.
-- AlterTable
ALTER TABLE `TransferJobs` ADD COLUMN `itemsDone` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `itemsTotal` INTEGER NOT NULL DEFAULT 0;
