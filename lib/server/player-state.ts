import "server-only";

/**
 * 玩家狀態的讀寫：資料庫 ↔ 純函式引擎之間的轉接層。
 *
 * ★ 這一層是**唯一**碰資料庫的地方。`/lib/game` 底下不得有任何 I/O
 *   （CLAUDE.md 的第一條界線），所以所有的規則判斷都在那邊做完，
 *   這裡只負責搬資料與確保交易的原子性。
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { SEASON_MODIFIERS, type Facility, type Season, type Terrain } from "@/lib/game/balance";
import { seasonModifiersAt } from "@/lib/game/calendar";
import { deriveRates, outpostUpkeep, type TileWithFacility } from "@/lib/game/economy-state";
import {
  createEventApplier,
  depotLevelOf,
  deriveQueues,
  type WorldState,
} from "@/lib/game/events";
import { territoryQueues } from "@/lib/game/formulas";
import {
  settlePlayer,
  zeroAmounts,
  type Amounts,
  type PlayerEconomy,
  type ScheduledEvent,
} from "@/lib/game/settle";
import { recomputeIsolation } from "@/lib/game/territory";
import { serverNow } from "@/lib/time";
import { schema } from "@/lib/db";
import { withTransaction, type TxDb } from "@/lib/db/tx";
import type { CoreSlot } from "@/lib/game/build";
import type { BuildState } from "@/lib/game/build";

export interface LoadedPlayer {
  readonly playerId: number;
  readonly seasonId: number;
  readonly seasonStartedAt: number;
  readonly baseX: number;
  readonly baseY: number;
  /** 上次登入。執政官用它判斷是否進入全權代理（`docs/18` §8） */
  readonly lastSeenAt: number | null;
  readonly economy: PlayerEconomy;
  readonly build: BuildState;
  readonly tiles: readonly TileWithFacility[];
  readonly season: Season;
}

const num = (v: string | number | null | undefined) => Number(v ?? 0);

function amountsFrom(row: {
  grain: string;
  timber: string;
  stone: string;
  iron: string;
}): Amounts {
  return {
    grain: num(row.grain),
    timber: num(row.timber),
    stone: num(row.stone),
    iron: num(row.iron),
  };
}

/**
 * 讀取 + 結算 + 寫回，**全部在同一個交易裡**。
 *
 * 併發的兩個請求如果各自讀到舊狀態、各自扣一次錢，就是經典的 double-spend。
 * `SELECT ... FOR UPDATE`（Drizzle 的 `.for("update")`）把同一位玩家的
 * 併發請求排成一列。
 */
export async function loadAndSettle(playerId: number): Promise<LoadedPlayer> {
  return withTransaction(async (tx) => settleWithin(tx, playerId));
}

export async function settleWithin(tx: TxDb, playerId: number): Promise<LoadedPlayer> {
  const now = await serverNow();

  const [player] = await tx
    .select()
    .from(schema.players)
    .where(eq(schema.players.id, playerId))
    .for("update");
  if (!player) throw new Error(`player ${playerId} not found`);

  const [season] = await tx
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.id, player.seasonId));
  if (!season?.startedAt) throw new Error(`season ${player.seasonId} has not started`);
  const seasonStartedAt = season.startedAt.getTime();

  const [resources] = await tx
    .select()
    .from(schema.playerResources)
    .where(eq(schema.playerResources.playerId, playerId))
    .for("update");
  const [population] = await tx
    .select()
    .from(schema.playerPopulation)
    .where(eq(schema.playerPopulation.playerId, playerId))
    .for("update");
  if (!resources || !population) throw new Error(`player ${playerId} has no economy rows`);

  const slots = await tx
    .select()
    .from(schema.baseSlots)
    .where(eq(schema.baseSlots.playerId, playerId));

  const tileRows = await tx
    .select()
    .from(schema.tiles)
    .where(and(eq(schema.tiles.seasonId, player.seasonId), eq(schema.tiles.playerId, playerId)));

  /**
   * ★ 撈**所有**未結算的事件，不只是已到期的。
   *   未到期的那些就是「佇列上正在蓋的東西」——
   *   佇列不另存一張表，它是事件表的一個 view（見 `events.ts` §佇列狀態）。
   */
  const pending = await tx
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.actorId, playerId), isNull(schema.events.resolvedAt)));

  // ── 組出純函式要的形狀 ────────────────────────────────────
  const tiles: TileWithFacility[] = tileRows
    .filter((t) => t.kind === "TERRITORY")
    .map((t) => ({
      x: t.x,
      y: t.y,
      state: t.state as TileWithFacility["state"],
      facility: (t.facility as Facility | null) ?? null,
      facilityLevel: t.facilityLevel,
      terrain: t.terrain as Terrain,
    }));

  const world0: WorldState = {
    citadel: player.citadelLevel,
    slots: { B: slotOf(slots, "B"), C: slotOf(slots, "C"), D: slotOf(slots, "D") },
    tiles,
    lastDemolishAt: null,
  };

  const derived = deriveRates({
    citadel: world0.citadel,
    depotLevel: depotLevelOf(world0.slots),
    tiles,
  });

  const economy: PlayerEconomy = {
    resources: amountsFrom(resources),
    baseRates: derived.baseRates,
    baseUpkeep: outpostUpkeep(derived.outpostLevels),
    capacity: derived.capacity,
    population: {
      amount: num(population.amount),
      rate: derived.populationRate,
      cap: derived.populationCap,
      used: num(population.used),
    },
    settledAt: resources.settledAt.getTime(),
  };

  const events: ScheduledEvent[] = pending.map((e) => ({
    id: e.id,
    type: e.type,
    resolveAt: e.resolveAt.getTime(),
    seq: e.seq,
    payload: e.payload,
  }));

  const applier = createEventApplier(world0);
  const result = settlePlayer(economy, events, now, {
    seasonStartedAt,
    modifiersOf: (s) => ({
      production: SEASON_MODIFIERS[s].production,
      upkeep: SEASON_MODIFIERS[s].upkeep,
    }),
    apply: applier.apply,
  });
  const world = applier.world();

  // 事件套完之後的速率 —— 寫回資料庫的是**這一組**，不是結算前的
  const finalRates = deriveRates({
    citadel: world.citadel,
    depotLevel: depotLevelOf(world.slots),
    tiles: world.tiles,
  });

  // ── 寫回結構狀態 ──────────────────────────────────────────
  if (world.citadel !== world0.citadel) {
    await tx
      .update(schema.players)
      .set({ citadelLevel: world.citadel, settledAt: new Date(now) })
      .where(eq(schema.players.id, playerId));
  }

  for (const s of ["B", "C", "D"] as const) {
    const before = world0.slots[s];
    const after = world.slots[s];
    if (before.building === after.building && before.level === after.level) continue;
    await tx
      .insert(schema.baseSlots)
      .values({ playerId, slot: s, building: after.building, level: after.level })
      .onConflictDoUpdate({
        target: [schema.baseSlots.playerId, schema.baseSlots.slot],
        set: { building: after.building, level: after.level },
      });
  }

  await writeTiles(tx, player.seasonId, playerId, player.allianceId, world0.tiles, world.tiles);

  // ── 寫回經濟 ──────────────────────────────────────────────
  await tx
    .update(schema.playerResources)
    .set({
      grain: String(result.economy.resources.grain),
      timber: String(result.economy.resources.timber),
      stone: String(result.economy.resources.stone),
      iron: String(result.economy.resources.iron),
      grainRate: String(finalRates.baseRates.grain),
      timberRate: String(finalRates.baseRates.timber),
      stoneRate: String(finalRates.baseRates.stone),
      ironRate: String(finalRates.baseRates.iron),
      capacity: String(finalRates.capacity),
      settledAt: new Date(now),
    })
    .where(eq(schema.playerResources.playerId, playerId));

  await tx
    .update(schema.playerPopulation)
    .set({
      amount: String(result.economy.population.amount),
      rate: String(finalRates.populationRate),
      cap: String(finalRates.populationCap),
      used: String(result.economy.population.used),
      settledAt: new Date(now),
    })
    .where(eq(schema.playerPopulation.playerId, playerId));

  if (result.resolved.length > 0) {
    await tx
      .update(schema.events)
      .set({ resolvedAt: new Date(now) })
      .where(
        sql`${schema.events.id} in (${sql.join(
          result.resolved.map((e) => sql`${e.id}`),
          sql`, `,
        )})`,
      );
  }

  // 佇列由**還沒結算掉**的事件決定
  const resolvedIds = new Set(result.resolved.map((e) => e.id));
  const queues = deriveQueues(
    events.filter((e) => !resolvedIds.has(e.id)),
    now,
    territoryQueues(world.citadel),
  );

  const buildState: BuildState = {
    citadel: world.citadel,
    slots: world.slots,
    coreQueue: queues.coreQueue,
    territoryQueue: queues.territoryQueue,
    lastDemolishAt: queues.lastDemolishAt,
  };

  return {
    playerId,
    seasonId: player.seasonId,
    seasonStartedAt,
    baseX: player.baseX,
    baseY: player.baseY,
    lastSeenAt: player.lastSeenAt?.getTime() ?? null,
    economy: result.economy,
    build: buildState,
    tiles: world.tiles,
    season: seasonOf(seasonStartedAt, now),
  };
}

/**
 * 把結構狀態的領土差異寫回 `tiles`。
 *
 * ★ 只寫**變動的**格。一位玩家可能有幾十塊地，
 *   每次讀取據點都全量 upsert 一次是白花交易時間。
 */
async function writeTiles(
  tx: TxDb,
  seasonId: number,
  playerId: number,
  allianceId: number | null,
  before: readonly TileWithFacility[],
  after: readonly TileWithFacility[],
) {
  const key = (t: { x: number; y: number }) => `${t.x},${t.y}`;
  const beforeMap = new Map(before.map((t) => [key(t), t]));
  const afterMap = new Map(after.map((t) => [key(t), t]));

  for (const t of after) {
    const prev = beforeMap.get(key(t));
    if (
      prev &&
      prev.facility === t.facility &&
      prev.facilityLevel === t.facilityLevel &&
      prev.state === t.state
    ) {
      continue;
    }
    await tx
      .insert(schema.tiles)
      .values({
        seasonId,
        x: t.x,
        y: t.y,
        kind: "TERRITORY",
        playerId,
        allianceId,
        facility: t.facility,
        facilityLevel: t.facilityLevel,
        terrain: t.terrain,
        state: t.state,
      })
      .onConflictDoUpdate({
        target: [schema.tiles.seasonId, schema.tiles.x, schema.tiles.y],
        set: {
          playerId,
          allianceId,
          facility: t.facility,
          facilityLevel: t.facilityLevel,
          terrain: t.terrain,
          state: t.state,
        },
      });
  }

  // 放棄掉的（ISOLATION_EXPIRE）—— 歸還為無主地
  for (const t of before) {
    if (afterMap.has(key(t))) continue;
    await tx
      .update(schema.tiles)
      .set({
        playerId: null,
        allianceId: null,
        facility: null,
        facilityLevel: 0,
        state: "NORMAL",
        stateUntil: null,
      })
      .where(
        and(
          eq(schema.tiles.seasonId, seasonId),
          eq(schema.tiles.x, t.x),
          eq(schema.tiles.y, t.y),
        ),
      );
  }
}

function slotOf(
  rows: { slot: string; building: string | null; level: number }[],
  slot: CoreSlot,
) {
  const row = rows.find((r) => r.slot === slot);
  return {
    building: (row?.building ?? null) as BuildState["slots"]["B"]["building"],
    level: row?.level ?? 0,
  };
}

function seasonOf(startedAt: number, now: number): Season {
  const mods = seasonModifiersAt(startedAt, now);
  for (const s of ["SPRING", "SUMMER", "AUTUMN", "WINTER"] as const) {
    if (SEASON_MODIFIERS[s] === mods) return s;
  }
  return "SPRING";
}

/** 排一個事件。所有的非即時動作都走這裡 */
export async function scheduleEvent(
  tx: TxDb,
  input: {
    seasonId: number;
    type: (typeof schema.eventTypeEnum.enumValues)[number];
    actorId: number;
    payload: unknown;
    resolveAt: number;
    seq?: number;
  },
) {
  await tx.insert(schema.events).values({
    seasonId: input.seasonId,
    type: input.type,
    actorId: input.actorId,
    payload: input.payload as never,
    resolveAt: new Date(input.resolveAt),
    seq: input.seq ?? 0,
  });
}

export function spendAmounts(current: Amounts, cost: Amounts): Amounts {
  const out = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    out[r] = current[r] - cost[r];
  }
  return out;
}

export { recomputeIsolation };
