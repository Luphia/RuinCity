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

// ★ 一定要是第一個 import —— 理由見該檔案
import "./load-env";

import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { Pool as PgPool } from "pg";

import { isNeonUrl } from "../lib/db/driver";

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
      "兩條路都可以：",
      "  · Neon：https://console.neon.tech 開一個免費專案，貼 connection string",
      "  · 本機：docker run -e POSTGRES_PASSWORD=ruincity -p 5432:5432 -d postgres:17",
      '           DATABASE_URL="postgresql://postgres:ruincity@127.0.0.1:5432/postgres"',
    ]);
  }

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

  const neon = isNeonUrl(url);
  console.log(`\n連線到 ${host}（${neon ? "neon-serverless" : "node-postgres"}）…`);

  const pool = neon
    ? new NeonPool({ connectionString: url })
    : new PgPool({ connectionString: url });
  if (neon && typeof WebSocket !== "undefined") neonConfig.webSocketConstructor = WebSocket;

  try {
    if (neon) {
      await migrateNeon(drizzleNeon(pool as NeonPool), { migrationsFolder: "drizzle" });
    } else {
      await migratePg(drizzlePg(pool as PgPool), { migrationsFolder: "drizzle" });
    }
    console.log("migration 套用完成。\n");
  } catch (e) {
    if (looksLikeConnectionFailure(e)) {
      fail([
        `連不上 ${host}。`,
        "",
        "常見原因：",
        ...(neon
          ? [
              "  · connection string 打錯，或專案已被 Neon 休眠/刪除",
              "  · 少了 `?sslmode=require`",
              "  · 網路擋掉了 WebSocket（Neon 的 serverless driver 走 wss）",
            ]
          : [
              "  · Postgres 沒在跑，或 port 不對",
              "  · 帳號密碼錯，或那個資料庫還不存在（createdb ruincity）",
            ]),
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
