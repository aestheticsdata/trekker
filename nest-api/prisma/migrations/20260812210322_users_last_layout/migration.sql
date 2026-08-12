-- AlterTable
--
-- Nullable with no default (TRE-51): null is "this account has never had a
-- layout worth reopening", which is exactly what every existing row is, and
-- what a cold open falls back to. A default of '{}' would be a layout that
-- restores nothing while looking like one that should.
ALTER TABLE `Users` ADD COLUMN `lastLayout` JSON NULL;
