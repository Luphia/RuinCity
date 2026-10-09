/**
 * 套用 migration（SQLite／libSQL）。
 *
 *   pnpm db:migrate
 *
 * `DATABASE_URL` 沒設時用本機檔 `./data/ruincity.db`（資料夾會自動建立），見 `lib/db/url.ts`。
 *
 * ## ★ 為什麼不直接用 `drizzle-kit migrate`
 *
 * 它**把錯誤吞掉了**：連不上、權杖錯、SQL 撞到既有物件，全部長成
 * `ELIFECYCLE Command failed with exit code 1`，沒有訊息。
 * 這支腳本用 `drizzle-orm` 的 migrator 做同一件事 —— 同一個 `drizzle/` 資料夾、
 * 同一張 `__drizzle_migrations` 紀錄表 —— 但錯誤會照實印出來，並講出下一步。
 */

// ★ 一定要是第一個 import —— 理由見該檔案
import "./load-env";

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

import { BUSY_TIMEOUT_MS, databaseUrl, ensureLocalDir, isLocalFile, localPath } from "../lib/db/url";

function fail(lines: string[]): never {
  console.error("\n" + lines.join("\n") + "\n");
  process.exit(1);
}

/** 走 cause 鏈找錯誤訊息（drizzle 會把 driver 的錯誤包起來） */
function messages(e: unknown): string {
  const out: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) out.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out.join(" ← ");
}

async function main() {
  let url: string;
  try {
    url = databaseUrl();
  } catch (e) {
    fail([e instanceof Error ? e.message : String(e)]);
  }

  const local = isLocalFile(url);
  // 只印位置，不印權杖
  let where = url;
  if (local) where = localPath(url);
  else {
    try {
      where = new URL(url).host;
    } catch {
      fail(["DATABASE_URL 不是合法的網址。", "", "本機：file:./data/ruincity.db", "遠端：libsql://<資料庫>-<帳號>.turso.io（配 DATABASE_AUTH_TOKEN）"]);
    }
  }
  console.log(`\n資料庫：${local ? "SQLite 檔" : "遠端 libSQL"} ${where}`);

  try {
    ensureLocalDir(url);
  } catch (e) {
    fail([`建不了資料夾：${messages(e)}`, "", "換一個有寫入權限的位置：DATABASE_URL=\"file:/某個可寫的路徑/ruincity.db\""]);
  }

  const client = createClient({
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    timeout: BUSY_TIMEOUT_MS,
  });
  try {
    if (local) await client.execute("PRAGMA journal_mode = WAL");
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    console.log("migration 套用完成。\n");
  } catch (e) {
    const msg = messages(e);
    if (/SQLITE_BUSY|database is locked/i.test(msg)) {
      fail([`資料庫被鎖住了（${where}）。`, "", "另一個行程正在寫它（例如還開著的 pnpm dev／pnpm start）。關掉再試一次。"]);
    }
    if (/SQLITE_CANTOPEN|unable to open/i.test(msg)) {
      fail([`開不了資料庫檔 ${where}。`, "", "檢查路徑與寫入權限。"]);
    }
    if (/401|403|unauthori[sz]ed|auth/i.test(msg) && !local) {
      fail([`遠端 libSQL 拒絕連線（${where}）。`, "", "DATABASE_AUTH_TOKEN 沒設或過期：turso db tokens create <資料庫>"]);
    }
    if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(msg) && !local) {
      fail([`連不上 ${where}。`, "", "檢查網址與網路；Turso 的網址長得像 libsql://<資料庫>-<帳號>.turso.io"]);
    }
    console.error("\nmigration 失敗：");
    console.error(e);
    process.exit(1);
  } finally {
    client.close();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
