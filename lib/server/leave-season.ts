import "server-only";

/**
 * 離開賽季：一位領主的這一場結束了。
 *
 * 兩條路走進來，**後果完全相同**：
 *
 *   - `KEEP_DESTROYED` —— 主城被打爆（`docs/02` §3.1）
 *   - `ABANDONED` —— 自己放棄（`docs/13` §8）
 *
 * ★ 所以只能有一份實作。兩份遲早分岔，而分岔的症狀是
 *   「有一種離開方式會在地圖上留下一個已經不存在的人還在運作的東西」——
 *   那正是這個函式存在的全部理由。
 */

import { and, eq, isNull } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";

export type ExitReason = "KEEP_DESTROYED" | "ABANDONED";

/**
 * 做五件事，順序不重要但一件都不能少：
 *
 *   1. `players.eliminatedAt` + `exitReason` —— 離開的判準只有這一個欄位
 *   2. 領地全部釋放成無主（旗倒了，地就回到廢土）
 *   3. 駐軍清空
 *   4. 在途的行軍全部取消（沒有人可以回去了）
 *   5. **未結算事件刪除** —— 不刪的話結算迴圈每分鐘撿起來、
 *      撞 `PlayerEliminatedError`、記一筆看不出原因的 failure，
 *      而那些事件永遠不會消失
 *
 * 冪等：已經離開的人再呼叫一次是 no-op（同一波兩支部隊同時破城）。
 */
export async function leaveSeason(
  tx: TxDb,
  seasonId: number,
  playerId: number,
  now: number,
  reason: ExitReason,
): Promise<boolean> {
  const [already] = await tx
    .select({ eliminatedAt: schema.players.eliminatedAt })
    .from(schema.players)
    .where(eq(schema.players.id, playerId))
    .limit(1);
  if (already?.eliminatedAt) return false;

  await tx
    .update(schema.players)
    .set({ eliminatedAt: new Date(now), exitReason: reason })
    .where(eq(schema.players.id, playerId));

  // 領地回到無主 —— 設施也跟著消失（沒有人維護它們了）
  await tx
    .update(schema.tiles)
    .set({
      playerId: null,
      allianceId: null,
      facility: null,
      facilityLevel: 0,
      structureHp: null,
      structureHitAt: null,
      state: "NORMAL",
      stateUntil: null,
    })
    .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.playerId, playerId)));

  await tx
    .delete(schema.garrisons)
    .where(and(eq(schema.garrisons.seasonId, seasonId), eq(schema.garrisons.ownerId, playerId)));

  await tx
    .update(schema.marches)
    .set({ status: "RECALLED" })
    .where(
      and(
        eq(schema.marches.seasonId, seasonId),
        eq(schema.marches.ownerId, playerId),
        eq(schema.marches.status, "IN_TRANSIT"),
      ),
    );

  await tx
    .delete(schema.events)
    .where(
      and(
        eq(schema.events.seasonId, seasonId),
        eq(schema.events.actorId, playerId),
        isNull(schema.events.resolvedAt),
      ),
    );

  return true;
}
