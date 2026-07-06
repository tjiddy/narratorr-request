CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`default_quota_mode` text DEFAULT 'limited' NOT NULL,
	`default_quota_limit` integer,
	`default_quota_window_days` integer DEFAULT 30 NOT NULL,
	`auto_approve_roles` text DEFAULT '["admin"]' NOT NULL,
	`notify_config` text,
	`connectors` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "default_quota_mode_limit" CHECK((`app_settings`.`default_quota_mode` = 'limited') = (`app_settings`.`default_quota_limit` IS NOT NULL) AND (`app_settings`.`default_quota_limit` IS NULL OR `app_settings`.`default_quota_limit` > 0))
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`asin` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`narrator` text,
	`cover_url` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`narratorr_book_id` text,
	`note` text,
	`failure_reason` text,
	`requested_at` integer DEFAULT (unixepoch()) NOT NULL,
	`decided_at` integer,
	`decided_by` integer,
	`available_notified_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_public_id_unique` ON `requests` (`public_id`);--> statement-breakpoint
CREATE INDEX `idx_requests_user_id` ON `requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_requests_status` ON `requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_requests_asin` ON `requests` (`asin`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_requests_user_asin_active` ON `requests` (`user_id`,`asin`) WHERE status IN ('pending','approved','acquiring');--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`auth_provider` text NOT NULL,
	`auth_subject` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`email` text,
	`thumb` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`request_quota_mode` text DEFAULT 'inherit' NOT NULL,
	`request_quota_limit` integer,
	`auto_approve` integer DEFAULT false NOT NULL,
	`notify_on` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "request_quota_mode_limit" CHECK((`users`.`request_quota_mode` = 'limited') = (`users`.`request_quota_limit` IS NOT NULL) AND (`users`.`request_quota_limit` IS NULL OR `users`.`request_quota_limit` > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_public_id_unique` ON `users` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_provider_subject` ON `users` (`auth_provider`,`auth_subject`);--> statement-breakpoint
CREATE INDEX `idx_users_username` ON `users` (`username`);