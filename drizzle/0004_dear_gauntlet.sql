CREATE TABLE "terrain_files" (
	"season_id" integer NOT NULL,
	"name" text NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "terrain_files_season_id_name_pk" PRIMARY KEY("season_id","name")
);
