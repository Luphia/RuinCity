/**
 * 兵種、科技與人口。
 * 對應 docs/04-military-combat.md 與 docs/11-balance-tables.md §5–6。
 *
 * `speed` 為表定值，實際 = speed × MARCH_SCALE。
 * `trainSeconds` 為基準值，實際 = base / (1 + 0.05 × 建築等級) / TIME_SCALE。
 * `upkeep` 為基準值，實際 = upkeep × TIME_SCALE × 季節係數。
 */

export const UNITS = [
  "MILITIA",
  "SCOUT",
  "SPEARMAN",
  "SWORDSMAN",
  "ARCHER",
  "RAIDER",
  "LANCER",
  "RAM",
  "CATAPULT",
  "WASTE_GUARD",
  "RUIN_WATCHER",
] as const;
export type Unit = (typeof UNITS)[number];

export type AttackClass = "INFANTRY" | "CAVALRY" | "SIEGE" | "NONE";

export interface UnitSpec {
  readonly label: string;
  readonly attackClass: AttackClass;
  readonly cost: Readonly<{
    grain: number;
    timber: number;
    stone: number;
    iron: number;
    relic: number;
  }>;
  /** 基準訓練秒數 */
  readonly trainSeconds: number;
  readonly attack: number;
  /** 對步兵防禦 */
  readonly defInfantry: number;
  /** 對騎兵防禦 */
  readonly defCavalry: number;
  /** 表定速度（格/h） */
  readonly speed: number;
  readonly carry: number;
  readonly population: number;
  /** 基準糧耗 /h */
  readonly upkeep: number;
  /** 前置建築與等級 */
  readonly requires: readonly [string, number] | null;
}

export const UNIT: Record<Unit, UnitSpec> = {
  MILITIA: {
    label: "民兵", attackClass: "INFANTRY",
    cost: { grain: 40, timber: 30, stone: 0, iron: 10, relic: 0 },
    trainSeconds: 60, attack: 10, defInfantry: 12, defCavalry: 8,
    speed: 24, carry: 25, population: 1, upkeep: 1, requires: null,
  },
  SCOUT: {
    label: "偵查兵", attackClass: "NONE",
    cost: { grain: 30, timber: 20, stone: 0, iron: 20, relic: 0 },
    trainSeconds: 90, attack: 0, defInfantry: 0, defCavalry: 0,
    speed: 50, carry: 0, population: 1, upkeep: 1, requires: ["BARRACKS", 3],
  },
  SPEARMAN: {
    label: "長矛兵", attackClass: "INFANTRY",
    cost: { grain: 60, timber: 50, stone: 0, iron: 30, relic: 0 },
    trainSeconds: 150, attack: 12, defInfantry: 20, defCavalry: 55,
    speed: 22, carry: 40, population: 1, upkeep: 1, requires: ["BARRACKS", 1],
  },
  SWORDSMAN: {
    label: "劍士", attackClass: "INFANTRY",
    cost: { grain: 90, timber: 40, stone: 0, iron: 90, relic: 0 },
    trainSeconds: 240, attack: 48, defInfantry: 40, defCavalry: 22,
    speed: 20, carry: 50, population: 1, upkeep: 1, requires: ["BARRACKS", 5],
  },
  ARCHER: {
    label: "弓手", attackClass: "INFANTRY",
    cost: { grain: 70, timber: 90, stone: 0, iron: 50, relic: 0 },
    trainSeconds: 210, attack: 20, defInfantry: 62, defCavalry: 42,
    speed: 22, carry: 35, population: 1, upkeep: 1, requires: ["BARRACKS", 7],
  },
  RAIDER: {
    label: "掠奪騎兵", attackClass: "CAVALRY",
    cost: { grain: 150, timber: 60, stone: 0, iron: 100, relic: 0 },
    trainSeconds: 330, attack: 42, defInfantry: 18, defCavalry: 12,
    speed: 40, carry: 140, population: 2, upkeep: 3, requires: ["STABLE", 3],
  },
  LANCER: {
    label: "重騎兵", attackClass: "CAVALRY",
    cost: { grain: 220, timber: 80, stone: 0, iron: 240, relic: 0 },
    trainSeconds: 600, attack: 90, defInfantry: 30, defCavalry: 25,
    speed: 32, carry: 80, population: 2, upkeep: 3, requires: ["STABLE", 10],
  },
  RAM: {
    label: "攻城車", attackClass: "SIEGE",
    cost: { grain: 100, timber: 400, stone: 150, iron: 200, relic: 0 },
    trainSeconds: 900, attack: 60, defInfantry: 25, defCavalry: 30,
    speed: 12, carry: 0, population: 5, upkeep: 4, requires: ["WORKSHOP", 1],
  },
  CATAPULT: {
    label: "投石機", attackClass: "SIEGE",
    cost: { grain: 120, timber: 600, stone: 400, iron: 300, relic: 0 },
    trainSeconds: 1500, attack: 80, defInfantry: 20, defCavalry: 22,
    speed: 10, carry: 0, population: 5, upkeep: 4, requires: ["WORKSHOP", 8],
  },
  WASTE_GUARD: {
    label: "廢土衛隊", attackClass: "INFANTRY",
    cost: { grain: 300, timber: 150, stone: 100, iron: 400, relic: 8 },
    trainSeconds: 1200, attack: 110, defInfantry: 95, defCavalry: 90,
    speed: 24, carry: 60, population: 3, upkeep: 5, requires: ["ARCHIVE", 15],
  },
  RUIN_WATCHER: {
    label: "遺跡守望者", attackClass: "CAVALRY",
    cost: { grain: 400, timber: 180, stone: 120, iron: 550, relic: 14 },
    trainSeconds: 1800, attack: 150, defInfantry: 60, defCavalry: 55,
    speed: 30, carry: 100, population: 3, upkeep: 5, requires: ["ARCHIVE", 20],
  },
} as const;

/** 主動解散部隊返還的人口比例；陣亡則完全不返還 */
export const DISBAND_POPULATION_REFUND = 0.5;

// ─────────────────────────────────────────────────────────────
// 人口：一種會累積的資源
// ─────────────────────────────────────────────────────────────

/**
 * 主堡管上限、領土管補血。
 *
 * 高主堡低領土 → 軍隊上限大，但打光了補不回來（一場敗仗就出局）
 * 低主堡高領土 → 軍隊上限小，但源源不絕（消耗戰之王）
 */
export const POPULATION = {
  /**
   * 天花板 = 72 × 主堡等級^1.15（係數原為 60）。
   *
   * ★ 提高天花板不是為了讓大家養更多兵——絕大多數玩家是被**糧食**
   *   卡住而不是被人口上限卡住。提高它是為了讓那些真的養得起的人
   *   還有空間可長：兵力這一軸的 P50/P80 因此是 46/72，
   *   是整份發展度指標裡差距最大的一條。
   */
  cap: { coefficient: 72, exponent: 1.15 },
  /** 成長率 = (1.5 + 0.3 × 主堡等級) × (1 + 領土數 / 30) 人/小時（已含 TIME_SCALE） */
  growth: { base: 1.5, perCitadelLevel: 0.3, territoryDivisor: 30 },
  /** 陣亡不返還 —— 人口是一條會被戰爭消耗的河，不是可反覆使用的容器 */
  refundOnDeath: 0,
} as const;

// ─────────────────────────────────────────────────────────────
// 科技（檔案館解鎖）
// ─────────────────────────────────────────────────────────────

export const TECHS = [
  "FORGING",
  "PLATING",
  "MARCHING",
  "CULTIVATION",
  "EXTRACTION",
  "LOGISTICS",
  "SIEGECRAFT",
  "RELICRAFT",
] as const;
export type Tech = (typeof TECHS)[number];

export interface TechSpec {
  readonly label: string;
  readonly maxLevel: number;
  /** 每級效果 */
  readonly perLevel: number;
  readonly cost: Readonly<Partial<Record<"grain" | "timber" | "stone" | "iron" | "relic", number>>>;
  /** 基準秒數 */
  readonly baseSeconds: number;
}

export const TECH: Record<Tech, TechSpec> = {
  FORGING: { label: "鍛造", maxLevel: 10, perLevel: 0.03, cost: { iron: 400 }, baseSeconds: 600 },
  PLATING: { label: "甲冑", maxLevel: 10, perLevel: 0.03, cost: { iron: 400, stone: 200 }, baseSeconds: 600 },
  MARCHING: { label: "行軍", maxLevel: 8, perLevel: 0.03, cost: { timber: 300, grain: 300 }, baseSeconds: 900 },
  CULTIVATION: { label: "耕作", maxLevel: 12, perLevel: 0.04, cost: { timber: 200 }, baseSeconds: 480 },
  EXTRACTION: { label: "開採", maxLevel: 12, perLevel: 0.04, cost: { timber: 250, stone: 250 }, baseSeconds: 480 },
  LOGISTICS: { label: "補給", maxLevel: 8, perLevel: 0.06, cost: { timber: 350 }, baseSeconds: 720 },
  SIEGECRAFT: { label: "攻城術", maxLevel: 6, perLevel: 0.08, cost: { timber: 800, iron: 600 }, baseSeconds: 1800 },
  RELICRAFT: { label: "遺物工藝", maxLevel: 5, perLevel: 0.1, cost: { relic: 20, iron: 1000 }, baseSeconds: 3600 },
} as const;

export const TECH_SCALING = {
  costGrowth: 2.1,
  timeGrowth: 2.0,
} as const;
