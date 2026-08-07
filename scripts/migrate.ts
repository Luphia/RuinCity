/**
 * 套用 migration。
 *
 *   pnpm db:migrate
 *
 * ## ★ 為什麼不直接用 `drizzle-kit migrate`
 *
 * 它**把錯誤吞掉了**。連不上資料庫、SQL 撞到既有物件、密碼錯 ——
 * 全部長成同一個樣子：
 *
 *     [⣷] applying migrations... ELIFECYCLE  Command failed with exit code 1
 *
 * 沒有訊息、沒有堆疊、沒有是哪一支 migration。第一次架環境的人
 * 只能靠猜，而最常見的原因（`.env.example` 的 placeholder 沒換掉）
 * 剛好是最容易一眼看穿、卻完全沒被說出來的那一個。
 *
 * 這支腳本用 `drizzle-orm` 的 migrator 做同一件事 ——
 * 同一個 `drizzle/` 資料夾、同一張 `drizzle.__drizzle_migrations` 紀錄表，
 * 所以與 `drizzle-kit generate` 完全相容 —— 但錯誤會照實印出來。
 */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

import { Pool, neonConfig } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

/** `.env.example` 裡的假值。原封不動貼過去是第一次架環境最常見的失手 */
const PLACEHOLDER_HOST = "host.neon.tech";

/**
 * 這個錯誤是「連不上」還是「SQL 有問題」？
 *
 * ★ 要走 cause 鏈。Neon 的 WebSocket 失敗丟的是一個 `ErrorEvent`
 *   （`console.error` 出來只有 `{ type: 'error', timeStamp: 832 }`），
 *   但 drizzle 會把它包進 `DrizzleQueryError` —— 只看最外層那一顆
 *   會判成一般的查詢錯誤，然後給出完全誤導的建議。
 */
function looksLikeConnectionFailure(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    // 未包裝的 ErrorEvent：有 type 但不是 Error
    if (!(cur instanceof Error) && "type" in cur) return true;
    const msg = cur instanceof Error ? cur.message : "";
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|password authentication|SASL|terminat/i.test(msg)) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function fail(lines: string[]): never {
  console.error("\n" + lines.join("\n") + "\n");
  process.exit(1);
}

async function main() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    fail([
      "DATABASE_URL 沒有設定。",
      "",
      "  cp .env.example .env.local     # 沒有這個檔案的話直接建 .env.local",
      '  DATABASE_URL="postgresql://user:pass@ep-xxx.aws.neon.tech/dbname?sslmode=require"',
    ]);
  }

  if (url.includes(PLACEHOLDER_HOST)) {
    fail([
      `DATABASE_URL 還是 .env.example 的範例值（${PLACEHOLDER_HOST}）。`,
      "",
      "去 https://console.neon.tech 開一個免費專案，把 connection string 貼進 .env.local。",
      "真實的 host 長得像 `ep-something-12345.ap-southeast-1.aws.neon.tech`。",
    ]);
  }

  if (typeof WebSocket !== "undefined") neonConfig.webSocketConstructor = WebSocket;

  // 只印 host，不印帳密
  let host = "(無法解析)";
  try {
    host = new URL(url).host;
  } catch {
    fail([
      "DATABASE_URL 不是合法的 URL。",
      "",
      "格式：postgresql://user:pass@host/dbname?sslmode=require",
      "（密碼裡有 `@` 或 `/` 之類的字元時要 percent-encode）",
    ]);
  }

  console.log(`\n連線到 ${host} …`);
  const pool = new Pool({ connectionString: url });

  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "drizzle" });
    console.log("migration 套用完成。\n");
  } catch (e) {
    if (looksLikeConnectionFailure(e)) {
      fail([
        `連不上 ${host}。`,
        "",
        "常見原因：",
        "  · connection string 打錯，或專案已被 Neon 休眠/刪除",
        "  · 少了 `?sslmode=require`",
        "  · 網路擋掉了 WebSocket（Neon 的 serverless driver 走 wss）",
      ]);
    }
    console.error("\nmigration 失敗：");
    console.error(e);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
