import "./load-env";

/**
 * 第一次架環境：產生 `.env.local`，然後建立資料庫。
 *
 *   pnpm run initial            產生 .env.local（已存在就只補缺的，不改你填過的值）
 *   pnpm run initial --demo     同時打開示範模式（不花錢、不連外）
 *   pnpm run initial --force    把現有的 .env.local 備份成 .env.local.bak-<時間>，重新產生
 *   pnpm run initial --no-migrate   只產生設定檔，不建資料庫
 *
 * 產生的內容來自 `.env.example`：兩個隨機密鑰（AUTH_SECRET、CRON_SECRET）會填好，
 * 其餘都是選填、維持註解。
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { parseEnv } from "./env-file";
import { ensureLocalEnv } from "./local-env";

const args = new Set(process.argv.slice(2));
const demo = args.has("--demo");

const r = ensureLocalEnv({ demo, force: args.has("--force") });
const target = r.path;
if (r.backup) console.log(`已備份舊的 .env.local → ${r.backup}`);
if (r.created) {
  console.log(`已產生 .env.local（AUTH_SECRET、CRON_SECRET 已填入隨機值${demo ? "，示範模式已打開" : ""}）`);
} else {
  console.log(".env.local 已存在 —— 只補缺的，不改你填過的值：");
  for (const c of r.changes) {
    const verb = c.action === "added" ? "新增（隨機產生）" : c.action === "commented" ? "改為註解" : "保留";
    console.log(`  ${verb} ${c.key}${c.note ? `：${c.note}` : ""}`);
  }
}

// ── 現在開著什麼 ───────────────────────────────────────────────
const env = parseEnv(readFileSync(target, "utf8"));
const on = (k: string) => Boolean(env.get(k));
const painters = [on("GEMINI_API_KEY") && "Gemini", on("OPENAI_API_KEY") && "GPT Image"].filter(Boolean);
console.log("");
console.log(`  資料庫      ${env.get("DATABASE_URL") || "本機 SQLite ./data/ruincity.db"}`);
console.log(
  `  繪製        ${env.get("FAKE_PROVIDERS") === "1" ? "示範模式" : painters.length ? painters.join("、") : "沒有金鑰 —— 只能用示範模式（pnpm run initial --demo）"}`,
);
console.log(`  參考影像    ${on("GOOGLE_MAPS_API_KEY") ? "Google Street View／Maps Static" : "沒有（只靠文字描述構圖）"}`);
console.log(`  金流        ${env.get("PAYMENTS") === "demo" ? "示範（按一下就當作付款成功）" : "未設定（不能捐款）"}`);
console.log(`  登入        ${on("EMAIL_SERVER") ? "Email" : "開發模式：登入連結印在終端機"}${on("AUTH_GOOGLE_ID") ? "＋Google" : ""}`);
console.log(`  永久保存    ${on("BOLT_RPC_URL") ? "Boltchain SwarmStorage" : env.get("FAKE_PROVIDERS") === "1" ? "示範" : "只打包、不上鏈"}`);
console.log("");

// ── 資料庫 ────────────────────────────────────────────────────
if (!args.has("--no-migrate")) {
  const r = spawnSync("pnpm", ["db:migrate"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log("完成。接下來：pnpm dev（開發）或 pnpm build && pnpm start（正式模式），打開 http://localhost:5000");
