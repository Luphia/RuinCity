import { NextResponse } from "next/server";
import { and, isNull, lte } from "drizzle-orm";

import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import { settleWithin } from "@/lib/server/player-state";
import { runStewardWithin } from "@/lib/server/steward";
import { serverNow } from "@/lib/time";

/**
 * 結算引擎的軌道 B（Push）：每 60 秒掃描所有到期的事件，
 * 結算並在對應佇列空出來時讓執政官接手。
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
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 一次最多處理幾位玩家。超過的留給下一分鐘 */
const BATCH = 200;

/** 會讓佇列空出來、因此值得叫執政官的事件 */
const QUEUE_FREEING = ["CLAIM_DONE", "BUILD_DONE", "TRAIN_DONE", "STEWARD_TICK"] as const;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = await serverNow();

  let due: { actorId: number | null; type: string }[] = [];
  try {
    const { getDb } = await import("@/lib/db");
    due = await getDb()
      .select({ actorId: schema.events.actorId, type: schema.events.type })
      .from(schema.events)
      .where(and(isNull(schema.events.resolvedAt), lte(schema.events.resolveAt, new Date(now))))
      .orderBy(schema.events.resolveAt, schema.events.seq, schema.events.id)
      .limit(BATCH * 4);
  } catch (e) {
    // 沒有資料庫的環境（E2E、預覽）不該讓這條路由 500
    return NextResponse.json({
      ok: true,
      settled: 0,
      note: e instanceof Error ? e.message : String(e),
      serverTime: new Date(now).toISOString(),
    });
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
      await withTransaction(async (tx) => {
        if (callSteward) {
          const r = await runStewardWithin(tx, playerId, now);
          if (r.ran) stewardRuns++;
        } else {
          await settleWithin(tx, playerId);
        }
      });
      settled++;
    } catch {
      // 一位玩家結算失敗不能拖垮整批。事件仍未結算，下一分鐘會再試
      failures++;
    }
  }

  return NextResponse.json({
    ok: true,
    settled,
    stewardRuns,
    failures,
    pending: Math.max(0, actors.size - BATCH),
    serverTime: new Date(now).toISOString(),
  });
}
