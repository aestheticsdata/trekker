-- Where an action was started from (TRE-35).
--
-- Nullable with no backfill, deliberately: every row written before today came
-- from a button, and a default of 'ui' would be this migration inventing a fact
-- about history it cannot know. Null means "not marked", which is what those
-- rows honestly are, and it is also what a button writes today.
ALTER TABLE `ActivityLog` ADD COLUMN `origin` VARCHAR(16) NULL;
