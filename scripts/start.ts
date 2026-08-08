import "./load-env";

/**
 * `pnpm start`：先把環境初始化完，再啟動一切需要的服務。
 *
 * 順序（每一步失敗都要**講清楚下一步**，不是丟一個 stack trace）：
 *
 *   1. 檢查 production build 存在（沒有 → 先執行 pnpm build）
 *   2. 資料庫 migration（`pnpm db:migrate` 的那一份，含 cause 鏈診斷）
 *   3. 同時啟動：
 *        [web]     next start（instrumentation 會在啟動時確保地形檔）
 *        [worker]  結算迴圈（執政官、行軍、賽季推進）
 *      任一個死掉就把另一個也收掉、以它的退出碼結束 ——
 *      「web 活著但 worker 早就死了」是最難察覺的半殘狀態。
 *
 * ★ 沒設 DATABASE_URL（或還是範本的佔位值）時**只跑 web**：
 *   E2E 與純前端預覽本來就沒有資料庫，這是正常模式不是錯誤 ——
 *   但要在啟動時講出來，不能讓人以為遊戲邏輯在動。
 *
 * ★ Vercel 不走這裡（它自己 serve build、cron 打 /api/cron/settle）。
 *   這個入口是給本機與自架的：一個指令，整套服務。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const hhmmss = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[${hhmmss()}] [start] ${line}`);

/** 沒設定資料庫（而不是設定壞了）的判準 —— 這是模式不是錯誤 */
function databaseConfigured(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) return false;
  if (url.includes("unset.invalid")) return false;
  // 還是 .env.example 的範本值 —— 複製了檔案但沒填
  if (url.includes("user:password@host.neon.tech")) return false;
  return true;
}

function main() {
  // ── 1. build 必須存在 ─────────────────────────────────────
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
    console.error(`[start] 找不到 production build —— 先執行：pnpm build`);
    process.exit(1);
  }

  const hasDb = databaseConfigured();

  // ── 2. migration ─────────────────────────────────────────
  if (hasDb) {
    log("初始化：資料庫 migration…");
    const r = spawnSync("pnpm", ["db:migrate"], { stdio: "inherit" });
    if (r.status !== 0) {
      // migrate.ts 已經把「下一步該做什麼」印出來了，這裡不重複
      console.error(`[start] migration 失敗 —— 修好上面那件事再啟動。`);
      process.exit(r.status ?? 1);
    }
  } else {
    log("⚠ 沒有設定 DATABASE_URL —— 只啟動 web（遊戲邏輯不會動）。");
    log("  要玩的話：cp .env.example .env.local 填入連線字串，然後 pnpm db:migrate。");
  }

  // ── 3. 啟動服務 ───────────────────────────────────────────
  // `pnpm start --port 3100` 之類的參數原封轉給 next
  const extraArgs = process.argv.slice(2);
  const children = new Map<string, ChildProcess>();
  let shuttingDown = false;

  const launch = (name: string, cmd: string, args: string[]) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    children.set(name, child);

    // 兩個服務的輸出交錯在同一個終端機 —— 沒有前綴就分不出誰在說話
    for (const stream of [child.stdout, child.stderr] as const) {
      if (!stream) continue;
      const rl = createInterface({ input: stream });
      rl.on("line", (line) => console.log(`[${name}] ${line}`));
    }

    child.on("exit", (code, signal) => {
      children.delete(name);
      if (shuttingDown) return;
      shuttingDown = true;
      // 任一個死掉，另一個也收掉 —— 半殘比全停更難察覺
      console.error(
        `[start] [${name}] 結束（${signal ?? `code ${code}`}）—— 收掉其餘服務。`,
      );
      for (const [, c] of children) c.kill("SIGTERM");
      setTimeout(() => process.exit(code ?? 1), 500);
    });
    log(`[${name}] 已啟動（pid ${child.pid}）`);
  };

  launch("web", "pnpm", ["exec", "next", "start", ...extraArgs]);
  if (hasDb) {
    launch("worker", "pnpm", ["worker"]);
  }

  const shutdown = (sig: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${sig}，關閉所有服務…`);
    for (const [, c] of children) c.kill("SIGTERM");
    setTimeout(() => process.exit(0), 1500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
