import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * SQLite（libSQL）。`pnpm db:generate` 只看 schema，不連資料庫；
 * 套用 migration 用 `pnpm db:migrate`（`scripts/migrate.ts`），不是 drizzle-kit migrate。
 */
export default defineConfig({
  schema: ["./lib/db/schema.ts", "./lib/db/auth-schema.ts"],
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL || "file:./data/ruincity.db",
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  },
  verbose: true,
  strict: true,
});
