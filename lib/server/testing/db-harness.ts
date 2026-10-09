/**
 * 整合測試用的**真** SQLite（libSQL），每個測試檔一個暫存檔。
 *
 * 交易、`ON CONFLICT`、部分唯一索引、CHECK 約束全部是真的 ——
 * 捐款入帳、施工租約、「同一步只能成功一次」正是要靠這些才守得住的地方。
 *
 * ★ 用暫存**檔案**，不用 `:memory:`：libSQL 的交易會從連線池借一條專屬連線，
 *   而 in-memory 資料庫只存在於開它的那一條連線上 —— 換一條連線就是另一個空的資料庫。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import * as authSchema from "@/lib/db/auth-schema";
import * as schema from "@/lib/db/schema";
import type { TxDb } from "@/lib/db/tx";
import { serializeClient } from "@/lib/db/serial";
import { BUSY_TIMEOUT_MS } from "@/lib/db/url";

export interface Harness {
  readonly db: TxDb;
  /** 在一個交易裡跑一段程式，簽章與 production 的 `withTransaction` 相同 */
  readonly tx: <T>(fn: (tx: TxDb) => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ruincity-test-"));
  // 與 production 相同：行程內排隊（`lib/db/serial.ts`）
  const client = serializeClient(createClient({ url: `file:${join(dir, "test.db")}`, timeout: BUSY_TIMEOUT_MS }), BUSY_TIMEOUT_MS * 2);
  await client.execute("PRAGMA journal_mode = WAL");
  const db = drizzle(client, { schema: { ...schema, ...authSchema } });
  await migrate(db, { migrationsFolder: "drizzle" });
  return {
    db,
    tx: (fn) => db.transaction(async (t) => fn(t as unknown as TxDb)),
    close: async () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let userCounter = 0;

/** 建一個 Auth.js 使用者，回傳 id */
export async function seedUser(h: Harness, name?: string): Promise<string> {
  const id = `user-${++userCounter}`;
  await h.db.insert(authSchema.authUsers).values({ id, email: `${id}@test.local`, name: name ?? id });
  return id;
}
