CREATE TYPE "public"."ai_persona" AS ENUM('SETTLER', 'WARDEN', 'WARLORD', 'RUIN_LEGION');--> statement-breakpoint
CREATE TYPE "public"."alliance_rank" AS ENUM('LEADER', 'OFFICER', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."alliance_status" AS ENUM('ACTIVE', 'FALLEN');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('BUILD_DONE', 'DEMOLISH_DONE', 'TRAIN_DONE', 'MARCH_ARRIVE', 'CLAIM_DONE', 'ISOLATION_EXPIRE', 'CONTEST_EXPIRE', 'RUIN_TICK', 'RUIN_UNSEAL', 'CAMP_RESPAWN', 'SEASON_VICTORY_CHECK', 'SEASON_EXPIRE', 'SEASON_CHANGE', 'REGION_ATTRITION', 'STARVATION', 'LEGION_GROWTH', 'LEGION_SORTIE', 'SIEGE_RESOLVE', 'LEADER_TRANSFER', 'AI_TICK', 'AI_RETALIATE', 'AI_TAKEOVER', 'STEWARD_TICK');--> statement-breakpoint
CREATE TYPE "public"."march_status" AS ENUM('IN_TRANSIT', 'ARRIVED', 'RECALLED');--> statement-breakpoint
CREATE TYPE "public"."march_type" AS ENUM('RAID', 'ATTACK', 'SCOUT', 'CLAIM', 'REINFORCE', 'GARRISON', 'RETURN');--> statement-breakpoint
CREATE TYPE "public"."recruit_mode" AS ENUM('OPEN', 'APPLY', 'INVITE');--> statement-breakpoint
CREATE TYPE "public"."ruin_phase" AS ENUM('SEALED', 'DORMANT', 'AWAKENED', 'CONTESTED', 'CONTROLLED');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('REGISTRATION', 'SEALED', 'RUNNING', 'ENDING', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."siege_status" AS ENUM('ACTIVE', 'BROKEN', 'SUCCEEDED');--> statement-breakpoint
CREATE TYPE "public"."spawn_band" AS ENUM('VANGUARD', 'HEARTLAND', 'FRONTIER');--> statement-breakpoint
CREATE TYPE "public"."steward_log_kind" AS ENUM('CLAIM', 'BUILD', 'LEVY', 'WARNING', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."tile_kind" AS ENUM('BASE_CORE', 'TERRITORY', 'RUIN', 'RUIN_OUTPOST', 'CAMP');--> statement-breakpoint
CREATE TYPE "public"."tile_state" AS ENUM('NORMAL', 'CONTESTED', 'ISOLATED', 'CLAIMING');--> statement-breakpoint
CREATE TABLE "alliance_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"alliance_id" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alliance_members" (
	"player_id" bigint PRIMARY KEY NOT NULL,
	"alliance_id" bigint NOT NULL,
	"rank" "alliance_rank" DEFAULT 'MEMBER' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alliances" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"faction" smallint NOT NULL,
	"slot_no" smallint NOT NULL,
	"name" text NOT NULL,
	"tag" varchar(5) NOT NULL,
	"hex_code" char(2) NOT NULL,
	"color" smallint NOT NULL,
	"recruit_mode" "recruit_mode" DEFAULT 'APPLY' NOT NULL,
	"leader_id" bigint NOT NULL,
	"leader_pending_id" bigint,
	"leader_transfer_at" timestamp with time zone,
	"status" "alliance_status" DEFAULT 'ACTIVE' NOT NULL,
	"fallen_at" timestamp with time zone,
	"felled_by_alliance_id" bigint,
	"final_score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alliances_faction_range" CHECK ("alliances"."faction" BETWEEN 1 AND 3),
	CONSTRAINT "alliances_slot_range" CHECK ("alliances"."slot_no" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "base_slots" (
	"player_id" bigint NOT NULL,
	"slot" char(1) NOT NULL,
	"building" text,
	"level" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "base_slots_player_id_slot_pk" PRIMARY KEY("player_id","slot")
);
--> statement-breakpoint
CREATE TABLE "battle_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"attacker_id" bigint,
	"defender_id" bigint,
	"at_x" smallint NOT NULL,
	"at_y" smallint NOT NULL,
	"march_type" "march_type" NOT NULL,
	"snapshot" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel_type" text NOT NULL,
	"channel_id" bigint NOT NULL,
	"player_id" bigint,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"type" "event_type" NOT NULL,
	"actor_id" bigint,
	"payload" jsonb NOT NULL,
	"resolve_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "garrisons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"owner_id" bigint NOT NULL,
	"at_x" smallint NOT NULL,
	"at_y" smallint NOT NULL,
	"host_id" bigint,
	"units" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"owner_id" bigint NOT NULL,
	"type" "march_type" NOT NULL,
	"from_x" smallint NOT NULL,
	"from_y" smallint NOT NULL,
	"to_x" smallint NOT NULL,
	"to_y" smallint NOT NULL,
	"units" jsonb NOT NULL,
	"cargo" jsonb,
	"target_slot" char(1),
	"departed_at" timestamp with time zone NOT NULL,
	"arrives_at" timestamp with time zone NOT NULL,
	"status" "march_status" DEFAULT 'IN_TRANSIT' NOT NULL,
	"event_id" bigint
);
--> statement-breakpoint
CREATE TABLE "player_population" (
	"player_id" bigint PRIMARY KEY NOT NULL,
	"amount" numeric(12, 3) DEFAULT '0' NOT NULL,
	"rate" numeric(10, 3) DEFAULT '0' NOT NULL,
	"cap" numeric(10, 0) DEFAULT '60' NOT NULL,
	"used" numeric(12, 3) DEFAULT '0' NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "population_non_negative" CHECK ("player_population"."amount" >= 0 AND "player_population"."used" >= 0)
);
--> statement-breakpoint
CREATE TABLE "player_resources" (
	"player_id" bigint PRIMARY KEY NOT NULL,
	"grain" numeric(14, 3) DEFAULT '500' NOT NULL,
	"timber" numeric(14, 3) DEFAULT '500' NOT NULL,
	"stone" numeric(14, 3) DEFAULT '500' NOT NULL,
	"iron" numeric(14, 3) DEFAULT '200' NOT NULL,
	"relic" numeric(14, 3) DEFAULT '0' NOT NULL,
	"grain_rate" numeric(12, 3) DEFAULT '0' NOT NULL,
	"timber_rate" numeric(12, 3) DEFAULT '0' NOT NULL,
	"stone_rate" numeric(12, 3) DEFAULT '0' NOT NULL,
	"iron_rate" numeric(12, 3) DEFAULT '0' NOT NULL,
	"capacity" numeric(12, 0) DEFAULT '2000' NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_non_negative" CHECK (
    "player_resources"."grain" >= 0 AND "player_resources"."timber" >= 0 AND "player_resources"."stone" >= 0
    AND "player_resources"."iron" >= 0 AND "player_resources"."relic" >= 0)
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"user_id" bigint,
	"alliance_id" bigint,
	"faction" smallint NOT NULL,
	"spawn_band" "spawn_band" NOT NULL,
	"base_x" smallint NOT NULL,
	"base_y" smallint NOT NULL,
	"citadel_level" smallint DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_ai" boolean DEFAULT false NOT NULL,
	"ai_persona" "ai_persona",
	"ai_variance" numeric(4, 3),
	"eliminated_at" timestamp with time zone,
	CONSTRAINT "players_faction_range" CHECK ("players"."faction" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "region_capacity" (
	"season_id" integer NOT NULL,
	"region_id" smallint NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" bigint NOT NULL,
	"base_capacity" numeric(10, 0) NOT NULL,
	"stationed" numeric(10, 0) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_capacity_season_id_region_id_holder_kind_holder_id_pk" PRIMARY KEY("season_id","region_id","holder_kind","holder_id")
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"season_id" integer NOT NULL,
	"region_id" smallint NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "regions_season_id_region_id_pk" PRIMARY KEY("season_id","region_id")
);
--> statement-breakpoint
CREATE TABLE "ruin_control_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"ruin_id" smallint NOT NULL,
	"alliance_id" bigint,
	"gained_at" timestamp with time zone NOT NULL,
	"lost_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ruins" (
	"season_id" integer NOT NULL,
	"ruin_id" smallint NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"phase" "ruin_phase" DEFAULT 'SEALED' NOT NULL,
	"unseals_at" timestamp with time zone NOT NULL,
	"guard_units" jsonb NOT NULL,
	"legion_base" numeric(10, 0) NOT NULL,
	"legion_player_id" bigint,
	"last_sortie_at" timestamp with time zone,
	"control_alliance_id" bigint,
	"progress" numeric(5, 2) DEFAULT '0' NOT NULL,
	"controlled_since" timestamp with time zone,
	CONSTRAINT "ruins_season_id_ruin_id_pk" PRIMARY KEY("season_id","ruin_id")
);
--> statement-breakpoint
CREATE TABLE "season_quotas" (
	"season_id" integer NOT NULL,
	"faction" smallint NOT NULL,
	"spawn_band" "spawn_band" NOT NULL,
	"capacity" integer NOT NULL,
	"taken" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "season_quotas_season_id_faction_spawn_band_pk" PRIMARY KEY("season_id","faction","spawn_band"),
	CONSTRAINT "quota_within_capacity" CHECK ("season_quotas"."taken" >= 0 AND "season_quotas"."taken" <= "season_quotas"."capacity")
);
--> statement-breakpoint
CREATE TABLE "season_registrations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"user_id" bigint NOT NULL,
	"faction" smallint NOT NULL,
	"spawn_band" "spawn_band" NOT NULL,
	"squad_code" varchar(12),
	"assigned_x" smallint,
	"assigned_y" smallint,
	"player_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reg_faction_range" CHECK ("season_registrations"."faction" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"seed" bigint NOT NULL,
	"status" "season_status" DEFAULT 'REGISTRATION' NOT NULL,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"balance_version" text NOT NULL,
	"human_count" integer DEFAULT 0 NOT NULL,
	"ai_count" integer DEFAULT 0 NOT NULL,
	"ruin_positions" jsonb,
	"fairness_report" jsonb,
	"victory_alliance_id" bigint,
	"victory_countdown_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sieges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"target_alliance_id" bigint NOT NULL,
	"attacker_alliance_id" bigint NOT NULL,
	"at_x" smallint NOT NULL,
	"at_y" smallint NOT NULL,
	"garrison_id" bigint,
	"started_at" timestamp with time zone NOT NULL,
	"resolves_at" timestamp with time zone NOT NULL,
	"status" "siege_status" DEFAULT 'ACTIVE' NOT NULL,
	"event_id" bigint
);
--> statement-breakpoint
CREATE TABLE "steward_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"player_id" bigint NOT NULL,
	"kind" "steward_log_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stewards" (
	"player_id" bigint PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"avatar_seed" integer NOT NULL,
	"directives" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paused_until" timestamp with time zone,
	"full_proxy" boolean DEFAULT false NOT NULL,
	"last_acted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tiles" (
	"season_id" integer NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"kind" "tile_kind" NOT NULL,
	"player_id" bigint,
	"alliance_id" bigint,
	"facility" text,
	"facility_level" smallint DEFAULT 0 NOT NULL,
	"state" "tile_state" DEFAULT 'NORMAL' NOT NULL,
	"state_until" timestamp with time zone,
	CONSTRAINT "tiles_season_id_x_y_pk" PRIMARY KEY("season_id","x","y")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"legacy_points" integer DEFAULT 0 NOT NULL,
	"titles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
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
ALTER TABLE "alliance_events" ADD CONSTRAINT "alliance_events_alliance_id_alliances_id_fk" FOREIGN KEY ("alliance_id") REFERENCES "public"."alliances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliance_members" ADD CONSTRAINT "alliance_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliance_members" ADD CONSTRAINT "alliance_members_alliance_id_alliances_id_fk" FOREIGN KEY ("alliance_id") REFERENCES "public"."alliances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alliances" ADD CONSTRAINT "alliances_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_slots" ADD CONSTRAINT "base_slots_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "garrisons" ADD CONSTRAINT "garrisons_owner_id_players_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marches" ADD CONSTRAINT "marches_owner_id_players_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_population" ADD CONSTRAINT "player_population_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_resources" ADD CONSTRAINT "player_resources_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ruins" ADD CONSTRAINT "ruins_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_quotas" ADD CONSTRAINT "season_quotas_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_registrations" ADD CONSTRAINT "season_registrations_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "season_registrations" ADD CONSTRAINT "season_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sieges" ADD CONSTRAINT "sieges_target_alliance_id_alliances_id_fk" FOREIGN KEY ("target_alliance_id") REFERENCES "public"."alliances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sieges" ADD CONSTRAINT "sieges_attacker_alliance_id_alliances_id_fk" FOREIGN KEY ("attacker_alliance_id") REFERENCES "public"."alliances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "steward_log" ADD CONSTRAINT "steward_log_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stewards" ADD CONSTRAINT "stewards_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alliance_events_idx" ON "alliance_events" USING btree ("alliance_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alliances_name_uq" ON "alliances" USING btree ("season_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "alliances_tag_uq" ON "alliances" USING btree ("season_id","tag");--> statement-breakpoint
CREATE UNIQUE INDEX "alliances_hex_uq" ON "alliances" USING btree ("season_id","hex_code");--> statement-breakpoint
CREATE UNIQUE INDEX "alliances_color_uq" ON "alliances" USING btree ("season_id","color");--> statement-breakpoint
CREATE UNIQUE INDEX "alliances_faction_slot_uq" ON "alliances" USING btree ("season_id","faction","slot_no") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "reports_attacker_idx" ON "battle_reports" USING btree ("attacker_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_defender_idx" ON "battle_reports" USING btree ("defender_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_channel_idx" ON "chat_messages" USING btree ("channel_type","channel_id","id");--> statement-breakpoint
CREATE INDEX "events_pending_idx" ON "events" USING btree ("resolve_at","seq","id") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_id","resolve_at") WHERE resolved_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "garrisons_owner_at_uq" ON "garrisons" USING btree ("season_id","owner_id","at_x","at_y");--> statement-breakpoint
CREATE INDEX "garrisons_at_idx" ON "garrisons" USING btree ("season_id","at_x","at_y");--> statement-breakpoint
CREATE INDEX "marches_arrival_idx" ON "marches" USING btree ("arrives_at");--> statement-breakpoint
CREATE INDEX "marches_target_idx" ON "marches" USING btree ("season_id","to_x","to_y");--> statement-breakpoint
CREATE INDEX "marches_owner_idx" ON "marches" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_season_user_uq" ON "players" USING btree ("season_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "players_season_base_uq" ON "players" USING btree ("season_id","base_x","base_y");--> statement-breakpoint
CREATE INDEX "players_ai_idx" ON "players" USING btree ("season_id","is_ai");--> statement-breakpoint
CREATE INDEX "players_faction_idx" ON "players" USING btree ("season_id","faction");--> statement-breakpoint
CREATE INDEX "players_alliance_idx" ON "players" USING btree ("alliance_id");--> statement-breakpoint
CREATE INDEX "region_cap_holder_idx" ON "region_capacity" USING btree ("holder_kind","holder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reg_season_user_uq" ON "season_registrations" USING btree ("season_id","user_id");--> statement-breakpoint
CREATE INDEX "reg_squad_idx" ON "season_registrations" USING btree ("season_id","squad_code");--> statement-breakpoint
CREATE INDEX "sieges_active_idx" ON "sieges" USING btree ("resolves_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sieges_one_per_target_uq" ON "sieges" USING btree ("season_id","target_alliance_id") WHERE status = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "steward_log_player_idx" ON "steward_log" USING btree ("player_id","created_at");--> statement-breakpoint
CREATE INDEX "tiles_player_idx" ON "tiles" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX "tiles_alliance_idx" ON "tiles" USING btree ("season_id","alliance_id");