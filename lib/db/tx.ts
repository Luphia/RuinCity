/**
 * 交易連線（WebSocket pool）。
 *
 * ## ★ 為什麼結算路徑不能用 `neon-http`
 *
 * `@neondatabase/serverless` 的 HTTP driver **不支援交易** ——
 * 每一句 SQL 都是獨立的一次往返。這對 Auth 與唯讀查詢沒問題，
 * 但結算是「讀狀態 → 算 → 扣資源 → 排事件」四步，
 * 中間任何一步失敗都會留下半套狀態（扣了錢沒排事件、或反過來）。
 *
 * 所以**任何會寫入的遊戲動作都必須走這裡的 WebSocket pool**。
 * 這是 M0 就記在 `docs/07` §1 與 CLAUDE.md 的已知地雷。
 */

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";

import * as schema from "./schema";
import * as authSchema from "./auth-schema";

let pool: Pool | null = null;

/**
 * Edge / Node 都能跑。在 Node 環境下 `ws` 需要顯式指定，
 * 但 Next.js 的 Node runtime 從 v22 起有全域 WebSocket，所以不用額外套件。
 */
function ensurePool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. 結算路徑需要真實連線，請填 .env.local。",
    );
  }
  if (typeof WebSocket !== "undefined") neonConfig.webSocketConstructor = WebSocket;
  pool = new Pool({ connectionString: url });
  return pool;
}

export type TxDb = ReturnType<typeof drizzle<typeof schema & typeof authSchema>>;

/**
 * 在一個交易裡跑一段程式。
 *
 * ★ 所有的遊戲寫入都應該經過這個函式，而不是直接用 `db`。
 * 讀 → 算 → 寫必須是原子的，否則併發的兩個請求會各自讀到舊狀態、
 * 各自扣一次錢（經典的 double-spend）。
 */
export async function withTransaction<T>(fn: (tx: TxDb) => Promise<T>): Promise<T> {
  const client = drizzle(ensurePool(), { schema: { ...schema, ...authSchema } });
  return client.transaction(async (tx) => fn(tx as unknown as TxDb));
}

/** 測試與 graceful shutdown 用 */
export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = null;
}
