/**
 * 整合測試用的**真** Postgres（PGlite，編進 WASM 的 Postgres）。
 *
 * 沒有容器、沒有連線字串，但交易、`ON CONFLICT`、部分唯一索引、CHECK 約束全部是真的 ——
 * 而捐款入帳、施工租約、「同一步只能成功一次」正是要靠這些才守得住的地方。
 *
 * ★ 這個檔案**不會**進到應用程式的模組圖裡，所以 `@electric-sql/pglite` 留在 devDependencies。
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import * as schema from "@/lib/db/schema";
import * as authSchema from "@/lib/db/auth-schema";
import type { TxDb } from "@/lib/db/tx";

export interface Harness {
  readonly db: TxDb;
  /** 在一個交易裡跑一段程式，簽章與 production 的 `withTransaction` 相同 */
  readonly tx: <T>(fn: (tx: TxDb) => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const client = new PGlite();
  const db = drizzle(client, { schema: { ...schema, ...authSchema } });
  await migrate(db, { migrationsFolder: "drizzle" });
  /**
   * ★ PGlite 與 neon-serverless 的 driver 型別不同，但執行期的介面一樣
   *   （都是 drizzle 的 PgDatabase）。production code 一律接 `TxDb`，所以轉一次就好。
   */
  const asTx = db as unknown as TxDb;
  return {
    db: asTx,
    tx: (fn) => db.transaction(async (t) => fn(t as unknown as TxDb)),
    close: () => client.close(),
  };
}

let userCounter = 0;

/** 建一個 Auth.js 使用者，回傳 id */
export async function seedUser(h: Harness, name?: string): Promise<string> {
  const id = `user-${++userCounter}`;
  await h.db.insert(authSchema.authUsers).values({ id, email: `${id}@test.local`, name: name ?? id });
  return id;
}
