import "server-only";

/**
 * 派兵與召回的**共用核心**。
 *
 * ★ 與 `base-ops.ts` 同一個結構：身分解析在 Server Action，
 *   規則驗證在這裡。AI 玩家與遺跡軍團之後也走這條路
 *   —— 執政官**不會**，軍事是 `docs/18` §2 明列的禁區。
 */

import { and, eq } from "drizzle-orm";

import { SEASON_MODIFIERS, type Terrain } from "@/lib/game/balance";
import { isEmptyArmy, mergeArmies, parseArmy, type Army } from "@/lib/game/army";
import { planDispatch, type DispatchType } from "@/lib/game/dispatch";
import { sampleTerrainFactor } from "@/lib/game/march";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { settleWithin } from "@/lib/server/player-state";
import { loadTerrainAround, terrainDirFor } from "@/lib/server/terrain";

export interface MarchResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly marchId?: number;
  readonly arrivesAt?: number;
}

/**
 * 沿起訖直線取樣地形，算出平均行軍係數。
 *
 * ★ 取樣點最多 64 個（`march.ts`）。整條路徑逐格讀在 500×500 的地圖上
 *   最多是 700 格，而取樣 64 格的誤差對行軍時間的影響小於一分鐘 ——
 *   不值得為此讀十倍的 chunk。
 */
async function terrainFactorBetween(
  seasonId: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<number> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.min(64, Math.max(1, Math.ceil(Math.hypot(dx, dy))));

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    points.push({
      x: Math.round(from.x + (dx * i) / steps),
      y: Math.round(from.y + (dy * i) / steps),
    });
  }

  const map = await loadTerrainAround(terrainDirFor(seasonId), points);
  if (!map.loaded) return 1;
  return sampleTerrainFactor(from, to, (x, y) => map.at(x, y) as Terrain);
}

/** 讀出某位玩家在某一格的駐軍 */
async function garrisonAt(
  tx: TxDb,
  seasonId: number,
  ownerId: number,
  x: number,
  y: number,
): Promise<Army> {
  const [row] = await tx
    .select()
    .from(schema.garrisons)
    .where(
      and(
        eq(schema.garrisons.seasonId, seasonId),
        eq(schema.garrisons.ownerId, ownerId),
        eq(schema.garrisons.atX, x),
        eq(schema.garrisons.atY, y),
      ),
    )
    .for("update");
  return parseArmy(row?.units);
}

async function writeGarrison(
  tx: TxDb,
  seasonId: number,
  ownerId: number,
  hostId: number | null,
  x: number,
  y: number,
  units: Army,
) {
  if (isEmptyArmy(units)) {
    await tx
      .delete(schema.garrisons)
      .where(
        and(
          eq(schema.garrisons.seasonId, seasonId),
          eq(schema.garrisons.ownerId, ownerId),
          eq(schema.garrisons.atX, x),
          eq(schema.garrisons.atY, y),
        ),
      );
    return;
  }

  await tx
    .insert(schema.garrisons)
    .values({ seasonId, ownerId, hostId, atX: x, atY: y, units: units as never })
    .onConflictDoUpdate({
      target: [
        schema.garrisons.seasonId,
        schema.garrisons.ownerId,
        schema.garrisons.atX,
        schema.garrisons.atY,
      ],
      set: { units: units as never, hostId },
    });
}

export { garrisonAt, writeGarrison };

/**
 * 派兵。
 *
 * ★ 部隊在出發那一刻就離開駐軍。「軍隊在路上就不能防守」是這個遊戲
 *   所有攻防取捨的基礎 —— 你派出去打人的那支部隊，同時也是你家的守軍。
 */
export async function sendMarchFor(
  tx: TxDb,
  playerId: number,
  input: {
    type: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    army: Army;
    targetSlot?: string | null;
  },
  now: number,
): Promise<MarchResult> {
  const state = await settleWithin(tx, playerId, now);
  const from = { x: input.fromX, y: input.fromY };
  const to = { x: input.toX, y: input.toY };

  const garrison = await garrisonAt(tx, state.seasonId, playerId, from.x, from.y);
  const terrainFactor = await terrainFactorBetween(state.seasonId, from, to);

  const plan = planDispatch(
    {
      from,
      garrison,
      season: SEASON_MODIFIERS[state.season],
      terrainFactor,
    },
    input.type,
    to,
    input.army,
    now,
  );
  if ("reason" in plan) return { ok: false, reason: plan.reason };

  // 打自己沒有意義，而且會讓結算路徑要處理「攻守是同一人」
  const [targetTile] = await tx
    .select({ playerId: schema.tiles.playerId })
    .from(schema.tiles)
    .where(
      and(
        eq(schema.tiles.seasonId, state.seasonId),
        eq(schema.tiles.x, to.x),
        eq(schema.tiles.y, to.y),
      ),
    )
    .limit(1);
  const [targetBase] = await tx
    .select({ id: schema.players.id })
    .from(schema.players)
    .where(
      and(
        eq(schema.players.seasonId, state.seasonId),
        eq(schema.players.baseX, to.x),
        eq(schema.players.baseY, to.y),
      ),
    )
    .limit(1);

  const defenderId = targetBase?.id ?? targetTile?.playerId ?? null;
  if (
    defenderId === playerId &&
    (plan.type === "RAID" || plan.type === "ATTACK" || plan.type === "SCOUT")
  ) {
    return { ok: false, reason: "SELF_TARGET" };
  }

  await writeGarrison(
    tx,
    state.seasonId,
    playerId,
    playerId,
    from.x,
    from.y,
    plan.remainingGarrison,
  );

  const [row] = await tx
    .insert(schema.marches)
    .values({
      seasonId: state.seasonId,
      ownerId: playerId,
      type: plan.type,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      units: plan.army as never,
      targetSlot: input.targetSlot ?? null,
      departedAt: new Date(now),
      arrivesAt: new Date(plan.arrivesAt),
    })
    .returning({ id: schema.marches.id });

  return { ok: true, marchId: row?.id, arrivesAt: plan.arrivesAt };
}

/**
 * 召回一支還在路上的部隊。
 *
 * ★ 召回**不是瞬間的**：部隊要走回去，而且從召回的那一刻重新算路程。
 *   瞬間召回會讓派兵完全沒有風險 —— 看到守軍太強就按一下取消。
 */
export async function recallMarchFor(
  tx: TxDb,
  playerId: number,
  marchId: number,
  now: number,
): Promise<MarchResult> {
  const [march] = await tx
    .select()
    .from(schema.marches)
    .where(
      and(
        eq(schema.marches.id, marchId),
        eq(schema.marches.ownerId, playerId),
        eq(schema.marches.status, "IN_TRANSIT"),
      ),
    )
    .for("update");
  if (!march) return { ok: false, reason: "NOT_FOUND" };
  if (march.arrivesAt.getTime() <= now) return { ok: false, reason: "ALREADY_ARRIVED" };
  if (march.type === "RETURN") return { ok: false, reason: "ALREADY_RETURNING" };

  const army = parseArmy(march.units);

  /**
   * 已經走了多遠就要走多遠回來。用「已經過的時間」當回程時間是最誠實的
   * 近似 —— 速度沒變，路徑也沒變。
   */
  const elapsed = now - march.departedAt.getTime();
  const arrivesAt = now + Math.max(1000, elapsed);

  await tx
    .update(schema.marches)
    .set({ status: "RECALLED" })
    .where(eq(schema.marches.id, marchId));

  await tx.insert(schema.marches).values({
    seasonId: march.seasonId,
    ownerId: playerId,
    type: "RETURN",
    fromX: march.toX,
    fromY: march.toY,
    toX: march.fromX,
    toY: march.fromY,
    units: army as never,
    departedAt: new Date(now),
    arrivesAt: new Date(arrivesAt),
  });

  return { ok: true, arrivesAt };
}

/** 部隊回到家：併回駐軍，貨物入庫（受儲存上限約束） */
export async function landReturn(
  tx: TxDb,
  march: typeof schema.marches.$inferSelect,
  now: number,
) {
  const state = await settleWithin(tx, march.ownerId, now);
  const army = parseArmy(march.units);

  const existing = await garrisonAt(tx, march.seasonId, march.ownerId, march.toX, march.toY);
  await writeGarrison(
    tx,
    march.seasonId,
    march.ownerId,
    march.ownerId,
    march.toX,
    march.toY,
    mergeArmies(existing, army),
  );

  const cargo = march.cargo as Record<string, number> | null;
  if (cargo) {
    const next: Record<string, string> = {};
    for (const r of ["grain", "timber", "stone", "iron"] as const) {
      const gained = typeof cargo[r] === "number" ? cargo[r] : 0;
      // 搶回來的東西一樣受倉庫上限約束 —— 沒地方放就是灑在路上
      next[r] = String(Math.min(state.economy.capacity, state.economy.resources[r] + gained));
    }
    await tx
      .update(schema.playerResources)
      .set(next)
      .where(eq(schema.playerResources.playerId, march.ownerId));
  }

  await tx
    .update(schema.marches)
    .set({ status: "ARRIVED" })
    .where(eq(schema.marches.id, march.id));
}

export type { DispatchType };
