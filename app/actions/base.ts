"use server";

/**
 * 據點的 Server Actions。
 *
 * ★ 三條界線在這裡交會（CLAUDE.md）：
 *   1. 規則判斷全部在 `/lib/game` 的純函式裡做完，這裡只負責搬資料
 *   2. 每一個寫入都在**一個交易**裡（`neon-http` 不支援交易，所以走 WebSocket pool）
 *   3. 時間一律 `serverNow()`，不信任客戶端時鐘
 *
 * AI 玩家、遺跡軍團、執政官都走**同一組**函式，不開後門。
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import {
  checkBuild,
  planCoreBuild,
  planCoreConstruct,
  planDemolish,
  type CoreSlot,
} from "@/lib/game/build";
import { ISOLATION_GRACE_MS, recomputeIsolation } from "@/lib/game/territory";
import { requirePlayerId as currentPlayerId } from "@/lib/server/current-player";
import { serverNow } from "@/lib/time";
import { scheduleEvent, settleWithin, spendAmounts } from "@/lib/server/player-state";
import { buildTerritoryBoard, type TerritoryBoard } from "@/lib/server/territory-board";
import { buildFacilityFor, claimTileFor, trainUnitsFor } from "@/lib/server/base-ops";

export interface ActionResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly doneAt?: number;
}


/** 升級主堡或 B/C/D 的核心建築 */
export async function upgradeCore(target: "CITADEL" | CoreSlot): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId);
    const plan = planCoreBuild(state.build, target, now);
    const check = checkBuild(state.build, state.economy.resources, state.economy.capacity, plan);
    if (!check.ok) return { ok: false, reason: check.reason };

    const next = spendAmounts(state.economy.resources, check.plan.cost);
    await tx
      .update(schema.playerResources)
      .set({
        grain: String(next.grain),
        timber: String(next.timber),
        stone: String(next.stone),
        iron: String(next.iron),
      })
      .where(eq(schema.playerResources.playerId, playerId));

    const doneAt = now + check.plan.seconds * 1000;
    await scheduleEvent(tx, {
      seasonId: state.seasonId,
      type: "BUILD_DONE",
      actorId: playerId,
      payload: {
        kind: "CORE",
        target,
        toLevel: check.plan.toLevel,
        building: check.plan.building,
      },
      resolveAt: doneAt,
    });

    revalidatePath("/base");
    return { ok: true, doneAt };
  });
}

/** 在空的 B/C/D 格上蓋新建築（7 選 3） */
export async function constructCore(slot: CoreSlot, building: string): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId);
    const plan = planCoreConstruct(state.build, slot, building, now);
    const check = checkBuild(state.build, state.economy.resources, state.economy.capacity, plan);
    if (!check.ok) return { ok: false, reason: check.reason };

    const next = spendAmounts(state.economy.resources, check.plan.cost);
    await tx
      .update(schema.playerResources)
      .set({
        grain: String(next.grain),
        timber: String(next.timber),
        stone: String(next.stone),
        iron: String(next.iron),
      })
      .where(eq(schema.playerResources.playerId, playerId));

    const doneAt = now + check.plan.seconds * 1000;
    await scheduleEvent(tx, {
      seasonId: state.seasonId,
      type: "BUILD_DONE",
      actorId: playerId,
      payload: { kind: "CORE", target: slot, building, toLevel: 1 },
      resolveAt: doneAt,
    });

    revalidatePath("/base");
    return { ok: true, doneAt };
  });
}

/** 拆除核心建築：3 小時、退 30%、6 小時冷卻 */
export async function demolishCore(slot: CoreSlot): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId);
    const plan = planDemolish(state.build, slot, now);
    if ("reason" in plan) return { ok: false, reason: plan.reason };

    const doneAt = now + plan.seconds * 1000;
    await scheduleEvent(tx, {
      seasonId: state.seasonId,
      type: "DEMOLISH_DONE",
      actorId: playerId,
      payload: { kind: "DEMOLISH", slot, refund: plan.refund, cooldownUntil: plan.cooldownUntil },
      resolveAt: doneAt,
    });

    revalidatePath("/base");
    return { ok: true, doneAt };
  });
}

/**
 * 佔領一塊領土。
 *
 * ★ 驗證在 `lib/server/base-ops.ts`，執政官走的是**同一個函式**
 *   （`docs/18` §11.2）。這裡只負責「我是誰」。
 */
export async function claimTile(x: number, y: number): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction((tx) => claimTileFor(tx, playerId, x, y, now));
  if (result.ok) {
    revalidatePath("/base");
    revalidatePath("/territory");
  }
  return result;
}

/** 在自己的領土格上蓋／升設施 */
export async function buildFacility(
  x: number,
  y: number,
  facility: string,
): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction((tx) =>
    buildFacilityFor(tx, playerId, x, y, facility, now),
  );
  if (result.ok) {
    revalidatePath("/base");
    revalidatePath("/territory");
  }
  return result;
}

/**
 * 招募。
 *
 * ★ 與拓荒、建設一樣，驗證在 `lib/server/base-ops.ts` ——
 *   執政官的募兵方針走的是**同一個函式**。
 */
export async function trainUnits(unit: string, count: number): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction((tx) => trainUnitsFor(tx, playerId, unit, count, now));
  if (result.ok) revalidatePath("/base");
  return result;
}

/** 領土畫面的資料 */
export async function loadTerritory(): Promise<TerritoryBoard> {
  const playerId = await currentPlayerId();
  const now = await serverNow();
  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId);
    return buildTerritoryBoard(tx, state, now);
  });
}

/** 領土被切斷時重算 ISOLATED —— 由戰鬥結算與 CLAIM_DONE 觸發 */
export async function refreshIsolation(playerId: number) {
  const now = await serverNow();
  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId);
    const update = recomputeIsolation(state.baseX, state.baseY, state.tiles, now);

    for (const t of [...update.newlyIsolated, ...update.reconnected]) {
      await tx
        .update(schema.tiles)
        .set({
          state: t.state,
          stateUntil: t.state === "ISOLATED" ? new Date(update.expireAt) : null,
        })
        .where(
          and(
            eq(schema.tiles.seasonId, state.seasonId),
            eq(schema.tiles.x, t.x),
            eq(schema.tiles.y, t.y),
          ),
        );
    }

    /**
     * ★ 自動放棄要排成**事件**，不能靠讀取時比對 `stateUntil`。
     *   時限到的那一刻玩家可能正離線 —— 而產出必須在那一刻就停，
     *   否則一塊早該放棄的地會一路產到他下次登入。
     *   事件走的是分段積分，時間點是準的。
     */
    for (const t of update.newlyIsolated) {
      await scheduleEvent(tx, {
        seasonId: state.seasonId,
        type: "ISOLATION_EXPIRE",
        actorId: playerId,
        payload: { x: t.x, y: t.y },
        resolveAt: now + ISOLATION_GRACE_MS,
      });
    }

    revalidatePath("/base");
    return { ok: true, isolated: update.newlyIsolated.length };
  });
}
