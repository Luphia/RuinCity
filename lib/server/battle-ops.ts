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

import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import { CLAIM, SEASON_MODIFIERS, STRUCTURE } from "@/lib/game/balance";
import {
  applyCarryLimit,
  carryOf,
  diminishingFactor,
  isEmptyArmy,
  lootableOf,
  mergeArmies,
  parseArmy,
  armyPopulation,
  subtractArmy,
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
import {
  currentHp,
  maxHpOf,
  structureDamage,
  structureOf,
  type StructureKind,
} from "@/lib/game/structures";
import { deriveSeed, mulberry32 } from "@/lib/game/rng";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { settleWithin } from "@/lib/server/player-state";
import {
  closeEngagement,
  dueEngagements,
  joinOrOpenEngagement,
  partsOf,
  toParticipants,
  type EngagementRow,
} from "@/lib/server/engagement-ops";
import { distributeLosses, distributeSpoils, sideArmy } from "@/lib/game/engagement";
import {
  addWounded,
  garrisonAt,
  landReturn,
  recoverWounded,
  roadNetworkFor,
  writeGarrison,
} from "@/lib/server/march-ops";

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
  /**
   * ★ 先讓傷兵歸隊，再結算抵達。
   *   順序反過來的話，「十一分鐘前被打過、現在又被打」的守方
   *   會少掉那一批已經該站起來的人 —— 而玩家看到的是
   *   「我明明看到傷兵倒數跑完了，怎麼還是沒人守」。
   */
  await recoverWounded(tx, seasonId, now);

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
      /**
       * ★ 突襲**不進場**（`docs/04` §3d）。
       *   突襲的定義就是快打快走：不佔名額、不能被援軍打斷、
       *   也碰不到建物。它是唯一還走「抵達即結算」的類型 ——
       *   保留它是刻意的，玩家需要一種不會把部隊卡兩分鐘的騷擾手段。
       */
      return resolveAssault(tx, march, now);
    case "ATTACK":
    case "CLAIM":
      return enterEngagement(tx, march, now);
    default:
      // 認不出來的類型就當作原地解散並回家
      await sendHome(tx, march, parseArmy(march.units), null, now);
      return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 征服：打野生守衛，贏了立刻佔領（docs/02 §2.5、docs/11 §22）
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 交戰：進場與結算（docs/04 §3d）
// ─────────────────────────────────────────────────────────────

/**
 * 抵達 → **進場**。
 *
 * 這裡不打仗，只把部隊放進這一格的交戰名冊裡（沒有就開一場）。
 * 真正的結算兩分鐘後由 `resolveDueEngagements` 一起做。
 *
 * 名額滿了就原地回頭 —— 而且要**講出來**：戰場擠不下是一個
 * 玩家需要知道的事實（他得換個目標，或等下一場）。
 */
async function enterEngagement(tx: TxDb, march: MarchRow, now: number): Promise<boolean> {
  const army = parseArmy(march.units);
  const defender = await defenderAt(tx, march.seasonId, march.toX, march.toY, now);

  /**
   * 中立地：沒有守方玩家，守的是野生守衛（`docs/02` §2.5）。
   * ★ 攻方名額對**所有人**開放 —— 這就是「若有空位其他玩家也能派兵競爭」。
   */
  const isNeutral = defender === null;

  /**
   * ★ CLAIM 抵達時那一格已經有主人 → **原地回頭**，不會變成一場 PvP。
   *   玩家派出去的是一支拓荒隊，路上被別人插了旗；
   *   把它自動轉成攻擊那個人是一個沒有人要的驚喜（`docs/11` §22.3）。
   */
  if (!isNeutral && march.type === "CLAIM") {
    await tx.insert(schema.battleReports).values({
      seasonId: march.seasonId,
      attackerId: march.ownerId,
      defenderId: defender!.playerId,
      atX: march.toX,
      atY: march.toY,
      marchType: "CLAIM",
      outcome: "CLAIM_FAILED",
      snapshot: { kind: "WILD_CLAIM", reason: "TILE_TAKEN", sent: army } as never,
      createdAt: new Date(now),
    });
    await tx.update(schema.marches).set({ status: "ARRIVED" }).where(eq(schema.marches.id, march.id));
    await sendHome(tx, march, army, null, now);
    return false;
  }

  if (isNeutral && march.type !== "CLAIM") {
    // 對一片沒有主人的空地發動 ATTACK 不會發生任何事
    await tx.update(schema.marches).set({ status: "ARRIVED" }).where(eq(schema.marches.id, march.id));
    await sendHome(tx, march, army, null, now);
    return false;
  }

  let guards: Army = {};
  let wildLevel = 0;
  if (isNeutral) {
    const state = await settleWithin(tx, march.ownerId, now);
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
    const { wildGuardsFor } = await import("@/lib/game/wilds");
    const distance = Math.max(Math.abs(march.toX - march.fromX), Math.abs(march.toY - march.fromY));
    wildLevel = check.level;
    guards = wildGuardsFor(check.level, distance);
  }

  const result = await joinOrOpenEngagement(
    tx,
    {
      seasonId: march.seasonId,
      x: march.toX,
      y: march.toY,
      isKeep: defender?.isBase ?? false,
      defenderId: defender?.playerId ?? null,
      defenderGarrison: isNeutral ? guards : defender!.garrison,
      attacker: { playerId: march.ownerId, marchId: march.id, army },
    },
    now,
  );

  await tx.update(schema.marches).set({ status: "ARRIVED" }).where(eq(schema.marches.id, march.id));

  if (!result.joined) {
    /**
     * ★ 名額滿了 —— 這不是錯誤，是戰場的物理極限（5 對 5、主城 10 對 10）。
     *   寫一份戰報讓玩家看得到「我到了，但擠不進去」，然後原地回頭。
     */
    await tx.insert(schema.battleReports).values({
      seasonId: march.seasonId,
      attackerId: march.ownerId,
      defenderId: defender?.playerId ?? null,
      atX: march.toX,
      atY: march.toY,
      marchType: march.type,
      outcome: "CLAIM_FAILED",
      snapshot: {
        kind: "SLOTS_FULL",
        sent: army,
        endsAt: result.engagement.endsAt.getTime(),
      } as never,
      createdAt: new Date(now),
    });
    await sendHome(tx, march, army, null, now);
    return false;
  }

  // 中立地要把野地等級記在交戰上，結算時佔領才知道抄什麼等級進 tiles
  if (isNeutral && wildLevel > 0) {
    await tx
      .update(schema.engagements)
      .set({ defenderId: null })
      .where(eq(schema.engagements.id, result.engagement.id));
  }
  return false;
}

/**
 * ★ 結算一場到期的交戰 —— 這是新模型的心臟。
 *
 * 總帳仍然命定（`docs/11` §20.20）：把兩方**各自的合計**餵給
 * `resolveBattle` 算一次，再按出兵比例把損失分回每個人身上。
 * 沒有「多方混戰」的第二套數學 —— 那會是第二個戰鬥引擎。
 *
 * 順序與單挑時完全相同：野戰 → 守軍清空才輪到建物 → 佔領／出局。
 */
async function resolveOneEngagement(tx: TxDb, e: EngagementRow, now: number): Promise<boolean> {
  const parts = await partsOf(tx, e.id);
  const ps = toParticipants(parts);
  const attackers = parts.filter((p) => p.side === "ATTACKER");

  if (attackers.length === 0) {
    await closeEngagement(tx, e.id, now);
    return false;
  }

  const attackerArmy = sideArmy(ps, "ATTACKER");
  const defenderArmy = sideArmy(ps, "DEFENDER");
  const defender = await defenderAt(tx, e.seasonId, e.x, e.y, now);
  const neutral = e.defenderId === null;

  /**
   * 守方的加成取自**這一格的主人**。中立地沒有主人，
   * 用野地的固有防禦（`docs/02` §2.5），並且不套用士氣（PvE）。
   */
  const { wildInnateDefense } = await import("@/lib/game/wilds");
  const [tile] = await tx
    .select({ level: schema.tiles.level })
    .from(schema.tiles)
    .where(and(eq(schema.tiles.seasonId, e.seasonId), eq(schema.tiles.x, e.x), eq(schema.tiles.y, e.y)))
    .limit(1);

  const battle = resolveBattle(
    { army: attackerArmy },
    {
      army: defenderArmy,
      wallLevel: defender?.isBase ? defender.wallLevel : 0,
      innateDefense: neutral
        ? wildInnateDefense(tile?.level ?? 1)
        : defender?.isBase
          ? innateDefenseOf(defender.citadelLevel)
          : tileInnateDefense(defender?.facilityLevel ?? 0),
      watchtowerDefense: watchtowerDefenseOf(defender?.watchtowerLevel ?? 0),
      infirmaryLevel: defender?.infirmaryLevel,
      lootable: defender
        ? lootableOf(
            defender.resources,
            defender.citadelLevel,
            defender.depotLevel,
            SEASON_MODIFIERS[(await settleWithin(tx, attackers[0]!.playerId!, now)).season].vault,
          )
        : undefined,
    },
    { marchType: "ATTACK", defenderAtHome: defender?.isBase ?? false, skipMorale: neutral },
  );

  // ── 損失分回每一位參戰者 ────────────────────────────────
  const atkLosses = distributeLosses(ps, "ATTACKER", battle.attackerLosses);
  const defLosses = distributeLosses(ps, "DEFENDER", battle.defenderLosses);

  const survivorsByIndex = new Map<number, Army>();
  ps.forEach((p, index) => {
    const lost = (p.side === "ATTACKER" ? atkLosses : defLosses).get(index) ?? {};
    // `subtractArmy` 兵不夠時回 null —— 那就是全滅（分配保證不會超額，這是防呆）
    survivorsByIndex.set(index, subtractArmy(p.army, lost) ?? {});
  });

  const attackerIdx = ps.map((p, i) => ({ p, i })).filter(({ p }) => p.side === "ATTACKER");
  const attackerSurvivors = new Map(
    attackerIdx.map(({ i }) => [i, survivorsByIndex.get(i) ?? {}] as const),
  );

  /**
   * ★ 誰佔到這一格：**存活兵力最多的那一位攻方**。
   *   中立資源地的競爭因此有一個乾淨的答案 —— 出力最多、留得下人的人拿走。
   *   平手時取先到的（`joinedAt` 排序已經保證了）。
   */
  let winner: { index: number; playerId: number } | null = null;
  let best = -1;
  for (const { p, i } of attackerIdx) {
    const pop = armyPopulation(attackerSurvivors.get(i) ?? {});
    if (pop > best) {
      best = pop;
      winner = { index: i, playerId: p.playerId };
    }
  }

  // ── 攻城階段：守軍清空且攻方獲勝才輪得到建物 ──────────────
  const defenderSurvivorsAll = ps
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.side === "DEFENDER")
    .reduce<Army>((acc, { i }) => mergeArmies(acc, survivorsByIndex.get(i) ?? {}), {});

  /**
   * ★ 建物段落**永遠**跑一次，就算打不到 —— `resolveSiege` 會回一個
   *   帶 `blockedBy`（GARRISON／REPELLED）的結果，而那正是戰報要說的
   *   「為什麼旗還在」。不跑的話戰報只有一個 null，玩家看不出原因。
   */
  let siege: SiegeOutcome | null = null;
  if (!neutral && winner) {
    const [march] = await tx
      .select()
      .from(schema.marches)
      .where(eq(schema.marches.id, parts[winner.index]!.marchId ?? -1))
      .limit(1);
    if (march) {
      siege = await resolveSiege(
        tx,
        march,
        defender ??
          ({
            playerId: 0,
            garrisonOwnerId: 0,
            garrison: {},
            resources: { grain: 0, timber: 0, stone: 0, iron: 0 },
            citadelLevel: 1,
            depotLevel: 0,
            wallLevel: 0,
            watchtowerLevel: 0,
            infirmaryLevel: 0,
            facilityLevel: 0,
            facility: null,
            isBase: false,
            structureHp: null,
            structureHitAt: null,
          } satisfies DefenderContext),
        {
          attackerSurvivors: attackerSurvivors.get(winner.index) ?? {},
          // 守方還有活口就碰不到建物 —— 這個判斷在 `resolveSiege` 裡
          defenderSurvivors: defenderSurvivorsAll,
          won: battle.outcome === "ATTACKER_WIN",
          isRaid: false,
          siegeBonus: 0,
          now,
        },
      );
    }
  }

  /**
   * 中立地被拿下 → 直接寫進 `tiles`（`resolveSiege` 只處理有主的格子）。
   * 野地的旗就是它的守衛：守衛清光，地就是你的。
   */
  if (neutral && battle.outcome === "ATTACKER_WIN" && winner && best > 0) {
    await claimNeutralTile(tx, e, winner.playerId, now);
  }

  // ── 寫回：守方駐軍、傷兵、攻方回程 ──────────────────────
  const defenderIdx = ps.map((p, i) => ({ p, i })).filter(({ p }) => p.side === "DEFENDER");
  for (const { p, i } of defenderIdx) {
    if (p.playerId === 0 || neutral) continue; // 野生守衛不寫回
    await writeGarrison(tx, e.seasonId, p.playerId, p.playerId, e.x, e.y, survivorsByIndex.get(i) ?? {});
  }
  if (!neutral && defender) {
    await addWounded(
      tx,
      e.seasonId,
      defender.garrisonOwnerId,
      e.x,
      e.y,
      battle.defenderWounded,
      now,
    );
  }

  // 掠奪按存活兵力分（死光的搬不動東西）
  const lootTotal = (["grain", "timber", "stone", "iron"] as const).reduce(
    (sum, r) => sum + (battle.loot[r] ?? 0),
    0,
  );
  const spoils = distributeSpoils(attackerSurvivors, battle.outcome === "ATTACKER_WIN" ? lootTotal : 0);

  for (const { p, i } of attackerIdx) {
    const [march] = await tx
      .select()
      .from(schema.marches)
      .where(eq(schema.marches.id, parts[i]!.marchId ?? -1))
      .limit(1);

    const mySpoil = spoils.get(i) ?? 0;
    const cargo: Lootable | null =
      mySpoil > 0 && lootTotal > 0
        ? (Object.fromEntries(
            (["grain", "timber", "stone", "iron"] as const)
              .map((r) => [r, Math.floor(((battle.loot[r] ?? 0) * mySpoil) / lootTotal)])
              .filter(([, v]) => (v as number) > 0),
          ) as Lootable)
        : null;

    await tx.insert(schema.battleReports).values({
      seasonId: e.seasonId,
      attackerId: p.playerId,
      defenderId: e.defenderId,
      atX: e.x,
      atY: e.y,
      marchType: neutral ? "CLAIM" : "ATTACK",
      outcome: battle.outcome,
      snapshot: {
        kind: "BATTLE",
        outcome: battle.outcome,
        scoring: battle.scoring,
        engagement: {
          id: e.id,
          participants: parts.length,
          mine: p.army,
          allies: attackerIdx.length - 1,
          captured: winner?.index === i && (siege?.captured || (neutral && best > 0)),
        },
        attacker: { sent: p.army, losses: atkLosses.get(i) ?? {} },
        defender: { present: defenderArmy, losses: battle.defenderLosses, wounded: battle.defenderWounded },
        loot: cargo ?? {},
        raid: null,
        breakdown: battle.breakdown,
        siege,
      } as never,
      createdAt: new Date(now),
    });

    if (march) await sendHome(tx, march, attackerSurvivors.get(i) ?? {}, cargo, now);
  }

  // 守方的資源要扣掉被搬走的那一份
  if (!neutral && defender && battle.outcome === "ATTACKER_WIN" && lootTotal > 0) {
    const next: Record<string, string> = {};
    for (const r of ["grain", "timber", "stone", "iron"] as const) {
      next[r] = String(Math.max(0, defender.resources[r] - (battle.loot[r] ?? 0)));
    }
    await tx
      .update(schema.playerResources)
      .set(next)
      .where(eq(schema.playerResources.playerId, defender.playerId));
  }

  await closeEngagement(tx, e.id, now);
  return true;
}

/** 中立地被拿下：寫一列新的領地（等級抄自野地推導） */
async function claimNeutralTile(tx: TxDb, e: EngagementRow, playerId: number, now: number) {
  const [attacker] = await tx
    .select({ allianceId: schema.players.allianceId })
    .from(schema.players)
    .where(eq(schema.players.id, playerId))
    .limit(1);

  const [existing] = await tx
    .select({ level: schema.tiles.level, terrain: schema.tiles.terrain })
    .from(schema.tiles)
    .where(and(eq(schema.tiles.seasonId, e.seasonId), eq(schema.tiles.x, e.x), eq(schema.tiles.y, e.y)))
    .limit(1);

  if (existing) {
    await tx
      .update(schema.tiles)
      .set({
        playerId,
        allianceId: attacker?.allianceId ?? null,
        kind: "TERRITORY",
        structureHp: null,
        structureHitAt: null,
        state: "CONTESTED",
        stateUntil: new Date(now + CLAIM.contestedMs),
      })
      .where(and(eq(schema.tiles.seasonId, e.seasonId), eq(schema.tiles.x, e.x), eq(schema.tiles.y, e.y)));
    return;
  }

  const { loadTerrainAround, terrainDirFor } = await import("@/lib/server/terrain");
  const { wildLevelAt } = await import("@/lib/game/wilds");
  const [season] = await tx
    .select({ seed: schema.seasons.seed })
    .from(schema.seasons)
    .where(eq(schema.seasons.id, e.seasonId))
    .limit(1);
  const lookup = await loadTerrainAround(terrainDirFor(e.seasonId), [{ x: e.x, y: e.y }]);
  const terrain = lookup.at(e.x, e.y);
  const level = wildLevelAt(Number(season?.seed ?? 0), e.x, e.y, terrain);

  await tx.insert(schema.tiles).values({
    seasonId: e.seasonId,
    x: e.x,
    y: e.y,
    kind: "TERRITORY",
    playerId,
    allianceId: attacker?.allianceId ?? null,
    terrain,
    level,
    state: "CONTESTED",
    stateUntil: new Date(now + CLAIM.contestedMs),
  });
}

/** 掃這一季所有到期的交戰。與行軍抵達同一個節奏（cron 每分鐘） */
export async function resolveEngagements(
  tx: TxDb,
  seasonId: number,
  now: number,
): Promise<{ resolved: number; failures: number }> {
  const due = await dueEngagements(tx, seasonId, now);
  let resolved = 0;
  let failures = 0;
  for (const e of due) {
    try {
      await resolveOneEngagement(tx, e, now);
      resolved++;
    } catch {
      // 一場交戰結算失敗不能拖垮整批；它仍未結算，下一分鐘再試
      failures++;
    }
  }
  return { resolved, failures };
}

/**
 * ★ `resolveConquest` 已退役（M?：交戰模型）。
 *
 *   野地征服現在與 PvP 走**同一條**路徑：抵達 → 進場 → 兩分鐘後結算
 *   （`enterEngagement` / `resolveOneEngagement`）。
 *   留著舊的單挑版本只會讓兩條路徑慢慢分岔 —— 而分岔的症狀是
 *   「同一件事在 PvP 與 PvE 下的規則不一樣」。
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

  const siegeBonus =
    attackerState.build.slots.C.building === "WORKSHOP"
      ? 0.04 * attackerState.build.slots.C.level
      : 0;

  const battle = resolveBattle(
    { army: attackerArmy, siegeBonus },
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

  /**
   * ★ 傷兵（`docs/04` §3c）：十分鐘後歸隊，**陣亡的永遠回不來**。
   *   `combat.ts` 從 M0 就在算 `defenderWounded`（醫療帳回收率）、
   *   戰報也一直印它 —— 但那些人從來沒有真的回到駐軍裡。
   *   現在它們有家了。歸隊條件（自己的據點或要塞）由 `recoverWounded` 判斷，
   *   所以躺在野地上的傷兵會一直躺著，直到那一格重新變成你的。
   */
  if (!isRaid) {
    await addWounded(
      tx,
      march.seasonId,
      defender.garrisonOwnerId,
      march.toX,
      march.toY,
      battle.defenderWounded,
      now,
    );
  }

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

  /**
   * ── 攻城階段（`docs/02` §2.6、`docs/04` §5）────────────────
   *
   * ★ 順序是規則的一部分：**領地內有防守軍隊時只能先攻擊軍隊**。
   *   守軍還活著（或攻方沒打贏）就碰不到建物 —— 建物不是第二個血條，
   *   它是「軍隊清空之後才輪得到」的第二階段。
   *
   * ★ 突襲（RAID）永遠不碰建物：突襲的定義就是搶完就走。
   */
  const siege = await resolveSiege(tx, march, defender, {
    attackerSurvivors,
    defenderSurvivors,
    won: battle.outcome === "ATTACKER_WIN",
    isRaid,
    siegeBonus,
    now,
  });

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
      siege,
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
// 攻城：建物、佔領
// ─────────────────────────────────────────────────────────────

/** 戰報裡的攻城段落（沒發生就是 null）*/
export interface SiegeOutcome {
  readonly kind: StructureKind;
  readonly label: string;
  readonly hpBefore: number;
  readonly hpAfter: number;
  readonly maxHp: number;
  readonly damage: number;
  readonly destroyed: boolean;
  /** 這一擊之後這一格易主了 */
  readonly captured: boolean;
  /** 為什麼沒打到建物（守軍還在／突襲／攻方輸了）*/
  readonly blockedBy: "GARRISON" | "RAID" | "REPELLED" | null;
}

/**
 * 攻城階段。**在守軍結算之後**跑，因為順序本身就是規則：
 * 領地內有防守軍隊時只能先攻擊軍隊（`docs/04` §5）。
 *
 * 一般部隊每人 1 點、器械才算數（`lib/game/structures.ts`）——
 * 所以「沒帶器械就搶不走別人的要塞」是算術上的事實，不是提示文字。
 */
async function resolveSiege(
  tx: TxDb,
  march: MarchRow,
  defender: DefenderContext,
  ctx: {
    attackerSurvivors: Army;
    defenderSurvivors: Army;
    won: boolean;
    isRaid: boolean;
    siegeBonus: number;
    now: number;
  },
): Promise<SiegeOutcome | null> {
  const kind = structureOf({ isBase: defender.isBase, facility: defender.facility });
  const level =
    kind === "KEEP"
      ? defender.citadelLevel
      : kind === "TOWER"
        ? defender.facilityLevel
        : 0;
  const maxHp = maxHpOf(kind, level);
  const hpBefore = currentHp(
    kind,
    level,
    { hp: defender.structureHp, hitAt: defender.structureHitAt },
    ctx.now,
  );

  const base = {
    kind,
    label: STRUCTURE[kind].label,
    hpBefore,
    hpAfter: hpBefore,
    maxHp,
    damage: 0,
    destroyed: false,
    captured: false,
  };

  // 突襲搶完就走，不碰建物
  if (ctx.isRaid) return { ...base, blockedBy: "RAID" };
  // 攻方沒打贏 → 連走近建物的機會都沒有
  if (!ctx.won) return { ...base, blockedBy: "REPELLED" };
  // ★ 守軍還有活口 → 只能先攻擊軍隊
  if (armyPopulation(ctx.defenderSurvivors) > 0) return { ...base, blockedBy: "GARRISON" };

  const damage = structureDamage(ctx.attackerSurvivors, { siegeBonus: ctx.siegeBonus });
  const hpAfter = Math.max(0, hpBefore - damage);
  const destroyed = hpAfter <= 0;

  /**
   * ★ 主城不會「易主」，它會**終結一位玩家**（`docs/02` §3.1）：
   *   打爆主城 = 那位領主**出局**，整季不再回來。
   *   這是全遊戲最重的一個後果，所以它不共用佔領那條路徑。
   */
  const captured = destroyed && kind !== "KEEP";

  if (kind === "KEEP") {
    if (destroyed) await eliminatePlayer(tx, march.seasonId, defender.playerId, ctx.now);
    // 主城的耐久不入庫 —— 每一波都是完整的一次攻城
    return { ...base, hpAfter, damage, destroyed, captured: false, blockedBy: null };
  }

  if (captured) {
    /**
     * 佔領：這一格連同設施整個易主。
     * ★ 設施留著不拆 —— 打下一座 Lv8 的農田本來就該是戰利品，
     *   而「拆掉重蓋」只會讓佔領變成不划算的破壞行為。
     *   建物耐久重置成滿血（新主人的旗是新的）。
     */
    const [attacker] = await tx
      .select({ allianceId: schema.players.allianceId })
      .from(schema.players)
      .where(eq(schema.players.id, march.ownerId))
      .limit(1);

    await tx
      .update(schema.tiles)
      .set({
        playerId: march.ownerId,
        allianceId: attacker?.allianceId ?? null,
        structureHp: null,
        structureHitAt: null,
        // 易主後有一段動盪期，與拓荒下來的格子同一條規則
        state: "CONTESTED",
        stateUntil: new Date(ctx.now + CLAIM.contestedMs),
      })
      .where(
        and(
          eq(schema.tiles.seasonId, march.seasonId),
          eq(schema.tiles.x, march.toX),
          eq(schema.tiles.y, march.toY),
        ),
      );
  } else {
    await tx
      .update(schema.tiles)
      .set({ structureHp: hpAfter, structureHitAt: new Date(ctx.now) })
      .where(
        and(
          eq(schema.tiles.seasonId, march.seasonId),
          eq(schema.tiles.x, march.toX),
          eq(schema.tiles.y, march.toY),
        ),
      );
  }

  return { ...base, hpAfter, damage, destroyed, captured, blockedBy: null };
}

/**
 * ★ 出局：主城被打爆的那一刻，這位領主的賽季就結束了。
 *
 * 做四件事，順序不重要但一件都不能少 —— 少任何一件，
 * 地圖上都會留下一個「已經不存在的人」還在運作的東西：
 *
 *   1. `players.eliminatedAt` —— 出局的判準只有這一個欄位
 *   2. 領地全部釋放成無主（旗倒了，地就回到廢土）
 *   3. 駐軍清空（守軍隨主城一起沒了）
 *   4. 在途的行軍全部取消（沒有人可以回去了）
 *
 * 已出局的玩家不會被結算、不能派兵、也不會再被當成攻擊目標
 * （`settleWithin` 與 `sendMarchFor` 都會擋）。
 */
async function eliminatePlayer(tx: TxDb, seasonId: number, playerId: number, now: number) {
  const [already] = await tx
    .select({ eliminatedAt: schema.players.eliminatedAt })
    .from(schema.players)
    .where(eq(schema.players.id, playerId))
    .limit(1);
  if (already?.eliminatedAt) return; // 冪等：同一波兩支部隊同時破城

  await tx
    .update(schema.players)
    .set({ eliminatedAt: new Date(now) })
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

  /**
   * ★ 未結算的事件也要清掉。
   *   不清的話，結算迴圈每一分鐘都會撿起這位玩家的到期事件、
   *   撞上 `PlayerEliminatedError`、記一筆 failure —— 而那些事件
   *   永遠不會消失。症狀是「cron 的失敗數每分鐘 +1，而且看不出原因」。
   */
  await tx
    .delete(schema.events)
    .where(
      and(
        eq(schema.events.seasonId, seasonId),
        eq(schema.events.actorId, playerId),
        isNull(schema.events.resolvedAt),
      ),
    );
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
  readonly facility: string | null;
  readonly isBase: boolean;
  /** 領地建物的存檔（`null` = 從沒被打過）—— 修復由 `currentHp` 推 */
  readonly structureHp: number | null;
  readonly structureHitAt: number | null;
}

async function defenderAt(
  tx: TxDb,
  seasonId: number,
  x: number,
  y: number,
  now: number,
): Promise<DefenderContext | null> {
  /**
   * ★ 已出局的領主不再是目標 —— 他的主城已經倒了。
   *   少了 `isNull(eliminatedAt)`，玩家會發現自己可以對著一座
   *   廢墟反覆刷戰報。
   */
  const [base] = await tx
    .select({ id: schema.players.id })
    .from(schema.players)
    .where(
      and(
        eq(schema.players.seasonId, seasonId),
        eq(schema.players.baseX, x),
        eq(schema.players.baseY, y),
        isNull(schema.players.eliminatedAt),
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
    facility: tile?.facility ?? null,
    isBase,
    structureHp: tile?.structureHp ?? null,
    structureHitAt: tile?.structureHitAt ? tile.structureHitAt.getTime() : null,
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

  // 回程一樣吃自己的路網（`docs/02` §2.6）—— 撤回驛道上本來就該快
  const road = await roadNetworkFor(tx, march.seasonId, march.ownerId);
  const back = planReturn(
    survivors,
    { x: march.toX, y: march.toY },
    { x: march.fromX, y: march.fromY },
    now,
    { road },
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
    /** 攻城段落（沒發生 = null）。戰報要說得出「為什麼沒打到建物」 */
    siege?: SiegeOutcome | null;
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
    siege: extra.siege ?? null,
  };
}
