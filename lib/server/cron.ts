/**
 * 結算引擎的軌道 B（Push）：一輪「tick」掃描所有到期的事情。
 *
 * ★ 這是**唯一**的一份 tick 邏輯，兩個入口共用：
 *   - `/api/cron/settle`（production：Vercel Cron 每分鐘打一次）
 *   - `scripts/worker.ts`（本機/自架：`pnpm worker` 的常駐迴圈）
 *   之前只有路由那一份，於是本機開發時沒有任何東西定期執行 ——
 *   執政官、行軍、賽季推進全部停擺，只有打開頁面那一刻的惰性結算在動。
 *
 * ★ 這保證**離線的玩家也會被結算**。軌道 A（讀取時惰性結算）
 *   只在有人打開頁面時才跑，而一位睡了 8 小時的領主
 *   在那 8 小時裡的佇列不能空轉（`docs/18` §1）。
 *
 * ★ 執政官的觸發點就在這裡，**不在頁面載入時**。
 *   企劃（`18` §11.1）說的是「佇列完成事件後評估 + 每 2h 安全網」，
 *   兩者都是伺服器端的時機。把它接在頁面載入上會出現一個很糟的手感：
 *   領主打開領土畫面正要點一塊 LODE，執政官搶先用掉了那條佇列去拓
 *   最近的沼澤 —— 而它做的事完全符合規則。
 */

import { and, eq, isNull, lte } from "drizzle-orm";

import { schema } from "@/lib/db";
import { explainDbError } from "@/lib/db/diagnose";
import { withTransaction } from "@/lib/db/tx";
import type { TxDb } from "@/lib/db/tx";
import { PlayerEliminatedError, settleWithin } from "@/lib/server/player-state";
import { resolveArrivals } from "@/lib/server/battle-ops";
import { runStewardWithin } from "@/lib/server/steward";
import { advanceSeasons, ensureNextSeason } from "@/lib/server/season-ops";

/** 一次最多處理幾位玩家。超過的留給下一輪 */
const BATCH = 200;

/** 會讓佇列空出來、因此值得叫執政官的事件 */
const QUEUE_FREEING = ["CLAIM_DONE", "BUILD_DONE", "TRAIN_DONE", "STEWARD_TICK"] as const;

/** 與 production `withTransaction` 同簽章 —— 測試注入 PGlite 的版本 */
export type TxRunner = <T>(fn: (tx: TxDb) => Promise<T>) => Promise<T>;

export interface CronTick {
  readonly seasons: {
    locked: number;
    started: number;
    ended: number;
    created: number | null;
  };
  readonly marches: { resolved: number; battles: number; failures: number };
  readonly settled: number;
  readonly stewardRuns: number;
  readonly failures: number;
  readonly pending: number;
  readonly note: string | null;
  /** 各區段的失敗。路由把它放進 JSON、worker 印在終端機 —— 不准吞掉 */
  readonly errors: string[];
}

export async function runCronTick(now: number, tx: TxRunner = withTransaction): Promise<CronTick> {
  const errors: string[] = [];
  // ★ 走 cause 鏈翻譯（「資料表不存在 → 先跑 pnpm db:migrate」）——
  //   drizzle 最外層的「Failed query」對使用者毫無行動指引
  const msg = explainDbError;

  /**
   * ★ 賽季的階段推進排在最前面，而且**做了粗活就直接回傳**。
   *
   *   封盤要跑地圖生成（實測 7–20 秒）、開賽要寫 600 位玩家，
   *   兩者都遠比一輪結算重。跟結算擠在同一個預算裡的話，
   *   封盤那一分鐘會把所有人的佇列拖住。它們一個賽季各只發生一次，
   *   晚一分鐘結算沒有人看得出來 —— 而封盤跑到一半被砍掉是災難。
   */
  let seasons: CronTick["seasons"] = { locked: 0, started: 0, ended: 0, created: null };
  try {
    const advanced = await tx((t) => advanceSeasons(t, now));
    const created = await tx((t) => ensureNextSeason(t, now));
    seasons = { ...advanced, created };
  } catch (e) {
    errors.push(`seasons: ${msg(e)}`); // 沒有資料庫的環境（E2E、預覽）不該炸掉整輪
  }

  const zero: Omit<CronTick, "seasons" | "note" | "errors"> = {
    marches: { resolved: 0, battles: 0, failures: 0 },
    settled: 0,
    stewardRuns: 0,
    failures: 0,
    pending: 0,
  };

  if (seasons.locked > 0 || seasons.started > 0) {
    return {
      ...zero,
      seasons,
      note: "季度轉換佔用了這一輪，結算留給下一輪",
      errors,
    };
  }

  /**
   * ★ 行軍**先**結算。
   *
   *   戰鬥會改變雙方的駐軍與資源，而執政官的決策要看到最新的狀態 ——
   *   順序反了，一位剛被搶光的玩家會拿著「被搶前」的資源去拓荒。
   */
  const marches = { resolved: 0, battles: 0, failures: 0 };
  try {
    const running = await tx((t) =>
      t.select({ id: schema.seasons.id }).from(schema.seasons).where(eq(schema.seasons.status, "RUNNING")),
    );
    for (const s of running) {
      const r = await tx((t) => resolveArrivals(t, s.id, now));
      marches.resolved += r.resolved;
      marches.battles += r.battles;
      marches.failures += r.failures;
    }
  } catch (e) {
    errors.push(`marches: ${msg(e)}`);
  }

  let due: { actorId: number | null; type: string }[] = [];
  try {
    due = await tx((t) =>
      t
        .select({ actorId: schema.events.actorId, type: schema.events.type })
        .from(schema.events)
        .where(and(isNull(schema.events.resolvedAt), lte(schema.events.resolveAt, new Date(now))))
        .orderBy(schema.events.resolveAt, schema.events.seq, schema.events.id)
        .limit(BATCH * 4),
    );
  } catch (e) {
    errors.push(`events: ${msg(e)}`);
    return { ...zero, marches, seasons, note: null, errors };
  }

  /**
   * 依玩家分組。一位玩家的所有到期事件由一次 `settleWithin` 一起處理 ——
   * 分段積分本來就要看到完整的事件序列，拆開跑會算錯。
   */
  const actors = new Map<number, boolean>();
  for (const e of due) {
    if (e.actorId === null) continue;
    const freeing = (QUEUE_FREEING as readonly string[]).includes(e.type);
    actors.set(e.actorId, (actors.get(e.actorId) ?? false) || freeing);
  }

  let settled = 0;
  let stewardRuns = 0;
  let failures = 0;

  for (const [playerId, callSteward] of [...actors].slice(0, BATCH)) {
    try {
      await tx(async (t) => {
        if (callSteward) {
          const r = await runStewardWithin(t, playerId, now);
          if (r.ran) stewardRuns++;
        } else {
          await settleWithin(t, playerId);
        }
      });
      settled++;
    } catch (e) {
      /**
       * ★ 出局的領主不是失敗，是**沒有事情可做**。
       *   把它算成 failure 的話，cron 會每分鐘記一筆看不出原因的錯 ——
       *   而 `eliminatePlayer` 已經把他的事件清掉了，這裡是防呆。
       */
      if (e instanceof PlayerEliminatedError) continue;
      // 一位玩家結算失敗不能拖垮整批。事件仍未結算，下一輪會再試
      failures++;
    }
  }

  return {
    seasons,
    marches,
    settled,
    stewardRuns,
    failures,
    pending: Math.max(0, actors.size - BATCH),
    note: null,
    errors,
  };
}
