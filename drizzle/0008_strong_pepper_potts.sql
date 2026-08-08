CREATE TABLE "engagement_parts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"engagement_id" bigint NOT NULL,
	"side" text NOT NULL,
	"player_id" bigint,
	"march_id" bigint,
	"units" jsonb NOT NULL,
	"joined_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"defender_id" bigint,
	"is_keep" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "engagement_parts" ADD CONSTRAINT "engagement_parts_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_parts_idx" ON "engagement_parts" USING btree ("engagement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "engagements_active_uq" ON "engagements" USING btree ("season_id","x","y") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "engagements_due_idx" ON "engagements" USING btree ("ends_at") WHERE resolved_at IS NULL;