-- Frozen snapshot of the BharatCode SQLite schema as shipped to beta users.
-- Concatenated from packages/opencode/migration/*/migration.sql at fork time.
-- Upstream has since moved this lineage into programmatic modules under
-- core/database, so there is no live source to regenerate this from -- and it
-- must stay frozen anyway: the capture tests do positional INSERTs against it
-- to prove sanitization removes secret bytes from a real user's database.

-- >>> 20260127222353_familiar_lady_ursula
CREATE TABLE `project` (
	`id` text PRIMARY KEY,
	`worktree` text NOT NULL,
	`vcs` text,
	`name` text,
	`icon_url` text,
	`icon_color` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_initialized` integer,
	`sandboxes` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `part` (
	`id` text PRIMARY KEY,
	`message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `permission` (
	`project_id` text PRIMARY KEY,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`directory` text NOT NULL,
	`title` text NOT NULL,
	`version` text NOT NULL,
	`share_url` text,
	`summary_additions` integer,
	`summary_deletions` integer,
	`summary_files` integer,
	`summary_diffs` text,
	`revert` text,
	`permission` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`time_compacting` integer,
	`time_archived` integer,
	CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `todo` (
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`priority` text NOT NULL,
	`position` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),
	CONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_share` (
	`session_id` text PRIMARY KEY,
	`id` text NOT NULL,
	`secret` text NOT NULL,
	`url` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `message_session_idx` ON `message` (`session_id`);--> statement-breakpoint
CREATE INDEX `part_message_idx` ON `part` (`message_id`);--> statement-breakpoint
CREATE INDEX `part_session_idx` ON `part` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_project_idx` ON `session` (`project_id`);--> statement-breakpoint
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);--> statement-breakpoint
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);
-- >>> 20260211171708_add_project_commands
ALTER TABLE `project` ADD `commands` text;
-- >>> 20260213144116_wakeful_the_professor
CREATE TABLE `control_account` (
	`email` text NOT NULL,
	`url` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_expiry` integer,
	`active` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`)
);

-- >>> 20260225215848_workspace
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY,
	`branch` text,
	`project_id` text NOT NULL,
	`config` text NOT NULL,
	CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);

-- >>> 20260227213759_add_session_workspace_id
ALTER TABLE `session` ADD `workspace_id` text;--> statement-breakpoint
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
-- >>> 20260228203230_blue_harpoon
CREATE TABLE `account` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`url` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_expiry` integer,
	`selected_org_id` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `account_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_account_id` text,
	FOREIGN KEY (`active_account_id`) REFERENCES `account`(`id`) ON UPDATE no action ON DELETE set null
);

-- >>> 20260303231226_add_workspace_fields
ALTER TABLE `workspace` ADD `type` text NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace` ADD `name` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `directory` text;--> statement-breakpoint
ALTER TABLE `workspace` ADD `extra` text;--> statement-breakpoint
ALTER TABLE `workspace` DROP COLUMN `config`;
-- >>> 20260309230000_move_org_to_state
ALTER TABLE `account_state` ADD `active_org_id` text;--> statement-breakpoint
UPDATE `account_state` SET `active_org_id` = (SELECT `selected_org_id` FROM `account` WHERE `account`.`id` = `account_state`.`active_account_id`);--> statement-breakpoint
ALTER TABLE `account` DROP COLUMN `selected_org_id`;

-- >>> 20260312043431_session_message_cursor
DROP INDEX IF EXISTS `message_session_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `part_message_idx`;--> statement-breakpoint
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);--> statement-breakpoint
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
-- >>> 20260323234822_events
CREATE TABLE `event_sequence` (
	`aggregate_id` text PRIMARY KEY,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event` (
	`id` text PRIMARY KEY,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
);

-- >>> 20260410174513_workspace-name
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`branch` text,
	`directory` text,
	`extra` text,
	`project_id` text NOT NULL,
	CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_workspace`(`id`, `type`, `branch`, `name`, `directory`, `extra`, `project_id`) SELECT `id`, `type`, `branch`, `name`, `directory`, `extra`, `project_id` FROM `workspace`;--> statement-breakpoint
DROP TABLE `workspace`;--> statement-breakpoint
ALTER TABLE `__new_workspace` RENAME TO `workspace`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
-- >>> 20260413175956_chief_energizer
CREATE TABLE `session_entry` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_entry_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `session_entry_session_idx` ON `session_entry` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_entry_session_type_idx` ON `session_entry` (`session_id`,`type`);--> statement-breakpoint
CREATE INDEX `session_entry_time_created_idx` ON `session_entry` (`time_created`);
-- >>> 20260423070820_add_icon_url_override
ALTER TABLE `project` ADD `icon_url_override` text;
UPDATE `project` SET `icon_url_override` = `icon_url` WHERE `icon_url` IS NOT NULL;

-- >>> 20260427172553_slow_nightmare
CREATE TABLE `session_message` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`data` text NOT NULL,
	CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
DROP INDEX IF EXISTS `session_entry_session_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_entry_session_type_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `session_entry_time_created_idx`;--> statement-breakpoint
CREATE INDEX `session_message_session_idx` ON `session_message` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_message_session_type_idx` ON `session_message` (`session_id`,`type`);--> statement-breakpoint
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);--> statement-breakpoint
DROP TABLE `session_entry`;
-- >>> 20260428004200_add_session_path
ALTER TABLE `session` ADD `path` text;
-- >>> 20260501142318_next_venus
ALTER TABLE `session` ADD `agent` text;--> statement-breakpoint
ALTER TABLE `session` ADD `model` text;
-- >>> 20260504145000_add_sync_owner
ALTER TABLE `event_sequence` ADD `owner_id` text;
-- >>> 20260507164347_add_workspace_time
ALTER TABLE `workspace` ADD `time_used` integer NOT NULL DEFAULT 0;

-- >>> 20260510033149_session_usage
ALTER TABLE `session` ADD `cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_input` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_output` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_reasoning` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_read` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `tokens_cache_write` integer DEFAULT 0 NOT NULL;

-- >>> 20260511000411_data_migration_state
CREATE TABLE `data_migration` (
	`name` text PRIMARY KEY,
	`time_completed` integer NOT NULL
);

-- >>> 20260630000000_add_goal_mode
ALTER TABLE `session` ADD `goal` text;

