CREATE TABLE `automation_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`trigger_type` text,
	`trigger_payload` text,
	`external_id` text,
	`external_url` text,
	`error_message` text,
	`chat_id` text,
	`sub_chat_id` text,
	`is_read` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`meta` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sub_chat_id`) REFERENCES `sub_chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `executions_automation_id_idx` ON `automation_executions` (`automation_id`);--> statement-breakpoint
CREATE INDEX `executions_status_idx` ON `automation_executions` (`status`);--> statement-breakpoint
CREATE INDEX `executions_archived_at_idx` ON `automation_executions` (`archived_at`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT 'Untitled Automation' NOT NULL,
	`agent_prompt` text DEFAULT '' NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`add_to_inbox` integer DEFAULT true NOT NULL,
	`respond_to_trigger` integer DEFAULT true NOT NULL,
	`model` text DEFAULT 'sonnet' NOT NULL,
	`target_repository` text,
	`project_id` text,
	`triggers` text DEFAULT '[]' NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`token_expires_at` integer,
	`scope` text,
	`platform_user_id` text,
	`platform_username` text,
	`connected_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `polling_state` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`trigger_type` text NOT NULL,
	`repository_filter` text,
	`last_poll_at` integer,
	`last_seen_id` text,
	`last_seen_timestamp` integer,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `polling_state_integration_trigger_idx` ON `polling_state` (`integration_id`,`trigger_type`);