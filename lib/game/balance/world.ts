/**
 * 世界、地形、區域與出生分配。
 * 對應 docs/01-world-map.md 與 docs/13-season-registration.md。
 */

// ─────────────────────────────────────────────────────────────
// 地圖
// ─────────────────────────────────────────────────────────────

export const MAP = {
  width: 500,
  height: 500,
  /** 邊界為「深淵」，不可通行、不可佔領 */
  edgeMargin: 10,
} as const;

export const TERRAINS = [
  "PLAIN",
  "RUBBLE",
  "FOREST",
  "WASTE",
  "LODE",
  "MARSH",
  "MOUNTAIN",
] as const;
export type Terrain = (typeof TERRAINS)[number];

export interface TerrainSpec {
  readonly label: string;
  /** 生成佔比 */
  readonly share: number;
  /** 行軍係數；null = 不可通行 */
  readonly marchFactor: number | null;
  /** 守方防禦加成 */
  readonly defenseBonus: number;
  /** 可否建立據點 */
  readonly buildable: boolean;
}

export const TERRAIN: Record<Terrain, TerrainSpec> = {
  PLAIN: { label: "平原", share: 0.42, marchFactor: 1.0, defenseBonus: 0, buildable: true },
  RUBBLE: { label: "廢墟", share: 0.18, marchFactor: 1.1, defenseBonus: 0, buildable: true },
  FOREST: { label: "森林", share: 0.16, marchFactor: 1.3, defenseBonus: 0.1, buildable: true },
  WASTE: { label: "荒地", share: 0.12, marchFactor: 1.15, defenseBonus: 0, buildable: true },
  LODE: { label: "礦脈", share: 0.06, marchFactor: 1.2, defenseBonus: 0, buildable: true },
  MARSH: { label: "毒沼", share: 0.04, marchFactor: 1.8, defenseBonus: 0.15, buildable: true },
  MOUNTAIN: { label: "山脈", share: 0.02, marchFactor: null, defenseBonus: 0, buildable: false },
} as const;

/** 山脈出現在取樣路徑上時的抽象繞路懲罰（v1 不做真實 A* 尋路） */
export const MOUNTAIN_PATH_PENALTY = 2.5;

/** 設施產出的地形修正：facility → terrain → 倍率 */
export const TERRAIN_YIELD: Record<string, Partial<Record<Terrain, number>>> = {
  FARM: { FOREST: 0.8, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
  SAWMILL: { FOREST: 1.25, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
  QUARRY: { LODE: 1.4, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
  MINE: { LODE: 1.4, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
} as const;

// ─────────────────────────────────────────────────────────────
// 區域 Region（10 × 10 = 100 個 50 × 50 格）
// ─────────────────────────────────────────────────────────────

export const REGION = {
  size: 50,
  cols: 10,
  rows: 10,
  get count() {
    return this.cols * this.rows;
  },
} as const;

// ─────────────────────────────────────────────────────────────
// 三座遺跡的放置約束
// ─────────────────────────────────────────────────────────────

export const RUIN_PLACEMENT = {
  count: 3,
  /** 每座佔 3 × 3 */
  footprint: 3,
  minDistanceToEdge: 90,
  minPairDistance: 170,
  maxPairDistance: 240,
  /** 三點構成的三角形最小內角，避免擠成一直線 */
  minTriangleAngleDeg: 35,
  /** 禁建圈半徑：不可建據點、不可佔領為個人領土 */
  noBuildRadius: 12,
} as const;

// ─────────────────────────────────────────────────────────────
// 三層結構：3 陣營 × 5 聯盟 × 40 玩家 = 600
// ─────────────────────────────────────────────────────────────

export const ROSTER = {
  factions: 3,
  alliancesPerFaction: 5,
  playersPerAlliance: 40,
  get alliancesTotal() {
    return this.factions * this.alliancesPerFaction;
  },
  get playersPerFaction() {
    return this.alliancesPerFaction * this.playersPerAlliance;
  },
  get playersTotal() {
    return this.factions * this.playersPerFaction;
  },
} as const;

// ─────────────────────────────────────────────────────────────
// 出生帶
// ─────────────────────────────────────────────────────────────

export const SPAWN_BANDS = ["VANGUARD", "HEARTLAND", "FRONTIER"] as const;
export type SpawnBand = (typeof SPAWN_BANDS)[number];

export interface SpawnBandSpec {
  readonly label: string;
  /** 離該陣營遺跡的半徑範圍 */
  readonly radius: readonly [number, number];
  /** 每陣營名額 */
  readonly quota: number;
  /** 起始資源倍率 */
  readonly startingResourceMultiplier: number;
  /** 額外領土容量 */
  readonly bonusTerritoryCapacity: number;
  /** 周邊廢土營地等級加成 */
  readonly campLevelBonus: number;
}

/**
 * 沒有一個出生帶是安全的，只是危險的性質不同：
 * 前線的威脅來自**同陣營的同胞**（都想要同一座遺跡），
 * 邊陲的威脅來自**其他陣營**（你是邊防），
 * 中原最安全但也最平庸。
 */
export const SPAWN_BAND: Record<SpawnBand, SpawnBandSpec> = {
  VANGUARD: {
    label: "前線",
    radius: [20, 45],
    quota: 40,
    startingResourceMultiplier: 1.0,
    bonusTerritoryCapacity: 1,
    campLevelBonus: 3,
  },
  HEARTLAND: {
    label: "中原",
    radius: [45, 78],
    quota: 100,
    startingResourceMultiplier: 1.0,
    bonusTerritoryCapacity: 0,
    campLevelBonus: 0,
  },
  FRONTIER: {
    label: "邊陲",
    radius: [78, 105],
    quota: 60,
    startingResourceMultiplier: 1.4,
    bonusTerritoryCapacity: 0,
    campLevelBonus: 0,
  },
} as const;

/** 同行小隊：讓一群朋友一起開始，但不是一支軍隊 */
export const SQUAD = {
  maxMembers: 8,
  /** 同代碼玩家彼此的距離範圍 */
  clusterSpacing: [8, 15] as const,
} as const;

// ─────────────────────────────────────────────────────────────
// 出生點分配的公平性驗證（任一項不過 → 換 seed 重跑）
// ─────────────────────────────────────────────────────────────

export const FAIRNESS_THRESHOLDS = {
  /** (a) 每位玩家 15 格內可建設格數的全服標準差 */
  buildableTilesStdDev: 0.08,
  /** (b) 同一環帶內，玩家到最近遺跡的距離極差（格） */
  ruinDistanceRangeInBand: 20,
  /** (c) 每位玩家 30 格內的鄰居數，全服極差 */
  neighbourCountRange: 2,
  /** (d) 每位玩家 20 格內高價值地形（LODE + FOREST）格數的標準差 */
  valuableTerrainStdDev: 0.12,
  /** (e) 三個區域的可用總面積差異 */
  factionAreaDiff: 0.05,
} as const;

// ─────────────────────────────────────────────────────────────
// 開局配置
// ─────────────────────────────────────────────────────────────

export const STARTING = {
  citadelLevel: 1,
  resources: { grain: 500, timber: 500, stone: 500, iron: 200, relic: 0 },
  units: { MILITIA: 10 },
} as const;

// ─────────────────────────────────────────────────────────────
// 廢土營地（PvE）
// ─────────────────────────────────────────────────────────────

export const CAMPS = {
  /** 全圖維持的活躍營地數 */
  target: 800,
  /** 補充間隔（已套用 TIME_SCALE：6h ÷ 4） */
  respawnMs: 90 * 60 * 1000,
  maxLevel: 10,
} as const;
