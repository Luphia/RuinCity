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

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import {
  checkBuild,
  freeTerritoryQueue,
  planCoreBuild,
  planCoreConstruct,
  planDemolish,
  planFacility,
  type CoreSlot,
} from "@/lib/game/build";
import { territoryCapacity } from "@/lib/game/formulas";
import { ISOLATION_GRACE_MS, planClaim, recomputeIsolation } from "@/lib/game/territory";
import { serverNow } from "@/lib/time";
import { scheduleEvent, settleWithin, spendAmounts } from "@/lib/server/player-state";
import { loadTerrainAround, terrainDirFor } from "@/lib/server/terrain";
import { buildTerritoryBoard, type TerritoryBoard } from "@/lib/server/territory-board";

export interface ActionResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly doneAt?: number;
}

/**
 * 目前登入者在**本賽季**的玩家 ID。
 *
 * ★ 要跳兩層：Auth.js 的身分（`auth_users`，text id）與遊戲的帳號
 *   （`users`，bigserial）是分開的兩張表，**以 email 對應**
 *   —— Auth.js 管身分，`users` 管跨賽季的傳承與頭銜（見 `auth-schema.ts`）。
 */
async function currentPlayerId(): Promise<number> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error("UNAUTHENTICATED");

  const { getDb } = await import("@/lib/db");
  const [row] = await getDb()
    .select({ playerId: schema.players.id })
    .from(schema.players)
    .innerJoin(schema.users, eq(schema.players.userId, schema.users.id))
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(and(eq(schema.users.email, email), eq(schema.seasons.status, "RUNNING")))
    .limit(1);

  if (!row) throw new Error("NO_PLAYER");
  return row.playerId;
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

/** 佔領一塊領土 */
export async function claimTile(x: number, y: number): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId);

    /**
     * ★ 同時拓荒上限 = 領土佇列數（`docs/10` M2）。
     *   少了這一檢查，玩家可以一次下二十張拓荒單 ——
     *   「拓荒要排隊」這件事就完全失效了。
     */
    const queueIndex = freeTerritoryQueue(state.build, now);
    if (queueIndex < 0) return { ok: false, reason: "NO_FREE_QUEUE" };

    // 地形決定拓荒耗時與之後的設施產出，一律從地圖靜態檔查，不信任呼叫端
    const terrainMap = await loadTerrainAround(terrainDirFor(state.seasonId), [{ x, y }]);
    if (!terrainMap.loaded) return { ok: false, reason: "TERRAIN_UNAVAILABLE" };

    const occupied = await tx
      .select({ playerId: schema.tiles.playerId })
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, state.seasonId), eq(schema.tiles.x, x), eq(schema.tiles.y, y)))
      .limit(1);

    const plan = planClaim(
      {
        baseX: state.baseX,
        baseY: state.baseY,
        owned: state.tiles,
        territoryCapacity: territoryCapacity(state.build.citadel),
        terrainAt: terrainMap.at,
        isBlocked: () => occupied[0]?.playerId != null && occupied[0].playerId !== playerId,
      },
      x,
      y,
    );
    if ("reason" in plan) return { ok: false, reason: plan.reason };

    const r = state.economy.resources;
    if (r.grain < plan.cost.grain || r.timber < plan.cost.timber) {
      return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
    }

    // 拓荒隊要帶民兵出去，人口不夠就派不出去（`docs/02` §2.2 的第二重遞增）
    const freePop = state.economy.population.cap - state.economy.population.used;
    if (freePop < plan.militia) return { ok: false, reason: "INSUFFICIENT_POPULATION" };

    await tx
      .update(schema.playerResources)
      .set({
        grain: String(r.grain - plan.cost.grain),
        timber: String(r.timber - plan.cost.timber),
      })
      .where(eq(schema.playerResources.playerId, playerId));

    const doneAt = now + plan.seconds * 1000;
    await scheduleEvent(tx, {
      seasonId: state.seasonId,
      type: "CLAIM_DONE",
      actorId: playerId,
      payload: {
        kind: "CLAIM",
        x,
        y,
        militia: plan.militia,
        terrain: terrainMap.at(x, y),
        queueIndex,
      },
      resolveAt: doneAt,
    });

    revalidatePath("/base");
    return { ok: true, doneAt };
  });
}

/** 在自己的領土格上蓋／升設施 */
export async function buildFacility(
  x: number,
  y: number,
  facility: string,
): Promise<ActionResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId);
    const tile = state.tiles.find((t) => t.x === x && t.y === y);
    if (!tile) return { ok: false, reason: "NOT_OWNED" };

    /**
     * 一格上只能有一種設施 —— 想換種類要先放棄這塊地再重拓。
     * 少了這一檢查，「農田升級」可以在最後一刻變成「哨塔升級」，
     * 而成本是照農田算的。
     */
    if (tile.facility && tile.facility !== facility) {
      return { ok: false, reason: "FACILITY_MISMATCH" };
    }

    // 集市每位玩家上限 1 座（`docs/02` §3）
    if (
      facility === "MARKET" &&
      !tile.facility &&
      state.tiles.some((t) => t.facility === "MARKET")
    ) {
      return { ok: false, reason: "MARKET_LIMIT" };
    }

    const plan = planFacility(state.build, facility, tile.facilityLevel, now);
    if ("reason" in plan) return { ok: false, reason: plan.reason };

    const check = checkBuild(state.build, state.economy.resources, state.economy.capacity, {
      target: "CITADEL",
      building: null,
      fromLevel: plan.fromLevel,
      toLevel: plan.toLevel,
      cost: plan.cost,
      seconds: plan.seconds,
    });
    if (!check.ok) return { ok: false, reason: check.reason };

    const next = spendAmounts(state.economy.resources, plan.cost);
    await tx
      .update(schema.playerResources)
      .set({
        grain: String(next.grain),
        timber: String(next.timber),
        stone: String(next.stone),
        iron: String(next.iron),
      })
      .where(eq(schema.playerResources.playerId, playerId));

    const doneAt = now + plan.seconds * 1000;
    await scheduleEvent(tx, {
      seasonId: state.seasonId,
      type: "BUILD_DONE",
      actorId: playerId,
      payload: {
        kind: "FACILITY",
        x,
        y,
        facility,
        toLevel: plan.toLevel,
        queueIndex: plan.queueIndex,
      },
      resolveAt: doneAt,
    });

    revalidatePath("/base");
    return { ok: true, doneAt };
  });
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
