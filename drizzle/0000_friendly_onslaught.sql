CREATE TYPE "public"."donation_status" AS ENUM('PENDING', 'PAID', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"block_id" bigint NOT NULL,
	"step_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"kind_index" integer DEFAULT 0 NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"thumb" "bytea" NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"row" integer NOT NULL,
	"col" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"viewpoints" jsonb,
	"params" jsonb,
	"params_repaired" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"storage_allocated_micros" bigint,
	"compute_allocated_micros" bigint,
	"lease_until" timestamp with time zone,
	"lease_holder" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"paused_at" timestamp with time zone,
	"pause_reason" text
);
--> statement-breakpoint
CREATE TABLE "donations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"block_id" bigint NOT NULL,
	"donor_id" text NOT NULL,
	"status" "donation_status" DEFAULT 'PENDING' NOT NULL,
	"amount_twd" integer NOT NULL,
	"twd_per_usd" numeric(10, 4) NOT NULL,
	"gross_micros" bigint DEFAULT 0 NOT NULL,
	"fee_micros" bigint DEFAULT 0 NOT NULL,
	"tax_micros" bigint DEFAULT 0 NOT NULL,
	"chargeback_micros" bigint DEFAULT 0 NOT NULL,
	"net_micros" bigint DEFAULT 0 NOT NULL,
	"vote" text,
	"wish" text,
	"processor" text NOT NULL,
	"processor_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "donations_amount_positive" CHECK ("donations"."amount_twd" > 0),
	CONSTRAINT "donations_vote_known" CHECK ("donations"."vote" IS NULL OR "donations"."vote" IN ('google','openai','anthropic'))
);
--> statement-breakpoint
CREATE TABLE "steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"block_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"kind_index" integer DEFAULT 0 NOT NULL,
	"status" "step_status" NOT NULL,
	"provider" text,
	"model" text,
	"text_in" integer DEFAULT 0 NOT NULL,
	"image_in" integer DEFAULT 0 NOT NULL,
	"text_out" integer DEFAULT 0 NOT NULL,
	"image_out" integer DEFAULT 0 NOT NULL,
	"token_micros" bigint DEFAULT 0 NOT NULL,
	"reference_micros" bigint DEFAULT 0 NOT NULL,
	"pricing_version" text NOT NULL,
	"bible_version" text NOT NULL,
	"tally" jsonb,
	"error_code" text,
	"error_message" text,
	"note" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "auth_accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	CONSTRAINT "auth_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_step_id_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steps" ADD CONSTRAINT "steps_block_id_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."blocks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_block_kind_uq" ON "artifacts" USING btree ("block_id","kind","kind_index");--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_key_uq" ON "blocks" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "blocks_row_col_uq" ON "blocks" USING btree ("row","col");--> statement-breakpoint
CREATE INDEX "blocks_open_idx" ON "blocks" USING btree ("id") WHERE completed_at IS NULL AND paused_at IS NULL;--> statement-breakpoint
CREATE INDEX "donations_block_idx" ON "donations" USING btree ("block_id","status");--> statement-breakpoint
CREATE INDEX "donations_donor_idx" ON "donations" USING btree ("donor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "donations_processor_ref_uq" ON "donations" USING btree ("processor","processor_ref");--> statement-breakpoint
CREATE INDEX "steps_block_idx" ON "steps" USING btree ("block_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "steps_block_seq_succeeded_uq" ON "steps" USING btree ("block_id","seq") WHERE status = 'SUCCEEDED';--> statement-breakpoint
CREATE INDEX "steps_observed_idx" ON "steps" USING btree ("provider","kind","id") WHERE status = 'SUCCEEDED';