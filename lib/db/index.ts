import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { isNeonUrl } from "./driver";
import * as schema from "./schema";
import * as authSchema from "./auth-schema";

/**
 * 唯讀查詢與 Auth.js 用的連線。
 *
 * 對於**需要交易**的結算路徑（見 docs/07 §2.3）必須改用 `./tx.ts` ——
 * Neon 的 HTTP driver 不支援交易。
 *
 * ★ Driver 由 URL 決定（`./driver.ts`）：Neon 端點走 neon-http，
 *   其餘（本機 docker、Supabase、RDS…）走 node-postgres 的 TCP pool。
 */

/**
 * `next build` 與單元測試都不該因為缺少 DATABASE_URL 而失敗，
 * 但也不該悄悄連到某個真實的地方。用 `.invalid`（RFC 2606 保留的 TLD），
 * 真的送出查詢時會以清楚的 DNS 錯誤爆掉。
 */
const PLACEHOLDER_URL = "postgresql://unset:unset@unset.invalid/unset";

const fullSchema = { ...schema, ...authSchema };

export type Db = ReturnType<typeof drizzleNeon<typeof fullSchema>>;

/**
 * 永遠可建構的實例。Auth.js 的 DrizzleAdapter 需要在設定階段就拿到
 * 一個真的 Drizzle 物件（它會檢查 dialect），所以不能延遲。
 *
 * ★ 兩個 driver 的查詢介面完全相同（都是 drizzle 的 PgDatabase），
 *   型別上卻是兩個不同的分支。這裡收斂成一個 —— 呼叫端不需要知道
 *   自己連的是 Neon 還是本機的 Postgres，那正是重點。
 */
function createDb(): Db {
  const url = process.env.DATABASE_URL ?? PLACEHOLDER_URL;
  if (isNeonUrl(url)) {
    return drizzleNeon(neon(url), { schema: fullSchema });
  }
  // pg.Pool 是惰性的 —— 建構時不連線，所以 placeholder 也不會爆
  return drizzlePg(new Pool({ connectionString: url }), {
    schema: fullSchema,
  }) as unknown as Db;
}

export const db = createDb();

/** `db` 是用哪一個 URL 建的。用來偵測「建好之後 env 才被填上」 */
let builtWith = process.env.DATABASE_URL ?? PLACEHOLDER_URL;
let rebuilt: Db | null = null;

/**
 * 應用程式碼一律走這裡，缺 env 時給出可行動的錯誤訊息。
 *
 * ★ 會檢查「`db` 建好之後 `DATABASE_URL` 有沒有變」。
 *
 *   `db` 在模組載入時就建好（Auth.js 的 adapter 需要），所以只要有任何
 *   consumer 比 env 早載入，它拿到的就是 placeholder ——
 *   然後在**第一次查詢**時炸成 `getaddrinfo ENOTFOUND unset.invalid`，
 *   而 `.env.local` 明明是填好的。腳本用 dotenv 時特別容易踩到，
 *   因為 import 會先於任何語句求值。
 *
 *   `scripts/load-env.ts` 從源頭解掉了順序問題；這裡是安全網，
 *   讓「順序錯了」的代價是重建一次連線，而不是一個查不出原因的 DNS 錯誤。
 */
export function getDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
    );
  }
  if (url === builtWith) return rebuilt ?? db;
  builtWith = url;
  rebuilt = createDb();
  return rebuilt;
}

export { schema, authSchema };
