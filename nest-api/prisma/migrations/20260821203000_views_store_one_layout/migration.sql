-- Saved views store a layout, not a translation of one (TRE-37).
--
-- The columns dropped below were written in the very first migration, before
-- TRE-18 settled what a layout in this app actually is. They describe a
-- different one: `split` was a percentage and `solo` named a full-width pane,
-- where the app has a single three-valued `split` and no percentage anywhere.
-- Keeping them would mean translating on every read and every write, and the
-- dirty dot — the whole point of the feature — is a comparison of two
-- serialised layouts. A translation is exactly where such a comparison starts
-- reporting a change nobody made, or missing one they did.
--
-- `layout` and `hostLabels` are added NOT NULL with no default and no backfill,
-- which is safe here for one reason and only one: no code has ever written to
-- this table. `Views` shipped with the schema in TRE-6 and TRE-37 is the first
-- ticket to give it an endpoint, so every install's copy is empty. Checked on
-- the server before this was deployed.
--
-- `shortcut` becomes `slot`, VARCHAR(32) to INT. It held "⌥3"; it now holds 3.
-- How a chord is spelled belongs to the front's keymap (TRE-36), and moving a
-- glyph there must never require a migration here.

DROP INDEX `Views_userId_shortcut_key` ON `Views`;

ALTER TABLE `Views`
    DROP COLUMN `shortcut`,
    DROP COLUMN `panes`,
    DROP COLUMN `split`,
    DROP COLUMN `solo`,
    DROP COLUMN `inspector`,
    DROP COLUMN `heat`,
    DROP COLUMN `glob`,
    ADD COLUMN `slot` INTEGER NULL,
    ADD COLUMN `layout` JSON NOT NULL,
    ADD COLUMN `hostLabels` JSON NOT NULL;

CREATE UNIQUE INDEX `Views_userId_slot_key` ON `Views`(`userId`, `slot`);
