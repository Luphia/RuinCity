/**
 * 等級縮放與衍生值。純函式，無 I/O。
 *
 * ★ 時間係數只在這一層套用。
 * 呼叫端拿到的一律是「真實世界的秒數／每真實小時的速率」，
 * 不需要再自己乘除 TIME_SCALE —— 那是最容易出錯的地方。
 */

import {
  CITADEL,
  CORE_BUILDING,
  CORE_BUILDING_EFFECT,
  FACILITY,
  FACILITY_SCALING,
  MARCH_SCALE,
  OUTPOST,
  POPULATION,
  REGION_CAPACITY,
  TECH,
  TECH_SCALING,
  TERRAIN_YIELD,
  TIME_SCALE,
  UNIT,
  type CoreBuilding,
  type Facility,
  type Resource,
  type SeasonModifiers,
  type Tech,
  type Terrain,
  type Unit,
} from "./balance";

export type ResourceBundle = Partial<Record<Resource, number>>;

// ─────────────────────────────────────────────────────────────
// 主堡
// ─────────────────────────────────────────────────────────────

/** 主堡升到 `level` 所需資源（從 level-1 升上來的那一次） */
export function citadelUpgradeCost(level: number): ResourceBundle {
  const n = level - 1;
  return {
    timber: Math.round(CITADEL.cost.timber.base * CITADEL.cost.timber.growth ** (n - 1)),
    stone: Math.round(CITADEL.cost.stone.base * CITADEL.cost.stone.growth ** (n - 1)),
    iron: Math.round(CITADEL.cost.iron.base * CITADEL.cost.iron.growth ** (n - 1)),
  };
}

/** 主堡升級的**真實秒數**（已套用 TIME_SCALE） */
export function citadelUpgradeSeconds(level: number): number {
  const n = level - 1;
  return (CITADEL.time.base * CITADEL.time.growth ** (n - 1)) / TIME_SCALE;
}

export function territoryCapacity(citadelLevel: number, bandBonus = 0): number {
  return CITADEL.territoryCapacityPerLevel * citadelLevel + bandBonus;
}

/** 人口天花板 = 60 × L^1.15 */
export function populationCap(citadelLevel: number): number {
  return Math.round(POPULATION.cap.coefficient * citadelLevel ** POPULATION.cap.exponent);
}

/**
 * 人口成長率（人 / 真實小時）。
 *
 * **這個值不套用 TIME_SCALE** —— 數值表裡的常數已經是真實世界的速率。
 * 主堡管上限、領土管補血：領地愈多，長得愈快。
 */
export function populationGrowthPerHour(citadelLevel: number, territoryCount: number): number {
  const base = POPULATION.growth.base + POPULATION.growth.perCitadelLevel * citadelLevel;
  return base * (1 + territoryCount / POPULATION.growth.territoryDivisor);
}

export function territoryQueues(citadelLevel: number): number {
  return Math.min(
    CITADEL.territoryQueues.max,
    CITADEL.territoryQueues.base + Math.floor(citadelLevel / CITADEL.territoryQueues.per),
  );
}

export function outpostCap(citadelLevel: number): number {
  return Math.floor(citadelLevel / CITADEL.outpostCap.per);
}

/** 執政官可同時啟用的方針數 = 1 + ⌊主堡等級 / 8⌋ */
export function stewardDirectiveSlots(citadelLevel: number): number {
  return Math.min(
    CITADEL.stewardDirectives.max,
    CITADEL.stewardDirectives.base + Math.floor(citadelLevel / CITADEL.stewardDirectives.per),
  );
}

export function coreGarrisonCap(citadelLevel: number, isStandard = false): number {
  const base = CITADEL.garrisonCap.base + CITADEL.garrisonCap.perLevel * citadelLevel;
  return isStandard ? Math.round(base * 1.5) : base;
}

/** 據點固有防禦；主旗（盟主據點）×2 */
export function innateDefense(citadelLevel: number, isStandard = false): number {
  const base = CITADEL.innateDefensePerLevel * citadelLevel;
  return isStandard ? base * 2 : base;
}

// ─────────────────────────────────────────────────────────────
// 核心建築
// ─────────────────────────────────────────────────────────────

export function coreBuildingCost(building: CoreBuilding, level: number): ResourceBundle {
  const f = CORE_BUILDING[building].factor;
  const c = citadelUpgradeCost(level);
  return {
    timber: Math.round((c.timber ?? 0) * f),
    stone: Math.round((c.stone ?? 0) * f),
    iron: Math.round((c.iron ?? 0) * f),
  };
}

export function coreBuildingSeconds(building: CoreBuilding, level: number): number {
  return citadelUpgradeSeconds(level) * CORE_BUILDING[building].factor;
}

// ─────────────────────────────────────────────────────────────
// 領土設施
// ─────────────────────────────────────────────────────────────

export function facilityCost(facility: Facility, level: number): ResourceBundle {
  const mult = FACILITY_SCALING.costGrowth ** (level - 1);
  const out: ResourceBundle = {};
  for (const [k, v] of Object.entries(FACILITY[facility].cost)) {
    out[k as Resource] = Math.round(v * mult);
  }
  return out;
}

export function facilitySeconds(level: number): number {
  return (FACILITY_SCALING.time.base * FACILITY_SCALING.time.growth ** (level - 1)) / TIME_SCALE;
}

export function facilityLevelCap(citadelLevel: number): number {
  return Math.floor(citadelLevel / FACILITY_SCALING.levelCapDivisor);
}

/**
 * 設施產出（單位 / 真實小時），**已套用 TIME_SCALE**。
 * 非產出設施（哨塔、前哨營、集市）回傳 0。
 */
export function facilityYieldPerHour(
  facility: Facility,
  level: number,
  terrain: Terrain,
  opts: { techBonus?: number; ruinBonus?: number; season?: SeasonModifiers; isolated?: boolean } = {},
): number {
  const spec = FACILITY[facility];
  if (!spec.yields || level <= 0) return 0;

  const base = spec.yieldCoefficient * level ** FACILITY_SCALING.yieldExponent;
  const terrainMult = TERRAIN_YIELD[facility]?.[terrain] ?? 1;

  return (
    base *
    TIME_SCALE *
    terrainMult *
    (1 + (opts.techBonus ?? 0)) *
    (1 + (opts.ruinBonus ?? 0)) *
    (opts.season?.production ?? 1) *
    (opts.isolated ? 0.5 : 1)
  );
}

/** 主堡保底產出（每種資源 / 真實小時），已套用 TIME_SCALE */
export function citadelBaseYieldPerHour(
  citadelLevel: number,
  season?: SeasonModifiers,
): number {
  return CITADEL.baseYieldPerLevel * citadelLevel * TIME_SCALE * (season?.production ?? 1);
}

/**
 * 每種資源的儲存上限。
 *
 * ★ 前哨營也算：`docs/11` §4 給前哨營 `5000 × 等級` 的儲存，
 *   而這裡原本漏了 —— 少了它，主堡在 Lv27 會被儲存上限硬牆卡死
 *   （Lv28 光木材就要 73,560，而滿級倉庫只到 71,390），
 *   Lv28–30 在物理上不可能達成。
 */
export function storageCapacity(
  citadelLevel: number,
  depotLevel: number,
  outpostLevels = 0,
): number {
  const base = 2000 + CITADEL.capacityPerLevel * citadelLevel;
  return Math.round(
    base * (1 + CORE_BUILDING_EFFECT.depotCapacityPerLevel * depotLevel) +
      OUTPOST.storagePerLevel * outpostLevels,
  );
}

export function vaultProtection(
  citadelLevel: number,
  depotLevel: number,
  /**
   * 只用到 `vault` 這一項，所以型別只要求那一個欄位 ——
   * 呼叫端可以傳整份 `SEASON_MODIFIERS[s]`，也可以只傳 `{ vault: 2 }`。
   */
  season?: Pick<SeasonModifiers, "vault">,
): number {
  const base =
    300 + CORE_BUILDING_EFFECT.depotVaultPerLevel * depotLevel + 30 * citadelLevel;
  return Math.round(base * (season?.vault ?? 1));
}

// ─────────────────────────────────────────────────────────────
// 軍隊
// ─────────────────────────────────────────────────────────────

/** 招募一個單位的**真實秒數**（已套用兵營加成與 TIME_SCALE） */
export function trainSeconds(
  unit: Unit,
  producerLevel: number,
  season?: SeasonModifiers,
): number {
  const speedup = 1 + CORE_BUILDING_EFFECT.barracksTrainSpeedPerLevel * producerLevel;
  return (
    UNIT[unit].trainSeconds / speedup / TIME_SCALE / (season?.training ?? 1)
  );
}

/** 部隊的糧耗（每真實小時），已套用 TIME_SCALE 與季節、超限懲罰 */
export function upkeepPerHour(
  army: Partial<Record<Unit, number>>,
  opts: { season?: SeasonModifiers; overSupplied?: boolean } = {},
): number {
  let base = 0;
  for (const [unit, n] of Object.entries(army)) {
    base += UNIT[unit as Unit].upkeep * (n ?? 0);
  }
  return (
    base *
    TIME_SCALE *
    (opts.season?.upkeep ?? 1) *
    (opts.overSupplied ? REGION_CAPACITY.overflowUpkeepMultiplier : 1)
  );
}

export function armyPopulation(army: Partial<Record<Unit, number>>): number {
  let total = 0;
  for (const [unit, n] of Object.entries(army)) {
    total += UNIT[unit as Unit].population * (n ?? 0);
  }
  return total;
}

export function armyCarry(army: Partial<Record<Unit, number>>): number {
  let total = 0;
  for (const [unit, n] of Object.entries(army)) {
    total += UNIT[unit as Unit].carry * (n ?? 0);
  }
  return total;
}

// ─────────────────────────────────────────────────────────────
// 科技
// ─────────────────────────────────────────────────────────────

export function techCost(tech: Tech, level: number): ResourceBundle {
  const mult = TECH_SCALING.costGrowth ** (level - 1);
  const out: ResourceBundle = {};
  for (const [k, v] of Object.entries(TECH[tech].cost)) {
    out[k as Resource] = Math.round(v * mult);
  }
  return out;
}

export function techSeconds(tech: Tech, level: number, archiveLevel: number): number {
  const speedup = 1 + CORE_BUILDING_EFFECT.archiveResearchSpeedPerLevel * archiveLevel;
  return (
    (TECH[tech].baseSeconds * TECH_SCALING.timeGrowth ** (level - 1)) / speedup / TIME_SCALE
  );
}

// ─────────────────────────────────────────────────────────────
// 補給：區域軍隊容納上限
// ─────────────────────────────────────────────────────────────

export interface RegionHoldings {
  /** 該聯盟在該區域的領土格數 */
  territoryTiles: number;
  /** 該區域內前哨營的等級總和 */
  outpostLevels: number;
  /** 該區域內核心據點的主堡等級總和 */
  citadelLevels: number;
}

/**
 * 你能在一個地方投入多少兵力，取決於你在那裡有多少基礎建設。
 *
 * 這一條同時產生了新手保護、補給線、防守優勢與戰爭節奏。
 */
export function regionCapacity(
  holdings: RegionHoldings,
  season?: SeasonModifiers,
): number {
  const base =
    REGION_CAPACITY.base +
    REGION_CAPACITY.perTerritoryTile * holdings.territoryTiles +
    REGION_CAPACITY.perOutpostLevel * holdings.outpostLevels +
    REGION_CAPACITY.perCitadelLevel * holdings.citadelLevels;
  return Math.round(base * (season?.regionCapacity ?? 1));
}

/** 超限時每小時損失的人口。未超限回傳 0。 */
export function overflowAttrition(stationed: number, capacity: number): number {
  const excess = stationed - capacity;
  if (excess <= 0) return 0;
  return excess * REGION_CAPACITY.overflowAttritionPerHour;
}

export function outpostRegionContribution(outpostLevel: number): number {
  return OUTPOST.regionCapacityPerLevel * outpostLevel;
}

// ─────────────────────────────────────────────────────────────
// 行軍速度（供 march.ts 使用）
// ─────────────────────────────────────────────────────────────

/** 部隊的實際速度（格 / 真實小時）= 最慢單位 × MARCH_SCALE × 加成 */
export function armySpeed(
  army: Partial<Record<Unit, number>>,
  opts: { techBonus?: number; stableBonus?: number; ruinBonus?: number } = {},
): number {
  let slowest = Infinity;
  let allCavalry = true;
  for (const [unit, n] of Object.entries(army)) {
    if (!n) continue;
    const spec = UNIT[unit as Unit];
    slowest = Math.min(slowest, spec.speed);
    if (spec.attackClass !== "CAVALRY") allCavalry = false;
  }
  if (!Number.isFinite(slowest)) return 0;

  const bonus =
    1 +
    (opts.techBonus ?? 0) +
    (allCavalry ? (opts.stableBonus ?? 0) : 0) +
    (opts.ruinBonus ?? 0);

  return slowest * MARCH_SCALE * bonus;
}
