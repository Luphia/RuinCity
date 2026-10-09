import "./load-env";

/**
 * 本機／自架的施工排程：`pnpm worker`。
 *
 * 正式環境由 Vercel Cron 打 `/api/cron/build`；自架沒有東西扮演那個角色，
 * 這個迴圈就是它。它**只是一個打那條路由的計時器** —— 施工邏輯只有一份，
 * 在 web 行程裡（`lib/server/builder.ts`），不在這裡。
 *
 * 用法：
 *   pnpm worker                   # 每 10 秒一輪，Ctrl-C 結束
 *   pnpm worker --interval 30
 *   pnpm worker --once            # 只跑一輪
 *   WORKER_BASE_URL=http://127.0.0.1:5000 pnpm worker
 *
 * ★ 一輪做完才排下一輪（路由每輪最多跑 50 秒）；單輪失敗印出來然後繼續。
 */

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const ONCE = process.argv.includes("--once");
const INTERVAL_MS = Math.max(1, Number(argValue("--interval") ?? 10)) * 1000;
const BASE = process.env.WORKER_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 5000}`;
const hhmmss = () => new Date().toISOString().slice(11, 19);

async function tick() {
  const headers: Record<string, string> = {};
  if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
  const res = await fetch(`${BASE}/api/cron/build`, { headers });
  const json = (await res.json().catch(() => ({}))) as { steps?: number; completed?: number; error?: string; skipped?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  if (json.skipped) return `略過（${json.skipped}）`;
  return json.steps || json.completed ? `施工 ${json.steps} 步、完工 ${json.completed} 塊` : "無事";
}

async function main() {
  for (;;) {
    try {
      console.log(`[${hhmmss()}] [worker] ${await tick()}`);
    } catch (e) {
      console.error(`[${hhmmss()}] [worker] 失敗：${e instanceof Error ? e.message : String(e)}（${BASE} 還沒起來？）`);
    }
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

void main();
