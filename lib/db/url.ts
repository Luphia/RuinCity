/**
 * 資料庫在哪裡。
 *
 * | `DATABASE_URL` | 意思 |
 * | --- | --- |
 * | 沒設 | 本機 SQLite 檔 `./data/ruincity.db`（第一次會自動建立） |
 * | `file:./路徑.db` | 指定的本機 SQLite 檔 |
 * | `libsql://…`、`https://…` | 遠端 libSQL（例如 Turso），配 `DATABASE_AUTH_TOKEN` |
 *
 * ★ 沒設也能跑：`pnpm start` 不需要先架任何資料庫。
 * ★ Vercel 之類的 serverless 平台**不能**用本機檔案（每次部署、每個執行個體都是空的檔案系統），
 *   一定要設遠端 libSQL。`onServerless()` 為真而沒設時，第一次查詢會講清楚原因。
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_DATABASE_URL = "file:./data/ruincity.db";

/**
 * 同一個檔案會被 web 與 worker 兩個行程同時寫。SQLite 一次只讓一個寫入者進來，
 * 其他人等這麼久（毫秒）；預設 0 的話撞到就直接 SQLITE_BUSY。
 */
export const BUSY_TIMEOUT_MS = 10_000;


type Env = Record<string, string | undefined>;

export function onServerless(env: Env = process.env): boolean {
  return Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.NETLIFY);
}

export function databaseUrl(env: Env = process.env): string {
  const url = env.DATABASE_URL?.trim();
  if (url) return url;
  if (onServerless(env)) {
    throw new Error(
      "DATABASE_URL 沒有設定。serverless 平台不能用本機 SQLite 檔（檔案系統不保存），請設定遠端 libSQL（例如 Turso）的 libsql:// 網址與 DATABASE_AUTH_TOKEN。",
    );
  }
  return DEFAULT_DATABASE_URL;
}

export function isLocalFile(url: string): boolean {
  return url.startsWith("file:");
}

/** `file:./data/x.db` → 絕對路徑 */
export function localPath(url: string): string {
  return resolve(url.slice("file:".length).replace(/^\/\/(?=\/)/, ""));
}

/** 本機檔案的資料夾要先存在，SQLite 不會幫你建資料夾 */
export function ensureLocalDir(url: string): void {
  if (isLocalFile(url)) mkdirSync(dirname(localPath(url)), { recursive: true });
}
