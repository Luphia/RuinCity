import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";
import * as authSchema from "./auth-schema";

/**
 * Neon serverless HTTP driver。
 *
 * 對於**需要交易**的結算路徑（見 docs/07 §2.3）必須改用
 * `drizzle-orm/neon-serverless` 的 WebSocket pool —— HTTP driver 不支援交易。
 * M0 只建立基本連線，交易層在 M2 隨結算引擎一起做。
 */

/**
 * `next build` 與單元測試都不該因為缺少 DATABASE_URL 而失敗，
 * 但也不該悄悄連到某個真實的地方。用 `.invalid`（RFC 2606 保留的 TLD），
 * 真的送出查詢時會以清楚的 DNS 錯誤爆掉。
 */
const PLACEHOLDER_URL = "postgresql://unset:unset@unset.invalid/unset";

/**
 * 永遠可建構的實例。Auth.js 的 DrizzleAdapter 需要在設定階段就拿到
 * 一個真的 Drizzle 物件（它會檢查 dialect），所以不能延遲。
 */
export const db = drizzle(neon(process.env.DATABASE_URL ?? PLACEHOLDER_URL), {
  schema: { ...schema, ...authSchema },
});

/** 應用程式碼一律走這裡，缺 env 時給出可行動的錯誤訊息 */
export function getDb(): typeof db {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
    );
  }
  return db;
}

export { schema, authSchema };
export type Db = typeof db;
