CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`block_id` integer NOT NULL,
	`step_id` integer NOT NULL,
	`kind` text NOT NULL,
	`kind_index` integer DEFAULT 0 NOT NULL,
	`mime` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`data` blob NOT NULL,
	`thumb` blob NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_block_kind_uq` ON `artifacts` (`block_id`,`kind`,`kind_index`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`row` integer NOT NULL,
	`col` integer NOT NULL,
	`created_at` integer NOT NULL,
	`viewpoints` text,
	`params` text,
	`params_repaired` integer DEFAULT false NOT NULL,
	`completed_at` integer,
	`storage_allocated_micros` integer,
	`compute_allocated_micros` integer,
	`lease_until` integer,
	`lease_holder` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`paused_at` integer,
	`pause_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_key_uq` ON `blocks` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `blocks_row_col_uq` ON `blocks` (`row`,`col`);--> statement-breakpoint
CREATE INDEX `blocks_open_idx` ON `blocks` (`id`) WHERE completed_at IS NULL AND paused_at IS NULL;--> statement-breakpoint
CREATE TABLE `donations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`block_id` integer NOT NULL,
	`donor_id` text NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`amount_twd` integer NOT NULL,
	`twd_per_usd` real NOT NULL,
	`gross_micros` integer DEFAULT 0 NOT NULL,
	`fee_micros` integer DEFAULT 0 NOT NULL,
	`tax_micros` integer DEFAULT 0 NOT NULL,
	`chargeback_micros` integer DEFAULT 0 NOT NULL,
	`net_micros` integer DEFAULT 0 NOT NULL,
	`vote` text,
	`wish` text,
	`processor` text NOT NULL,
	`processor_ref` text,
	`created_at` integer NOT NULL,
	`paid_at` integer,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "donations_amount_positive" CHECK("donations"."amount_twd" > 0),
	CONSTRAINT "donations_status_known" CHECK("donations"."status" IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED')),
	CONSTRAINT "donations_vote_known" CHECK("donations"."vote" IS NULL OR "donations"."vote" IN ('google','openai'))
);
--> statement-breakpoint
CREATE INDEX `donations_block_idx` ON `donations` (`block_id`,`status`);--> statement-breakpoint
CREATE INDEX `donations_donor_idx` ON `donations` (`donor_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `donations_processor_ref_uq` ON `donations` (`processor`,`processor_ref`);--> statement-breakpoint
CREATE TABLE `scene_archives` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`block_id` integer NOT NULL,
	`scene_cid` text NOT NULL,
	`deal_index_cid` text NOT NULL,
	`block_count` integer NOT NULL,
	`bytes` integer NOT NULL,
	`status` text DEFAULT 'PACKED' NOT NULL,
	`retain_until` integer NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scene_archives_status_known" CHECK("scene_archives"."status" IN ('PACKED', 'STORED', 'DONE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scene_archives_block_uq` ON `scene_archives` (`block_id`);--> statement-breakpoint
CREATE TABLE `scene_deals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`archive_id` integer NOT NULL,
	`network` text NOT NULL,
	`status` text NOT NULL,
	`tx_hash` text NOT NULL,
	`deal_id` text,
	`replicas` integer NOT NULL,
	`epochs` integer NOT NULL,
	`price_wei` text NOT NULL,
	`cost_wei` text NOT NULL,
	`start_epoch` integer,
	`end_epoch` integer,
	`slots` text,
	`checked_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`archive_id`) REFERENCES `scene_archives`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scene_deals_status_known" CHECK("scene_deals"."status" IN ('SUBMITTED', 'ACTIVE', 'FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scene_deals_tx_uq` ON `scene_deals` (`network`,`tx_hash`);--> statement-breakpoint
CREATE INDEX `scene_deals_archive_idx` ON `scene_deals` (`archive_id`);--> statement-breakpoint
CREATE TABLE `scene_files` (
	`block_id` integer NOT NULL,
	`path` text NOT NULL,
	`data` blob NOT NULL,
	PRIMARY KEY(`block_id`, `path`),
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`block_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`kind_index` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`provider` text,
	`model` text,
	`text_in` integer DEFAULT 0 NOT NULL,
	`image_in` integer DEFAULT 0 NOT NULL,
	`text_out` integer DEFAULT 0 NOT NULL,
	`image_out` integer DEFAULT 0 NOT NULL,
	`token_micros` integer DEFAULT 0 NOT NULL,
	`reference_micros` integer DEFAULT 0 NOT NULL,
	`pricing_version` text NOT NULL,
	`bible_version` text NOT NULL,
	`tally` text,
	`error_code` text,
	`error_message` text,
	`note` text,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "steps_status_known" CHECK("steps"."status" IN ('SUCCEEDED', 'FAILED'))
);
--> statement-breakpoint
CREATE INDEX `steps_block_idx` ON `steps` (`block_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `steps_block_seq_succeeded_uq` ON `steps` (`block_id`,`seq`) WHERE status = 'SUCCEEDED';--> statement-breakpoint
CREATE INDEX `steps_observed_idx` ON `steps` (`provider`,`kind`,`id`) WHERE status = 'SUCCEEDED';--> statement-breakpoint
CREATE TABLE `auth_accounts` (
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`provider` text NOT NULL,
	`provider_account_id` text NOT NULL,
	`refresh_token` text,
	`access_token` text,
	`expires_at` integer,
	`token_type` text,
	`scope` text,
	`id_token` text,
	`session_state` text,
	PRIMARY KEY(`provider`, `provider_account_id`),
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`session_token` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `auth_users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`email` text NOT NULL,
	`email_verified` integer,
	`image` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_users_email_unique` ON `auth_users` (`email`);--> statement-breakpoint
CREATE TABLE `auth_verification_tokens` (
	`identifier` text NOT NULL,
	`token` text NOT NULL,
	`expires` integer NOT NULL,
	PRIMARY KEY(`identifier`, `token`)
);
