CREATE TYPE "public"."listing_status" AS ENUM('OPEN', 'TAKEN', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE 'MARKET_DELIVERY' BEFORE 'ISOLATION_EXPIRE';--> statement-breakpoint
CREATE TABLE "market_listings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"seller_id" bigint NOT NULL,
	"alliance_id" bigint NOT NULL,
	"offer_resource" text NOT NULL,
	"offer_amount" numeric(14, 3) NOT NULL,
	"want_resource" text NOT NULL,
	"want_amount" numeric(14, 3) NOT NULL,
	"status" "listing_status" DEFAULT 'OPEN' NOT NULL,
	"buyer_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "listing_amounts_positive" CHECK ("market_listings"."offer_amount" > 0 AND "market_listings"."want_amount" > 0),
	CONSTRAINT "listing_distinct_resources" CHECK ("market_listings"."offer_resource" <> "market_listings"."want_resource")
);
--> statement-breakpoint
CREATE TABLE "market_transfers" (
	"player_id" bigint NOT NULL,
	"game_month" smallint NOT NULL,
	"amount" numeric(14, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "market_transfers_player_id_game_month_pk" PRIMARY KEY("player_id","game_month")
);
--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_seller_id_players_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_listings" ADD CONSTRAINT "market_listings_buyer_id_players_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_transfers" ADD CONSTRAINT "market_transfers_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listings_alliance_idx" ON "market_listings" USING btree ("season_id","alliance_id") WHERE status = 'OPEN';--> statement-breakpoint
CREATE INDEX "listings_seller_idx" ON "market_listings" USING btree ("seller_id") WHERE status = 'OPEN';