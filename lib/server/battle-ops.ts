import "server-only";

/**
 * 行軍抵達的結算：戰鬥、掠奪、回程、戰報。
 *
 * ## ★ 為什麼這條路徑不走 per-player 的事件 applier
 *
 * `settleWithin` 一次只鎖一位玩家，而它的 `apply` 簽章是
 * `(economy, event) => economy` —— 那個 economy 只有一個人的。
 *
 * 但戰鬥需要**兩位**玩家的狀態，而且要在同一個交易裡同時改兩邊。
 * 硬塞進 per-player 的 applier，就會出現「攻方結算時守方還沒被結算」
 * 這種必然算錯的狀態。
 *
 * 所以行軍**不進 `events` 表**，由結算迴圈直接掃 `marches`
 * （那張表本來就有 `arrivesAt` 的索引）。少一層轉換，也少一個
 * 「事件被標記已結算但沒人套用」的陷阱。
 */

import { and, asc, eq, gte, lte, sql } from "drizzle-orm";

import { SEASON_MODIFIERS } from "@/lib/game/balance";
import {
  applyCarryLimit,
  carryOf,
  diminishingFactor,
  isEmptyArmy,
  lootableOf,
  mergeArmies,
  parseArmy,
  RAID_WINDOW_MS,
  type Army,
  type Lootable,
} from "@/lib/game/army";
import { resolveBattle, type ResolvedBattle } from "@/lib/game/combat";
import {
  innateDefenseOf,
  planReturn,
  RAID_LOSS_MULTIPLIER,
  reviveSpared,
  scaleLosses,
  scoutReport,
  scoutSuccessChance,
  tileInnateDefense,
  watchtowerDefenseOf,
} from "@/lib/game/dispatch";
import { deriveSeed, mulberry32 } from "@/lib/game/rng";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { settleWithin } from "@/lib/server/player-state";
import { garrisonAt, landReturn, writeGarrison } from "@/lib/server/march-ops";

/** 一次最多結算幾支行軍 */
const BATCH = 100;

export interface ArrivalSummary {
  readonly resolved: number;
  readonly battles: number;
  readonly failures: number;
}

/**
 * 結算所有已抵達的行軍。
 *
 * ★ 依 `arrivesAt` 排序處理。同一格上兩支先後抵達的部隊，
 *   先到的那支要先打完 —— 順序錯了，第二波會跟已經死掉的守軍交戰。
 */
export async function resolveArrivals(
  tx: TxDb,
  seasonId: number,
  now: number,
): Promise<ArrivalSummary> {
  const due = await tx
    .select()
    .from(schema.marches)
    .where(
      and(
        eq(schema.marches.seasonId, seasonId),
        eq(schema.marches.status, "IN_TRANSIT"),
        lte(schema.marches.arrivesAt, new Date(now)),
      ),
    )
    .orderBy(asc(schema.marches.arrivesAt), asc(schema.marches.id))
    .limit(BATCH)
    .for("update");

  let battles = 0;
  let failures = 0;

  for (const march of due) {
    try {
      const fought = await resolveOne(tx, march, now);
      if (fought) battles++;
    } catch {
      // 一支行軍結算失敗不能拖垮整批；它仍是 IN_TRANSIT，下一分鐘再試
      failures++;
    }
  }

  return { resolved: due.length, battles, failures };
}

type MarchRow = typeof schema.marches.$inferSelect;

async function resolveOne(tx: TxDb, march: MarchRow, now: number): Promise<boolean> {
  switch (march.type) {
    case "RETURN":
      await landReturn(tx, march, now);
      return false;
    case "SCOUT":
      await resolveScout(tx, march, now);
      return false;
    case "REINFORCE":
    case "GARRISON":
      await resolveStation(tx, march, now);
      return false;
    case "RAID":
    case "ATTACK":
      return resolveAssault(tx, march, now);
    case "CLAIM":
      return resolveConquest(tx, march, now);
    default:
      // 認不出來的類型就當作原地解散並回家
      await sendHome(tx, march, parseArmy(march.units), null, now);
      return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 征服：打野生守衛，贏了立刻佔領（docs/02 §2.5、docs/11 §22）
// ─────────────────────────────────────────────────────────────

async function resolveConquest(tx: TxDb, march: MarchRow, now: number): Promise<boolean> {
  const army = parseArmy(march.units);
  const state = await settleWithin(tx, march.ownerId, now);

  /**
   * ★ 抵達時**重新驗證**（伺服器是唯一真相）：路上可能被別人搶先、
   *   容量可能被同時完成的立旗吃掉、連通可能被孤立打斷。
   *   驗不過就原地回頭 —— 出發時收的立旗資源不退（docs/11 §22.3）。
   */
  const { claimPlanFor } = await import("@/lib/server/base-ops");
  const check = await claimPlanFor(tx, state, march.toX, march.toY);
  if ("reason" in check) {
    await tx.insert(schema.battleReports).values({
      seasonId: march.seasonId,
      attackerId: march.ownerId,
      defenderId: null,
      atX: march.toX,
      atY: march.toY,
      marchType: "CLAIM",
      outcome: "CLAIM_FAILED",
      snapshot: { kind: "WILD_CLAIM", reason: check.reason, sent: army } as never,
      createdAt: new Date(now),
    });
    await tx.update(schema.marches).set({ status: "ARRIVED" }).where(eq(schema.marches.id, march.id));
    await sendHome(tx, march, army, null, now);
    return false;
  }

  const { wildGuardsFor, wildInnateDefense } = await import("@/lib/game/wilds");
  const distance = Math.max(Math.abs(march.toX - march.fromX), Math.abs(march.toY - march.fromY));
  const guards = wildGuardsFor(check.level, distance);
  const hasGuards = Object.keys(guards).length > 0;

  let outcome: ResolvedBattle["outcome"] = "ATTACKER_WIN";
  let survivors: Army = army;
  let attackerLosses: Army = {};
  let defenderLosses: Army = {};
  let battle: ResolvedBattle | null = null;

  if (hasGuards) {
    /**
     * ★ 與 PvE 營地同一條規則：`skipMorale`（docs/11 §15.1）——
     *   反霸凌的士氣修正不該懲罰打野。巢穴沒有牆，只有固有防禦。
     */
    battle = resolveBattle(
      { army },
      {
        army: guards,
        wallLevel: 0,
        innateDefense: wildInnateDefense(check.level),
        watchtowerDefense: 0,
        infirmaryLevel: 0,
        lootable: {},
      },
      { marchType: "ATTACK", defenderAtHome: false, skipMorale: true },
    );
    outcome = battle.outcome;
    survivors = battle.attackerSurvivors;
    attackerLosses = battle.attackerLosses;
    defenderLosses = battle.defenderLosses;
  }

  if (outcome === "ATTACKER_WIN") {
    // 血已經付過了：立刻佔領，不再立旗倒數
    const [me] = await tx
      .select({ allianceId: schema.players.allianceId })
      .from(schema.players)
      .where(eq(schema.players.id, march.ownerId))
      .limit(1);
    await tx
      .insert(schema.tiles)
      .values({
        seasonId: march.seasonId,
        x: march.toX,
        y: march.toY,
        kind: "TERRITORY",
        playerId: march.ownerId,
        allianceId: me?.allianceId ?? null,
        terrain: check.terrain,
        level: Math.max(1, check.level),
        state: "NORMAL",
      })
      .onConflictDoNothing();
  }

  await tx.insert(schema.battleReports).values({
    seasonId: march.seasonId,
    attackerId: march.ownerId,
    defenderId: null, // 野生守衛不是玩家
    atX: march.toX,
    atY: march.toY,
    marchType: "CLAIM",
    outcome,
    snapshot: {
      kind: "BATTLE",
      wild: { level: check.level, terrain: check.terrain, distance },
      outcome,
      scoring: battle?.scoring ?? null,
      attacker: { sent: army, losses: attackerLosses },
      defender: { present: guards, losses: defenderLosses, wounded: {} },
      loot: {},
      raid: null,
      breakdown: battle?.breakdown ?? null,
    } as never,
    createdAt: new Date(now),
  });

  await tx.update(schema.marches).set({ status: "ARRIVED" }).where(eq(schema.marches.id, march.id));
  const anySurvivor = Object.values(survivors).some((n) => (n ?? 0) > 0);
  if (anySurvivor) await sendHome(tx, march, survivors, null, now);
  return hasGuards;
}

// ─────────────────────────────────────────────────────────────
// 進駐 / 增援
// ─────────────────────────────────────────────────────────────

/**
 * 增援與駐防：部隊留在目標格，**擁有者不變**。
 *
 * ★ 糧食由**派兵的人**付（`settleWithin` 讀的是 `ownerId` 的駐軍），
 *   防禦力算給**站的那一格**。這正是 `docs/04` §2.1 說的
 *   「部隊駐紮在對方據點，計入對方防禦；隨時可召回」。
 */
async function resolveStation(tx: TxDb, march: MarchRow, now: number) {
  const army = parseArmy(march.units);
  const [host] = await tx
    .select({ id: schema.players.id })
    .from(schema.players)
    .where(
      and(
        eq(schema.players.seasonId, march.seasonId),
        eq(schema.players.baseX, march.toX),
        eq(schema.players.baseY, march.toY),
      ),
    )
    .limit(1);

  const existing = await garrisonAt(tx, march.seasonId, march.ownerId, march.toX, march.toY);
  await writeGarrison(
    tx,
    march.seasonId,
    march.ownerId,
    host?.id ?? march.ownerId,
    march.toX,
    march.toY,
    mergeArmies(existing, army),
  );

  await tx
    .update(schema.marches)
    .set({ status: "ARRIVED" })
    .where(eq(schema.marches.id, march.id));
  void now;
}

// ─────────────────────────────────────────────────────────────
// 偵查
// ─────────────────────────────────────────────────────────────

async function resolveScout(tx: TxDb, march: MarchRow, now: number) {
  const scouts = parseArmy(march.units).SCOUT ?? 0;
  const defender = await defenderAt(tx, march.seasonId, march.toX, march.toY, now);

  const defendingScouts = defender ? (defender.garrison.SCOUT ?? 0) : 0;
  const watchtower = defender?.watchtowerLevel ?? 0;

  /**
   * ★ 用 seed 決定成敗，不用 `Math.random()`。
   *   結算必須可重放：同一支行軍重跑一次要得到同一個結果，
   *   否則交易重試就會變成「再擲一次骰子」。
   */
  const roll = mulberry32(deriveSeed(march.id, "scout"))();
  const success = roll < scoutSuccessChance(scouts, defendingScouts, watchtower);

  const report = defender
    ? scoutReport(
        success,
        {
          army: defender.garrison,
          resources: defender.resources,
          citadelLevel: defender.citadelLevel,
          wallLevel: defender.wallLevel,
        },
        (key) => mulberry32(deriveSeed(march.id, `scout:${key}`))(),
      )
    : { success, army: {}, resources: null, citadelLevel: null, wallLevel: null };

  await tx.insert(schema.battleReports).values({
    seasonId: march.seasonId,
    attackerId: march.ownerId,
    defenderId: defender?.playerId ?? null,
    atX: march.toX,
    atY: march.toY,
    marchType: "SCOUT",
    outcome: success ? "SCOUT_SUCCESS" : "SCOUT_FAILED",
    snapshot: { kind: "SCOUT", scouts, report } as never,
    createdAt: new Date(now),
  });

  await tx
    .update(schema.marches)
    .set({ status: "ARRIVED" })
    .where(eq(schema.marches.id, march.id));

  // 失敗 = 偵查兵全滅，沒有回程（`docs/04` §4）
  if (success) await sendHome(tx, march, { SCOUT: scouts }, null, now);
}

// ─────────────────────────────────────────────────────────────
// 突襲 / 攻擊
// ─────────────────────────────────────────────────────────────

async function resolveAssault(tx: TxDb, march: MarchRow, now: number): Promise<boolean> {
  const attackerArmy = parseArmy(march.units);
  const defender = await defenderAt(tx, march.seasonId, march.toX, march.toY, now);

  // 空地：沒人守，直接回家（`ATTACK` 一片荒野不會發生任何事）
  if (!defender) {
    await tx
      .update(schema.marches)
      .set({ status: "ARRIVED" })
      .where(eq(schema.marches.id, march.id));
    await sendHome(tx, march, attackerArmy, null, now);
    return false;
  }

  const attackerState = await settleWithin(tx, march.ownerId, now);
  const season = SEASON_MODIFIERS[attackerState.season];
  const isRaid = march.type === "RAID";

  /**
   * ★ 重複劫掠遞減只算**成功**的那幾次（`docs/03` §4.3）。
   *   把失敗也算進去的話，守方會發現「讓對方打贏一次比較划算」。
   */
  const [{ n: priorRaids } = { n: 0 }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.battleReports)
    .where(
      and(
        eq(schema.battleReports.attackerId, march.ownerId),
        eq(schema.battleReports.defenderId, defender.playerId),
        eq(schema.battleReports.outcome, "ATTACKER_WIN"),
        gte(schema.battleReports.createdAt, new Date(now - RAID_WINDOW_MS)),
      ),
    );

  const lootable: Lootable = lootableOf(
    defender.resources,
    defender.citadelLevel,
    defender.depotLevel,
    season.vault,
  );

  const battle = resolveBattle(
    { army: attackerArmy, siegeBonus: attackerState.build.slots.C.building === "WORKSHOP" ? 0.04 * attackerState.build.slots.C.level : 0 },
    {
      army: defender.garrison,
      wallLevel: defender.wallLevel,
      innateDefense: defender.isBase
        ? innateDefenseOf(defender.citadelLevel)
        : tileInnateDefense(defender.facilityLevel),
      watchtowerDefense: watchtowerDefenseOf(defender.watchtowerLevel),
      infirmaryLevel: defender.infirmaryLevel,
      lootable,
    },
    { marchType: march.type as "RAID" | "ATTACK", defenderAtHome: defender.isBase },
  );

  /**
   * ★ 突襲只交戰一輪，**雙方損失 ×0.6**（`docs/04` §2.1）——
   *   而且沒死成的人要加回存活者，否則折損失等於憑空消失一批兵。
   */
  const attackerLosses = isRaid
    ? scaleLosses(battle.attackerLosses, RAID_LOSS_MULTIPLIER)
    : battle.attackerLosses;
  const defenderLosses = isRaid
    ? scaleLosses(battle.defenderLosses, RAID_LOSS_MULTIPLIER)
    : battle.defenderLosses;

  const attackerSurvivors = isRaid
    ? reviveSpared(battle.attackerSurvivors, attackerArmy, attackerLosses)
    : battle.attackerSurvivors;
  const defenderSurvivors = isRaid
    ? reviveSpared(battle.defenderSurvivors, defender.garrison, defenderLosses)
    : battle.defenderSurvivors;

  // 掠奪：士氣折扣與載重上限已在 combat.ts 算過，這裡再套重複劫掠遞減
  const decay = diminishingFactor(priorRaids);
  const rawLoot: Lootable = {};
  for (const [r, v] of Object.entries(battle.loot)) {
    if (v && v > 0) rawLoot[r as keyof Lootable] = Math.floor(v * decay);
  }
  const loot =
    battle.outcome === "ATTACKER_WIN"
      ? applyCarryLimit(rawLoot, carryOf(attackerSurvivors))
      : {};

  // ── 寫回守方 ────────────────────────────────────────────
  await writeGarrison(
    tx,
    march.seasonId,
    defender.garrisonOwnerId,
    defender.playerId,
    march.toX,
    march.toY,
    defenderSurvivors,
  );

  const lootTotal = (["grain", "timber", "stone", "iron"] as const).reduce(
    (s, r) => s + (loot[r] ?? 0),
    0,
  );
  if (lootTotal > 0) {
    const next: Record<string, string> = {};
    for (const r of ["grain", "timber", "stone", "iron"] as const) {
      next[r] = String(Math.max(0, defender.resources[r] - (loot[r] ?? 0)));
    }
    await tx
      .update(schema.playerResources)
      .set(next)
      .where(eq(schema.playerResources.playerId, defender.playerId));
  }

  // ── 戰報 ────────────────────────────────────────────────
  await tx.insert(schema.battleReports).values({
    seasonId: march.seasonId,
    attackerId: march.ownerId,
    defenderId: defender.playerId,
    atX: march.toX,
    atY: march.toY,
    marchType: march.type,
    outcome: battle.outcome,
    snapshot: snapshotOf(battle, {
      attackerArmy,
      defenderArmy: defender.garrison,
      attackerLosses,
      defenderLosses,
      loot,
      decay,
      priorRaids,
      isRaid,
    }) as never,
    createdAt: new Date(now),
  });

  await tx
    .update(schema.marches)
    .set({ status: "ARRIVED" })
    .where(eq(schema.marches.id, march.id));

  await sendHome(tx, march, attackerSurvivors, lootTotal > 0 ? loot : null, now);
  return true;
}

// ─────────────────────────────────────────────────────────────
// 守方狀態
// ─────────────────────────────────────────────────────────────

interface DefenderContext {
  readonly playerId: number;
  /** 站在這一格的部隊屬於誰（增援時 ≠ playerId） */
  readonly garrisonOwnerId: number;
  readonly garrison: Army;
  readonly resources: Record<"grain" | "timber" | "stone" | "iron", number>;
  readonly citadelLevel: number;
  readonly depotLevel: number;
  readonly wallLevel: number;
  readonly watchtowerLevel: number;
  readonly infirmaryLevel: number;
  readonly facilityLevel: number;
  readonly isBase: boolean;
}

async function defenderAt(
  tx: TxDb,
  seasonId: number,
  x: number,
  y: number,
  now: number,
): Promise<DefenderContext | null> {
  const [base] = await tx
    .select({ id: schema.players.id })
    .from(schema.players)
    .where(
      and(
        eq(schema.players.seasonId, seasonId),
        eq(schema.players.baseX, x),
        eq(schema.players.baseY, y),
      ),
    )
    .limit(1);

  const [tile] = await tx
    .select()
    .from(schema.tiles)
    .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, x), eq(schema.tiles.y, y)))
    .limit(1);

  const playerId = base?.id ?? tile?.playerId ?? null;
  if (playerId === null) return null;

  const state = await settleWithin(tx, playerId, now);
  const isBase = base?.id === playerId;

  /**
   * ★ 這一格上**所有人**的部隊都算防禦（增援的也算，`docs/04` §2.1）。
   *   但只有一份會被寫回 —— 所以增援的部隊要各自結算。
   *   v1 先把主人的那一份算進戰鬥，增援的部分留給 M4 的聯盟協同。
   */
  const garrison = await garrisonAt(tx, seasonId, playerId, x, y);

  const slotLevel = (building: string) => {
    for (const s of ["B", "C", "D"] as const) {
      if (state.build.slots[s].building === building) return state.build.slots[s].level;
    }
    return 0;
  };

  return {
    playerId,
    garrisonOwnerId: playerId,
    garrison,
    resources: state.economy.resources,
    citadelLevel: state.build.citadel,
    depotLevel: slotLevel("DEPOT"),
    wallLevel: isBase ? slotLevel("RAMPART") : 0,
    watchtowerLevel: tile?.facility === "WATCHTOWER" ? tile.facilityLevel : 0,
    infirmaryLevel: slotLevel("INFIRMARY"),
    facilityLevel: tile?.facilityLevel ?? 0,
    isBase,
  };
}

// ─────────────────────────────────────────────────────────────
// 回程
// ─────────────────────────────────────────────────────────────

async function sendHome(
  tx: TxDb,
  march: MarchRow,
  survivors: Army,
  cargo: Lootable | null,
  now: number,
) {
  if (isEmptyArmy(survivors)) return;

  const back = planReturn(
    survivors,
    { x: march.toX, y: march.toY },
    { x: march.fromX, y: march.fromY },
    now,
  );
  if (!back) return;

  await tx.insert(schema.marches).values({
    seasonId: march.seasonId,
    ownerId: march.ownerId,
    type: "RETURN",
    fromX: march.toX,
    fromY: march.toY,
    toX: march.fromX,
    toY: march.fromY,
    units: survivors as never,
    cargo: (cargo ?? null) as never,
    departedAt: new Date(now),
    arrivesAt: new Date(back.arrivesAt),
  });
}

// ─────────────────────────────────────────────────────────────
// 戰報
// ─────────────────────────────────────────────────────────────

/**
 * 戰報快照。
 *
 * ★ 把 `breakdown` 整份存下來，讓詳情頁能展開完整的計算過程
 *   （`docs/10` M3）。玩家算得出來的數字才有討論的餘地 ——
 *   而「為什麼我輸了」是這類遊戲裡最常見、也最該被回答的問題。
 */
function snapshotOf(
  battle: ResolvedBattle,
  extra: {
    attackerArmy: Army;
    defenderArmy: Army;
    attackerLosses: Army;
    defenderLosses: Army;
    loot: Lootable;
    decay: number;
    priorRaids: number;
    isRaid: boolean;
  },
) {
  return {
    kind: "BATTLE",
    outcome: battle.outcome,
    scoring: battle.scoring,
    attacker: { sent: extra.attackerArmy, losses: extra.attackerLosses },
    defender: {
      present: extra.defenderArmy,
      losses: extra.defenderLosses,
      wounded: battle.defenderWounded,
    },
    loot: extra.loot,
    raid: extra.isRaid
      ? { lossMultiplier: RAID_LOSS_MULTIPLIER, decay: extra.decay, priorRaids: extra.priorRaids }
      : null,
    breakdown: battle.breakdown,
  };
}
