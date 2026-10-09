/**
 * 交易。
 *
 * ★ 所有會寫入的動作都走這裡：讀 → 算 → 寫必須是原子的，
 *   否則併發的兩個請求會各自讀到舊狀態、各自扣一次錢。
 *
 * ## SQLite 怎麼守住「同一時間只有一個人改」
 *
 * Postgres 用 `SELECT … FOR UPDATE` 鎖一列；SQLite 沒有列鎖，但 libSQL 的交易預設是
 * `BEGIN IMMEDIATE`（mode `"write"`）：**一開始就拿到整個資料庫的寫入鎖**，
 * 其他寫入者在 busy timeout 內排隊。所以交易裡讀到的就是最新的、而且在提交前不會被別人改。
 *
 * ★ 代價是寫入完全序列化 —— 交易裡**不可以**等外部 API（施工引擎用租約，不抱交易，見 `builder.ts`）。
 */

import { getDb, type Db } from "./index";

/**
 * 寫入路徑拿到的資料庫：可以是整個連線，也可以是交易。兩者的查詢介面相同。
 * （型別上收斂成 `Db`；交易物件在執行期提供同樣的方法）
 */
export type TxDb = Db;

export async function withTransaction<T>(fn: (tx: TxDb) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => fn(tx as unknown as TxDb));
}
