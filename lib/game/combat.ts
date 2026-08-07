/**
 * 戰鬥引擎。純函式，無 I/O，完全確定性。
 *
 * 回傳值刻意包含**完整的計算過程**（`ResolvedBattle.breakdown`）——
 * 戰報頁面會把它整段展開給玩家看。
 * 玩家輸掉一場仗時最挫折的不是輸，是不知道為什麼輸。
 *
 * 對應 docs/04-military-combat.md §3 與 docs/16-supply-and-attrition.md §4–5。
 */

import {
  COMBAT,
  CORE_BUILDING_EFFECT,
  LOOTABLE,
  UNIT,
  type MarchType,
  type Resource,
  type Unit,
} from "./balance";
import { armyCarry, armyPopulation } from "./formulas";

export type Army = Partial<Record<Unit, number>>;

export interface AttackerInput {
  army: Army;
  /** 攻擊科技加成，例如 FORGING Lv5 → 0.15 */
  attackTech?: number;
  /** 遺跡增益（鐵之搖籃）+ 陣營分潤 */
  ruinAttackBonus?: number;
  /** 攻城傷害加成（工坊） */
  siegeBonus?: number;
}

export interface DefenderInput {
  army: Army;
  /** 城牆等級 */
  wallLevel?: number;
  /** 地形防禦修正，例如森林 0.1 */
  terrainDefense?: number;
  defenseTech?: number;
  ruinDefenseBonus?: number;
  /** 固有防禦（核心據點 = 主堡等級 × 120，主旗 ×2；領土格 = 設施等級 × 30） */
  innateDefense?: number;
  /** 哨塔固定防禦 = 200 × 等級 */
  watchtowerDefense?: number;
  /** 醫療帳等級（只在自己據點防守時生效） */
  infirmaryLevel?: number;
  /** 守方可被掠奪的資源（已扣除地窖保護） */
  lootable?: Partial<Record<Resource, number>>;
}

export interface BattleOptions {
  marchType: MarchType;
/**
   * 不套用士氣。
   *
   * 士氣是**反霸凌**機制：大打小時折算戰力與掠奪量，讓「欺負新手」
   * 不划算。但它只該作用在玩家之間 ——
   *
   * - **遺跡爭奪戰**：終局內容不該被反霸凌機制干擾
   * - **廢土營地／PvE**：營地不是玩家，用主力清一個小營地本來就該很輕鬆。
   *   賽季模擬顯示忘了關掉士氣時，帶 200 兵打 40 人的營地會被折到 0.57 倍，
   *   清營地變成穩賠 —— 而 `01` §7 說營地是新手期的主要成長管道。
   */
  skipMorale?: boolean;
  /** 守方是否在自己的據點（醫療帳只在這時生效） */
  defenderAtHome?: boolean;
}

export interface BattleBreakdown {
  attackerBasePower: number;
  attackerAfterTech: number;
  /** 士氣係數，同時打折戰力與掠奪量 */
  morale: number;
  attackerAfterMorale: number;
  /** 無攻城單位打城牆的懲罰倍率（1 = 無懲罰） */
  noSiegeMultiplier: number;
  attackerFinalPower: number;

  /** 攻方部隊中騎兵攻擊力的佔比，用來加權守方防禦 */
  cavalryWeight: number;
  defenderUnitPower: number;
  defenderAfterWall: number;
  defenderAfterTerrain: number;
  defenderAfterTech: number;
  defenderFlatDefense: number;
  defenderFinalPower: number;

  attackerPopulation: number;
  defenderPopulation: number;
  powerRatio: number;
}

export interface ResolvedBattle {
  outcome: "ATTACKER_WIN" | "DEFENDER_WIN";
  /** 存活的部隊 */
  attackerSurvivors: Army;
  defenderSurvivors: Army;
  attackerLosses: Army;
  defenderLosses: Army;
  /** 守方在自家據點陣亡後可復原的傷兵 */
  defenderWounded: Army;
  /** 實際掠奪量（已套用士氣折扣與載重上限） */
  loot: Partial<Record<Resource, number>>;
  /** 是否計入賽季積分（攻擊人口 < 自己 1/5 者不計） */
  scoring: boolean;
  breakdown: BattleBreakdown;
}

// ─────────────────────────────────────────────────────────────

function totalAttackByClass(army: Army): { infantry: number; cavalry: number; siege: number } {
  let infantry = 0;
  let cavalry = 0;
  let siege = 0;
  for (const [unit, n] of Object.entries(army)) {
    if (!n) continue;
    const spec = UNIT[unit as Unit];
    const power = spec.attack * n;
    if (spec.attackClass === "INFANTRY") infantry += power;
    else if (spec.attackClass === "CAVALRY") cavalry += power;
    else if (spec.attackClass === "SIEGE") siege += power;
  }
  return { infantry, cavalry, siege };
}

function hasSiegeUnit(army: Army): boolean {
  for (const [unit, n] of Object.entries(army)) {
    if (n && UNIT[unit as Unit].attackClass === "SIEGE") return true;
  }
  return false;
}

/**
 * 士氣係數 = min(1, (守方人口 / 攻方人口)^0.35)。
 *
 * 這是廢除新手保護期後的核心補償機制之一，
 * 且**同時套用於攻方戰力與攻方掠奪量** —— 打一個新手能拿到的東西趨近於零。
 */
export function moraleFactor(defenderPop: number, attackerPop: number): number {
  if (attackerPop <= 0) return 1;
  if (defenderPop <= 0) return 0; // 守方沒人，攻方也拿不到什麼
  return Math.min(1, (defenderPop / attackerPop) ** COMBAT.moraleExponent);
}

/**
 * 依比例削減一支部隊，回傳 [存活, 損失]。
 * 用 largest-remainder 分配整數，保證存活 + 損失 = 原始數量。
 */
function applySurvival(army: Army, survivalRate: number): [Army, Army] {
  const survivors: Army = {};
  const losses: Army = {};
  for (const [unit, n] of Object.entries(army)) {
    if (!n) continue;
    const alive = Math.round(n * survivalRate);
    const clamped = Math.max(0, Math.min(n, alive));
    if (clamped > 0) survivors[unit as Unit] = clamped;
    const lost = n - clamped;
    if (lost > 0) losses[unit as Unit] = lost;
  }
  return [survivors, losses];
}

function scaleArmy(army: Army, factor: number): Army {
  const out: Army = {};
  for (const [unit, n] of Object.entries(army)) {
    if (!n) continue;
    const v = Math.round(n * factor);
    if (v > 0) out[unit as Unit] = v;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────

export function resolveBattle(
  attacker: AttackerInput,
  defender: DefenderInput,
  options: BattleOptions,
): ResolvedBattle {
  const atkPop = armyPopulation(attacker.army);
  const defPop = armyPopulation(defender.army);

  // ── 攻方戰力 ────────────────────────────────────────────
  const byClass = totalAttackByClass(attacker.army);
  // 攻城單位的攻擊力受工坊加成
  const attackerBasePower =
    byClass.infantry + byClass.cavalry + byClass.siege * (1 + (attacker.siegeBonus ?? 0));

  const attackerAfterTech =
    attackerBasePower * (1 + (attacker.attackTech ?? 0) + (attacker.ruinAttackBonus ?? 0));

  const morale = options.skipMorale ? 1 : moraleFactor(defPop, atkPop);
  const attackerAfterMorale = attackerAfterTech * morale;

  // 沒有攻城器械就別想拆牆
  const wallLevel = defender.wallLevel ?? 0;
  const noSiegeMultiplier =
    wallLevel > 0 && !hasSiegeUnit(attacker.army)
      ? 1 - Math.min(COMBAT.noSiegePenaltyMax, COMBAT.noSiegePenaltyPerWallLevel * wallLevel)
      : 1;

  const attackerFinalPower = attackerAfterMorale * noSiegeMultiplier;

  // ── 守方戰力 ────────────────────────────────────────────
  // 騎兵佔比加權，避免「騎兵剛好 39% vs 40%」的二元跳變
  const offensiveTotal = byClass.infantry + byClass.cavalry;
  const cavalryWeight = offensiveTotal > 0 ? byClass.cavalry / offensiveTotal : 0;

  let defenderUnitPower = 0;
  for (const [unit, n] of Object.entries(defender.army)) {
    if (!n) continue;
    const spec = UNIT[unit as Unit];
    const perUnit =
      spec.defInfantry * (1 - cavalryWeight) + spec.defCavalry * cavalryWeight;
    defenderUnitPower += perUnit * n;
  }

  const defenderAfterWall =
    defenderUnitPower * (1 + COMBAT.rampartDefensePerLevel * wallLevel);
  const defenderAfterTerrain = defenderAfterWall * (1 + (defender.terrainDefense ?? 0));
  const defenderAfterTech =
    defenderAfterTerrain *
    (1 + (defender.defenseTech ?? 0) + (defender.ruinDefenseBonus ?? 0));

  const defenderFlatDefense =
    (defender.innateDefense ?? 0) + (defender.watchtowerDefense ?? 0);
  const defenderFinalPower = defenderAfterTech + defenderFlatDefense;

  // ── 損失結算（Lanchester 變體）──────────────────────────
  const attackerWins = attackerFinalPower > defenderFinalPower;
  const ratio =
    defenderFinalPower > 0 ? attackerFinalPower / defenderFinalPower : Infinity;

  // 突襲：雙方都保留部分兵力，低風險低回報
  const lossScale = options.marchType === "RAID" ? COMBAT.raidLossMultiplier : 1;

  let attackerSurvival: number;
  let defenderSurvival: number;

  if (attackerWins) {
    const raw = 1 - (defenderFinalPower / attackerFinalPower) ** COMBAT.lossExponent;
    attackerSurvival = 1 - (1 - raw) * lossScale;
    defenderSurvival = 1 - lossScale;
  } else {
    const raw =
      attackerFinalPower > 0
        ? 1 - (attackerFinalPower / defenderFinalPower) ** COMBAT.lossExponent
        : 1;
    defenderSurvival = 1 - (1 - raw) * lossScale;
    attackerSurvival = 1 - lossScale;
  }

  const [attackerSurvivors, attackerLosses] = applySurvival(attacker.army, attackerSurvival);
  const [defenderSurvivors, defenderLosses] = applySurvival(defender.army, defenderSurvival);

  // ── 醫療帳：守家在成本上始終佔優 ────────────────────────
  let defenderWounded: Army = {};
  if (options.defenderAtHome && defender.infirmaryLevel !== undefined) {
    const rate = Math.min(
      CORE_BUILDING_EFFECT.infirmaryRecoveryMax,
      CORE_BUILDING_EFFECT.infirmaryRecoveryBase +
        CORE_BUILDING_EFFECT.infirmaryRecoveryPerLevel * defender.infirmaryLevel,
    );
    defenderWounded = scaleArmy(defenderLosses, rate);
  }

  // ── 掠奪 ────────────────────────────────────────────────
  const loot: Partial<Record<Resource, number>> = {};
  if (attackerWins && options.marchType !== "SCOUT" && defender.lootable) {
    const capacity = armyCarry(attackerSurvivors);
    let available = 0;
    for (const r of LOOTABLE) available += defender.lootable[r] ?? 0;

    if (available > 0 && capacity > 0) {
      // 士氣同時打折掠奪量 —— 欺負弱者在數學上不划算
      const takeTotal = Math.min(capacity, available) * morale;
      for (const r of LOOTABLE) {
        const have = defender.lootable[r] ?? 0;
        if (have <= 0) continue;
        // 按未保護量的比例分攤載重，不會只搶一種
        loot[r] = Math.floor(takeTotal * (have / available));
      }
    }
  }

  return {
    outcome: attackerWins ? "ATTACKER_WIN" : "DEFENDER_WIN",
    attackerSurvivors,
    defenderSurvivors,
    attackerLosses,
    defenderLosses,
    defenderWounded,
    loot,
    scoring: defPop >= atkPop * COMBAT.noScoreRatio,
    breakdown: {
      attackerBasePower,
      attackerAfterTech,
      morale,
      attackerAfterMorale,
      noSiegeMultiplier,
      attackerFinalPower,
      cavalryWeight,
      defenderUnitPower,
      defenderAfterWall,
      defenderAfterTerrain,
      defenderAfterTech,
      defenderFlatDefense,
      defenderFinalPower,
      attackerPopulation: atkPop,
      defenderPopulation: defPop,
      powerRatio: ratio,
    },
  };
}
