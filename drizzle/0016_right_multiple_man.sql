ALTER TABLE `chats` ADD `issue_id` text REFERENCES issues(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX `chats_issue_id_idx` ON `chats` (`issue_id`);--> statement-breakpoint
-- Rename CHAT_KIND.fe_thread → thread (matches new constant). Idempotent.
UPDATE `chats` SET `kind` = 'thread' WHERE `kind` = 'fe_thread';
