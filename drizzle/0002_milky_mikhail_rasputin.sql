CREATE TYPE "public"."archive_status" AS ENUM('PACKED', 'STORED', 'DONE');--> statement-breakpoint
CREATE TYPE "public"."deal_status" AS ENUM('SUBMITTED', 'ACTIVE', 'FAILED');--> statement-breakpoint
CREATE TABLE "scene_archives" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"block_id" bigint NOT NULL,
	"scene_cid" text NOT NULL,
	"deal_index_cid" text NOT NULL,
	"block_count" integer NOT NULL,
	"bytes" bigint NOT NULL,
	"status" "archive_status" DEFAULT 'PACKED' NOT NULL,
	"retain_until" timestamp with time zone NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene_deals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"archive_id" bigint NOT NULL,
	"network" text NOT NULL,
	"status" "deal_status" NOT NULL,
	"tx_hash" text NOT NULL,
	"deal_id" text,
	"replicas" integer NOT NULL,
	"epochs" integer NOT NULL,
	"price_wei" text NOT NULL,
	"cost_wei" text NOT NULL,
	"start_epoch" bigint,
	"end_epoch" bigint,
	"slots" jsonb,
	"checked_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene_files" (
	"block_id" bigint NOT NULL,
	"path" text NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "scene_files_block_id_path_pk" PRIMARY KEY("block_id","path")
);
--> statement-breakpoint
ALTER TABLE "scene_archives" ADD CONSTRAINT "scene_archives_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_deals" ADD CONSTRAINT "scene_deals_archive_id_scene_archives_id_fk" FOREIGN KEY ("archive_id") REFERENCES "public"."scene_archives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_files" ADD CONSTRAINT "scene_files_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "scene_archives_block_uq" ON "scene_archives" USING btree ("block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scene_deals_tx_uq" ON "scene_deals" USING btree ("network","tx_hash");--> statement-breakpoint
CREATE INDEX "scene_deals_archive_idx" ON "scene_deals" USING btree ("archive_id");