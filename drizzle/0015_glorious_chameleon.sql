CREATE TABLE `agent_worktrees` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`repo_id` text NOT NULL,
	`issue_id` text,
	`path` text NOT NULL,
	`branch` text NOT NULL,
	`base_branch` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`created_at` integer,
	`last_active_at` integer,
	`closed_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `project_repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_worktrees_path_unique` ON `agent_worktrees` (`path`);--> statement-breakpoint
CREATE INDEX `agent_worktrees_agent_idx` ON `agent_worktrees` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_worktrees_issue_idx` ON `agent_worktrees` (`issue_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_worktrees_open_uq` ON `agent_worktrees` (`agent_id`,`repo_id`,`issue_id`) WHERE "agent_worktrees"."status" IN ('created', 'active', 'idle');--> statement-breakpoint
CREATE TABLE `agent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`from_agent_id` text NOT NULL,
	`run_id` text,
	`issue_id` text,
	`addressed_to` text DEFAULT 'founding_engineer' NOT NULL,
	`severity` text DEFAULT 'decision' NOT NULL,
	`kind` text,
	`body` text NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`resolution_by` text,
	`resolution` text,
	`created_at` integer,
	`resolved_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`from_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_requests_status_idx` ON `agent_requests` (`status`);--> statement-breakpoint
CREATE INDEX `agent_requests_severity_status_idx` ON `agent_requests` (`severity`,`status`);--> statement-breakpoint
CREATE INDEX `agent_requests_run_idx` ON `agent_requests` (`run_id`);--> statement-breakpoint
CREATE INDEX `agent_requests_issue_idx` ON `agent_requests` (`issue_id`);--> statement-breakpoint
ALTER TABLE `chats` ADD `kind` text DEFAULT 'solo' NOT NULL;--> statement-breakpoint
CREATE INDEX `chats_kind_idx` ON `chats` (`kind`);