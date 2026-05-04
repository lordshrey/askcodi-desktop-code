CREATE TABLE `project_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`role` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`default_branch` text,
	`git_remote_url` text,
	`git_provider` text,
	`git_owner` text,
	`git_repo` text,
	`created_at` integer,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_repos_path_unique` ON `project_repos` (`path`);--> statement-breakpoint
CREATE INDEX `project_repos_project_id_idx` ON `project_repos` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_repos_primary_per_project_uq` ON `project_repos` (`project_id`) WHERE "project_repos"."is_primary" = 1;--> statement-breakpoint
INSERT INTO `project_repos` (`id`, `project_id`, `name`, `path`, `role`, `is_primary`, `git_remote_url`, `git_provider`, `git_owner`, `git_repo`, `created_at`, `updated_at`)
SELECT
  lower(hex(randomblob(12))),
  p.`id`,
  p.`name`,
  p.`path`,
  'primary',
  1,
  p.`git_remote_url`,
  p.`git_provider`,
  p.`git_owner`,
  p.`git_repo`,
  p.`created_at`,
  p.`updated_at`
FROM `projects` p
WHERE NOT EXISTS (
  SELECT 1 FROM `project_repos` pr WHERE pr.`project_id` = p.`id`
);