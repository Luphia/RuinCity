import "./load-env";

/**
 * 本機/自架的結算 worker：`pnpm worker`。
 *
 * ★ production 由 Vercel Cron 每分鐘打 `/api/cron/settle`；
 *   本機沒有任何東西扮演那個角色 —— 於是執政官不動、行軍不抵達、
 *   賽季不推進，只剩「打開頁面那一刻」的惰性結算。這個迴圈跑的是
 *   **與路由完全相同**的 `runCronTick`（`lib/server/cron.ts`），
 *   不是第二份邏輯。
 *
 * 用法：
 *   pnpm worker                 # 每 60 秒一輪，Ctrl-C 結束
 *   pnpm worker --interval 10   # 開發時想看執政官動起來，10 秒一輪
 *   pnpm worker --once          # 只跑一輪就退出（外部 cron / 除錯用）
 *
 * ★ 一輪做完才排下一輪（不會重疊）；單輪失敗印出來然後繼續 ——
 *   worker 的死法只有 Ctrl-C，不會因為一次 DB 抖動就整個停掉。
 */

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const ONCE = process.argv.includes("--once");
const INTERVAL_MS = Math.max(1, Number(argValue("--interval") ?? 60)) * 1000;

const hhmmss = () => new Date().toISOString().slice(11, 19);

function describe(tick: {
  seasons: { locked: number; started: number; ended: number; created: number | null };
  marches: { resolved: number; battles: number; failures: number };
  settled: number;
  stewardRuns: number;
  failures: number;
  pending: number;
  note: string | null;
  errors: string[];
}): string {
  const parts: string[] = [];
  if (tick.settled > 0) parts.push(`結算 ${tick.settled}`);
  if (tick.stewardRuns > 0) parts.push(`執政官 ${tick.stewardRuns}`);
  if (tick.marches.resolved > 0) {
    parts.push(`行軍 ${tick.marches.resolved}（戰鬥 ${tick.marches.battles}）`);
  }
  const s = tick.seasons;
  if (s.locked || s.started || s.ended || s.created !== null) {
    parts.push(
      `賽季 封盤${s.locked}/開賽${s.started}/結束${s.ended}` +
        (s.created !== null ? `/新建#${s.created}` : ""),
    );
  }
  if (tick.pending > 0) parts.push(`待處理 ${tick.pending}`);
  if (tick.failures > 0 || tick.marches.failures > 0) {
    parts.push(`⚠ 失敗 ${tick.failures + tick.marches.failures}`);
  }
  if (tick.note) parts.push(tick.note);
  return parts.length > 0 ? parts.join(" · ") : "無事";
}

async function main() {
  const { runCronTick } = await import("@/lib/server/cron");
  const { serverNow } = await import("@/lib/time");

  let stop = false;
  const onSignal = (sig: string) => {
    console.log(`\n[${hhmmss()}] 收到 ${sig}，這一輪做完就停。`);
    stop = true;
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  console.log(
    `[${hhmmss()}] worker 啟動：每 ${INTERVAL_MS / 1000} 秒一輪` +
      (ONCE ? "（--once：只跑一輪）" : "，Ctrl-C 結束"),
  );

  // ★ 啟動時先確保最新一季的地形檔可用（磁碟 → 資料庫 → 重新生成）
  try {
    const { ensureLatestTerrain } = await import("@/lib/server/terrain-files");
    await ensureLatestTerrain((line) => console.log(`[${hhmmss()}] [terrain] ${line}`));
  } catch (e) {
    console.error(`[${hhmmss()}] ⚠ 地形啟動確保失敗：`, e instanceof Error ? e.message : e);
  }

  while (!stop) {
    const startedAt = Date.now();
    try {
      const tick = await runCronTick(await serverNow());
      const took = Date.now() - startedAt;
      console.log(`[${hhmmss()}] ${describe(tick)}（${took}ms）`);
      // ★ 失敗要看得見：區段錯誤逐條印，不收進摘要裡含糊帶過
      for (const e of tick.errors) console.error(`[${hhmmss()}] ⚠ ${e}`);
    } catch (e) {
      console.error(`[${hhmmss()}] ⚠ 這一輪整個失敗：`, e instanceof Error ? e.message : e);
    }

    if (ONCE) break;
    // 做完才排下一輪 —— 一輪超過 interval 時不重疊，直接接著跑
    const wait = Math.max(0, INTERVAL_MS - (Date.now() - startedAt));
    await new Promise<void>((resolve) => {
      const id = setTimeout(resolve, wait);
      // Ctrl-C 的時候不用等滿 interval
      const poll = setInterval(() => {
        if (stop) {
          clearTimeout(id);
          clearInterval(poll);
          resolve();
        }
      }, 200);
      setTimeout(() => clearInterval(poll), wait + 250);
    });
  }

  console.log(`[${hhmmss()}] worker 已停止。`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
