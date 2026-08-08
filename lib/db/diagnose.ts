/**
 * 資料庫錯誤的診斷。純函式，無 I/O。
 *
 * ★ 要走 cause 鏈（與 `scripts/migrate.ts` 同一課）：drizzle 把真正的
 *   Postgres 錯誤包在 `DrizzleQueryError.cause` 裡，最外層的訊息只有
 *   「Failed query: …」—— 對使用者毫無行動指引。
 */

/**
 * 「資料表不存在」（42P01）是 **schema 落後於程式碼**的招牌症狀 ——
 * 拉了新程式碼、沒跑 `pnpm db:migrate`。回傳缺的資料表名，找不到回 null。
 */
export function missingRelation(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 10; depth++) {
    const code = (cur as { code?: unknown }).code;
    const msg = cur instanceof Error ? cur.message : String(cur);
    const m = /relation "([^"]+)" does not exist/.exec(msg);
    if (m) return m[1]!;
    if (code === "42P01") return "?";
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** 把資料庫錯誤翻成「使用者下一步該做什麼」；翻不出來就回原訊息 */
export function explainDbError(e: unknown): string {
  const table = missingRelation(e);
  if (table) {
    return (
      `資料表 ${table} 不存在 —— 資料庫結構落後於程式碼。` +
      `先執行：pnpm db:migrate`
    );
  }
  return e instanceof Error ? e.message : String(e);
}
