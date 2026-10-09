/**
 * 資料庫連線：SQLite（libSQL）。本機是一個檔案，正式環境可以是遠端 libSQL（Turso）。
 *
 * ★ **惰性建立**：第一次呼叫 `getDb()` 才開檔案。`next build` 與單元測試不會碰到資料庫，
 *   也不會在建置時於工作目錄留下一個空的 .db 檔。
 * ★ 每個行程一個 client。本機檔案在行程內先排隊（`serial.ts`：同步驅動在等鎖時會卡住事件迴圈），
 *   跨行程（web 與 worker 同時寫同一個檔案）靠 WAL 與 busy timeout。
 */

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";

import * as authSchema from "./auth-schema";
import * as schema from "./schema";
import { serializeClient } from "./serial";
import { BUSY_TIMEOUT_MS, databaseUrl, ensureLocalDir, isLocalFile } from "./url";

const fullSchema = { ...schema, ...authSchema };

export type Db = LibSQLDatabase<typeof fullSchema>;

let current: { url: string; client: Client; db: Db } | null = null;

/**
 * 建立（或重用）連線。
 *
 * ★ 會檢查 `DATABASE_URL` 有沒有在建好之後才被填上（腳本的 import 順序問題，見 `scripts/load-env.ts`）：
 *   變了就重建，而不是一直連著舊的位置。
 */
export function getDb(): Db {
  const url = databaseUrl();
  if (current?.url === url) return current.db;
  ensureLocalDir(url);
  const raw = createClient({
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    timeout: BUSY_TIMEOUT_MS,
  });
  // 本機檔案：行程內排隊（理由見 `serial.ts`）。遠端 libSQL 由伺服器處理併發
  const client = isLocalFile(url) ? serializeClient(raw, BUSY_TIMEOUT_MS * 2) : raw;
  if (isLocalFile(url)) {
    // WAL：讀不擋寫、寫不擋讀，web 與 worker 才能同時用同一個檔案。設定會存在檔案裡
    void client.execute("PRAGMA journal_mode = WAL").catch(() => {});
  }
  const db = drizzle(client, { schema: fullSchema });
  current = { url, client, db };
  return db;
}

/** 測試與 graceful shutdown 用 */
export function closeDb(): void {
  current?.client.close();
  current = null;
}

export { schema, authSchema };
