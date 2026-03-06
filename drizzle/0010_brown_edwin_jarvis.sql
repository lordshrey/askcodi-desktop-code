ALTER TABLE `chats` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `source_type` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `source_identifier` text;--> statement-breakpoint
CREATE INDEX `chats_source_url_idx` ON `chats` (`source_url`);