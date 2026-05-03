CREATE TABLE `runtime_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'general' NOT NULL,
	`title` text,
	`icon` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`reports_to` text,
	`adapter_type` text NOT NULL,
	`adapter_config` text DEFAULT '{}' NOT NULL,
	`runtime_config` text DEFAULT '{}' NOT NULL,
	`default_project_id` text,
	`budget_monthly_cents` integer,
	`spent_monthly_cents` integer DEFAULT 0 NOT NULL,
	`pause_reason` text,
	`paused_at` integer,
	`permissions` text DEFAULT '{}' NOT NULL,
	`autonomy_mode` text DEFAULT 'off' NOT NULL,
	`heartbeat_interval_sec` integer,
	`last_heartbeat_at` integer,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`reports_to`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`default_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runtime_agents_status_idx` ON `runtime_agents` (`status`);--> statement-breakpoint
CREATE INDEX `runtime_agents_reports_to_idx` ON `runtime_agents` (`reports_to`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`description` text,
	`identifier` text NOT NULL,
	`issue_number` integer NOT NULL,
	`status` text DEFAULT 'backlog' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`assignee_runtime_agent_id` text,
	`checkout_run_id` text,
	`execution_run_id` text,
	`execution_agent_name_key` text,
	`execution_locked_at` integer,
	`origin_kind` text DEFAULT 'manual' NOT NULL,
	`origin_id` text,
	`origin_run_id` text,
	`origin_fingerprint` text,
	`worktree_path` text,
	`branch` text,
	`base_branch` text,
	`assignee_adapter_overrides` text DEFAULT '{}' NOT NULL,
	`execution_policy` text DEFAULT '{}' NOT NULL,
	`execution_state` text DEFAULT '{}' NOT NULL,
	`request_depth` integer DEFAULT 0 NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	`cancelled_at` integer,
	`hidden_at` integer,
	`created_by_runtime_agent_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_identifier_unique` ON `issues` (`identifier`);--> statement-breakpoint
CREATE INDEX `issues_status_idx` ON `issues` (`status`);--> statement-breakpoint
CREATE INDEX `issues_assignee_status_idx` ON `issues` (`assignee_runtime_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `issues_parent_idx` ON `issues` (`parent_id`);--> statement-breakpoint
CREATE INDEX `issues_project_status_idx` ON `issues` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `issues_origin_fingerprint_idx` ON `issues` (`origin_kind`,`origin_id`,`origin_fingerprint`);--> statement-breakpoint
CREATE TABLE `issue_relations` (
	`source_issue_id` text NOT NULL,
	`target_issue_id` text NOT NULL,
	`type` text NOT NULL,
	`created_by_runtime_agent_id` text,
	`created_at` integer,
	PRIMARY KEY(`source_issue_id`, `target_issue_id`, `type`),
	FOREIGN KEY (`source_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_relations_target_idx` ON `issue_relations` (`target_issue_id`,`type`);--> statement-breakpoint
CREATE INDEX `issue_relations_source_idx` ON `issue_relations` (`source_issue_id`,`type`);--> statement-breakpoint
CREATE TABLE `issue_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`author_runtime_agent_id` text,
	`is_from_user` integer DEFAULT false NOT NULL,
	`body` text NOT NULL,
	`created_by_run_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `issue_comments_issue_idx` ON `issue_comments` (`issue_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `issue_comments_run_idx` ON `issue_comments` (`created_by_run_id`);--> statement-breakpoint
CREATE TABLE `issue_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`key` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`mime_type` text DEFAULT 'text/markdown' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by_run_id` text,
	`updated_by_run_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_documents_issue_key_uq` ON `issue_documents` (`issue_id`,`key`);--> statement-breakpoint
CREATE INDEX `issue_documents_issue_idx` ON `issue_documents` (`issue_id`);--> statement-breakpoint
CREATE TABLE `issue_work_products` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text,
	`title` text,
	`url` text,
	`status` text,
	`review_state` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`health_status` text DEFAULT 'unknown' NOT NULL,
	`summary` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_by_run_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_work_products_issue_idx` ON `issue_work_products` (`issue_id`,`type`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_work_products_provider_ext_uq` ON `issue_work_products` (`provider`,`external_id`);--> statement-breakpoint
CREATE TABLE `agent_wakeup_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime_agent_id` text NOT NULL,
	`source` text NOT NULL,
	`trigger_detail` text,
	`reason` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`coalesced_count` integer DEFAULT 0 NOT NULL,
	`requested_by_actor_type` text,
	`requested_by_actor_id` text,
	`idempotency_key` text,
	`run_id` text,
	`context_snapshot` text DEFAULT '{}' NOT NULL,
	`requested_at` integer,
	`claimed_at` integer,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_wakeup_requests_agent_status_idx` ON `agent_wakeup_requests` (`runtime_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_wakeup_requests_requested_idx` ON `agent_wakeup_requests` (`requested_at`);--> statement-breakpoint
CREATE INDEX `agent_wakeup_requests_idempotency_idx` ON `agent_wakeup_requests` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime_agent_id` text NOT NULL,
	`invocation_source` text NOT NULL,
	`trigger_detail` text,
	`wakeup_request_id` text,
	`context_snapshot` text DEFAULT '{}' NOT NULL,
	`issue_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`scheduled_retry_at` integer,
	`scheduled_retry_attempt` integer DEFAULT 0 NOT NULL,
	`retry_of_run_id` text,
	`continuation_attempt` integer DEFAULT 0 NOT NULL,
	`adapter_type` text NOT NULL,
	`session_id_before` text,
	`session_id_after` text,
	`process_pid` integer,
	`process_group_id` integer,
	`process_started_at` integer,
	`liveness_state` text,
	`liveness_reason` text,
	`last_output_at` integer,
	`last_output_seq` integer DEFAULT 0 NOT NULL,
	`log_ref` text,
	`log_bytes` integer,
	`log_compressed` integer,
	`log_sha256` text,
	`stdout_excerpt` text,
	`stderr_excerpt` text,
	`result_json` text,
	`error_code` text,
	`error` text,
	`usage_json` text,
	`external_run_id` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`retry_of_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_runs_agent_status_idx` ON `agent_runs` (`runtime_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_runs_status_last_output_idx` ON `agent_runs` (`status`,`last_output_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_issue_idx` ON `agent_runs` (`issue_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_scheduled_retry_idx` ON `agent_runs` (`scheduled_retry_at`);--> statement-breakpoint
CREATE TABLE `agent_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_type` text NOT NULL,
	`stream` text NOT NULL,
	`level` text,
	`message` text,
	`payload` text,
	`created_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_run_events_run_seq_idx` ON `agent_run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `agent_run_events_run_type_idx` ON `agent_run_events` (`run_id`,`event_type`);--> statement-breakpoint
CREATE TABLE `agent_task_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime_agent_id` text NOT NULL,
	`adapter_type` text NOT NULL,
	`task_key` text NOT NULL,
	`session_params_json` text DEFAULT '{}' NOT NULL,
	`session_display_id` text,
	`last_run_id` text,
	`last_error` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_task_sessions_agent_adapter_key_uq` ON `agent_task_sessions` (`runtime_agent_id`,`adapter_type`,`task_key`);--> statement-breakpoint
CREATE INDEX `agent_task_sessions_agent_idx` ON `agent_task_sessions` (`runtime_agent_id`);--> statement-breakpoint
CREATE TABLE `agent_runtime_state` (
	`runtime_agent_id` text PRIMARY KEY NOT NULL,
	`adapter_type` text NOT NULL,
	`session_id` text,
	`state_json` text DEFAULT '{}' NOT NULL,
	`last_run_id` text,
	`last_run_status` text,
	`total_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`total_output_tokens` integer DEFAULT 0 NOT NULL,
	`total_cost_cents` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `cost_events` (
	`id` text PRIMARY KEY NOT NULL,
	`runtime_agent_id` text NOT NULL,
	`agent_run_id` text,
	`issue_id` text,
	`project_id` text,
	`billing_code` text,
	`provider` text NOT NULL,
	`biller` text NOT NULL,
	`billing_type` text DEFAULT 'unknown' NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`provider_external_call_id` text,
	`occurred_at` integer,
	`created_at` integer,
	FOREIGN KEY (`runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cost_events_agent_idx` ON `cost_events` (`runtime_agent_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `cost_events_run_idx` ON `cost_events` (`agent_run_id`);--> statement-breakpoint
CREATE INDEX `cost_events_project_idx` ON `cost_events` (`project_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `cost_events_call_idempotency_uq` ON `cost_events` (`agent_run_id`,`provider_external_call_id`);--> statement-breakpoint
CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`runtime_agent_id` text,
	`agent_run_id` text,
	`details` text DEFAULT '{}' NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`runtime_agent_id`) REFERENCES `runtime_agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`agent_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_log_created_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `activity_log_entity_idx` ON `activity_log` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_log_actor_idx` ON `activity_log` (`actor_type`,`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_log_run_idx` ON `activity_log` (`agent_run_id`);