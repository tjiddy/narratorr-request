CREATE TABLE `kindle_sends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`book_id` text NOT NULL,
	`status` text NOT NULL,
	`byte_count` integer,
	`failure_code` text,
	`started_at` integer NOT NULL,
	`finalized_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "kindle_sends_status_finalized" CHECK(("kindle_sends"."status" = 'started') = ("kindle_sends"."finalized_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kindle_sends_active` ON `kindle_sends` (`user_id`,`book_id`) WHERE status = 'started';--> statement-breakpoint
CREATE INDEX `idx_kindle_sends_replay` ON `kindle_sends` (`user_id`,`book_id`,`finalized_at`);--> statement-breakpoint
CREATE INDEX `idx_kindle_sends_user_started` ON `kindle_sends` (`user_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_kindle_sends_user_finalized` ON `kindle_sends` (`user_id`,`finalized_at`);--> statement-breakpoint
CREATE INDEX `idx_kindle_sends_finalized` ON `kindle_sends` (`finalized_at`);