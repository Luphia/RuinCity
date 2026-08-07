import "server-only";

/**
 * 據點操作的**共用核心**。
 *
 * ## ★ 為什麼要把這一層從 Server Action 抽出來
 *
 * `docs/18` §11.2 要求執政官「走與玩家完全相同的驗證路徑，不開後門」。
 * 而 Server Action 的第一件事是從 session 解出「我是誰」——
 * 執政官沒有 session。
 *
 * 所以把 **身分解析** 與 **規則驗證** 切開：
 *
 * ```
 * Server Action ── auth() → playerId ──┐
 *                                      ├──→ 這裡（唯一的驗證路徑）
 * 執政官        ── 明確傳入 playerId ──┘
 * ```
 *
 * 執政官因此不可能作弊 —— 它連一條可以繞過的路都沒有，
 * 而且會成為規則系統的壓力測試（`18` §11.2）。
 * AI 玩家（`15` §7.1）與遺跡軍團（`17` §6）之後也接在這裡。
 */

import { and, eq } from "drizzle-orm";

import { SEASON_MODIFIERS } from "@/lib/game/balance";
import { checkBuild, freeTerritoryQueue, planFacility } from "@/lib/game/build";
import { checkTrain, planTrain } from "@/lib/game/train";
import { territoryCapacity } from "@/lib/game/formulas";
import { planClaim } from "@/lib/game/territory";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { scheduleEvent, settleWithin, spendAmounts } from "@/lib/server/player-state";
import { loadTerrainAround, terrainDirFor } from "@/lib/server/terrain";

export interface OpResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly doneAt?: number;
}

/**
 * 佔領一塊領土。
 *
 * ★ 同時拓荒上限 = 領土佇列數（`docs/10` M2）。
 *   少了這一檢查，玩家可以一次下二十張拓荒單 ——
 *   「拓荒要排隊」這件事就完全失效了。
 */
export async function claimTileFor(
  tx: TxDb,
  playerId: number,
  x: number,
  y: number,
  now: number,
): Promise<OpResult> {
  const state = await settleWithin(tx, playerId, now);

  const queueIndex = freeTerritoryQueue(state.build, now);
  if (queueIndex < 0) return { ok: false, reason: "NO_FREE_QUEUE" };

  // 地形決定拓荒耗時與之後的設施產出，一律從地圖靜態檔查，不信任呼叫端
  const terrainMap = await loadTerrainAround(terrainDirFor(state.seasonId), [{ x, y }]);
  if (!terrainMap.loaded) return { ok: false, reason: "TERRAIN_UNAVAILABLE" };

  const occupied = await tx
    .select({ playerId: schema.tiles.playerId })
    .from(schema.tiles)
    .where(
      and(eq(schema.tiles.seasonId, state.seasonId), eq(schema.tiles.x, x), eq(schema.tiles.y, y)),
    )
    .limit(1);

  const plan = planClaim(
    {
      baseX: state.baseX,
      baseY: state.baseY,
      owned: state.tiles,
      territoryCapacity: territoryCapacity(state.build.citadel, state.bandBonus),
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

  /**
   * 拓荒隊要帶民兵出去，人口不夠就派不出去（`docs/02` §2.2 的第二重遞增）。
   *
   * ★ 人口在**這裡**就扣掉，不是等到立旗完成 —— 拓荒隊出發那一刻人就走了。
   *   等到完成才扣的話，四條佇列可以各自下滿，總和超過人口上限。
   *   召回時退還（`recallClaim`）。
   */
  const freePop = state.economy.population.cap - state.economy.population.used;
  if (freePop < plan.militia) return { ok: false, reason: "INSUFFICIENT_POPULATION" };

  await tx
    .update(schema.playerPopulation)
    .set({ used: String(state.economy.population.used + plan.militia) })
    .where(eq(schema.playerPopulation.playerId, playerId));

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

  return { ok: true, doneAt };
}

/**
 * 招募。
 *
 * ★ 人口在**這裡**就被扣掉，不是等到 `TRAIN_DONE`。
 *   三條佇列各自下滿的話，總和會遠超過人口上限 ——
 *   等到完成才發現超了，就只能在「憑空多出人口」與「白花資源」
 *   之間二選一。先扣起來，取消時再退。
 *
 * 行軍與戰鬥是 M3；這裡招出來的兵直接進本營駐軍。
 */
export async function trainUnitsFor(
  tx: TxDb,
  playerId: number,
  unit: string,
  count: number,
  now: number,
): Promise<OpResult> {
  const state = await settleWithin(tx, playerId, now);

  const plan = planTrain(state.train, unit, count, now, {
    trainingModifier: SEASON_MODIFIERS[state.season].training,
  });
  if ("reason" in plan) return { ok: false, reason: plan.reason };

  const freePop = state.economy.population.cap - state.economy.population.used;
  const check = checkTrain(plan, state.economy.resources, state.economy.capacity, freePop);
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

  await tx
    .update(schema.playerPopulation)
    .set({ used: String(state.economy.population.used + plan.population) })
    .where(eq(schema.playerPopulation.playerId, playerId));

  const doneAt = now + plan.seconds * 1000;
  await scheduleEvent(tx, {
    seasonId: state.seasonId,
    type: "TRAIN_DONE",
    actorId: playerId,
    payload: { kind: "TRAIN", unit: plan.unit, count: plan.count, producer: plan.producer },
    resolveAt: doneAt,
  });

  return { ok: true, doneAt };
}

/** 在自己的領土格上蓋／升設施 */
export async function buildFacilityFor(
  tx: TxDb,
  playerId: number,
  x: number,
  y: number,
  facility: string,
  now: number,
): Promise<OpResult> {
  const state = await settleWithin(tx, playerId, now);
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
  if (facility === "MARKET" && !tile.facility && state.tiles.some((t) => t.facility === "MARKET")) {
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

  return { ok: true, doneAt };
}
