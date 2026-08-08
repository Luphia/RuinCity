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
/**
 * ★ v2 廢止（docs/11 §22.4）：設施產出的地形倍率表。
 *   新模型是「格子是資源、設施是開採」—— 每格領地有自己的固定產出
 *   （`TILE_RESOURCE`），開採設施只放大對口的格子。留著只為了
 *   讓還沒搬完的呼叫端編譯得過；不要在新程式裡引用。
 */
export const TERRAIN_YIELD: Record<string, Partial<Record<Terrain, number>>> = {
  FARM: { FOREST: 0.8, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
  SAWMILL: { FOREST: 1.25, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
  QUARRY: { LODE: 1.4, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
  MINE: { LODE: 1.4, WASTE: 0.8, MARSH: 0.6, RUBBLE: 1.15 },
} as const;

/**
 * 每一格領地自己的產出（docs/02 §2.5、docs/11 §22.4）：
 * 資源種類由地形決定，量 = `base × 野地等級`（固定值，不是百分比）。
 * 荒地與山脈不產 —— 荒地的用途是蓋非產出設施。
 * 基準值按舊設施係數比例（9.75:7.5:7.5:5.25）縮放。
 */
export const TILE_RESOURCE: Partial<
  Record<Terrain, { readonly resource: "grain" | "timber" | "stone" | "iron"; readonly base: number }>
> = {
  PLAIN: { resource: "grain", base: 34 },
  FOREST: { resource: "timber", base: 31 },
  RUBBLE: { resource: "stone", base: 31 },
  LODE: { resource: "iron", base: 22 },
  MARSH: { resource: "grain", base: 17 },
} as const;

/** 開採設施的倍率：1 + 4 × min(1, 等級/20) —— 滿級恰好 ×5（docs/11 §22.4） */
export const EXTRACTION = {
  maxMultiplier: 5,
  capLevel: 20,
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

/**
 * 廢土營地（PvE）。
 *
 * `docs/01` §7 說營地是「新手期與非戰鬥玩家的主要成長管道」，
 * 但守軍與獎勵的數字一直沒定過 —— 下面這組是 `-e` 版補上的。
 *
 * ## 設計原則
 *
 * 1. **早期是主要收入，後期是零頭。** 全圖營地總數固定（800），
 *    所以 PvE 是一條**絕對值固定**的收入流：對第 1 天的玩家是翻倍，
 *    對第 10 天的玩家不到產出的 3%。不需要額外機制去衰減它。
 * 2. **給早期一個養兵的理由。** 春季打人不划算（見 `01` §5.4），
 *    但打營地划算 —— 這是新手唯一需要軍隊的地方，
 *    也是「用兵高峰在秋冬」之前那支軍隊的存在意義。
 * 3. **獎勵吃季節產出係數。** 冬季 ×0.70 —— 廢土也在挨餓。
 *    少了這一條，PvE 收入完全不受季節影響，冬季的糧食擠壓就被抵消掉：
 *    賽季模擬顯示收支轉負的玩家從 66% 掉到 31%、餓死的人歸零，
 *    「用兵高峰在秋冬」的驅動力整個消失。
 * 4. **高階營地的 CP 值遞減。** 守軍 ×1.5/級、獎勵只有 ×1.4/級 ——
 *    Lv1 的獎勵／守軍是 120，Lv10 只剩 65。清高階營地依然值得
 *    （一趟拿得多），但它不會變成後期的提款機。
 */
export const CAMPS = {
  /** 全圖維持的活躍營地數 */
  target: 800,
  /** 補充間隔（已套用 TIME_SCALE：6h ÷ 4） */
  respawnMs: 90 * 60 * 1000,
  maxLevel: 10,

  /** 守軍人口 = base × growth^(L-1) */
  garrison: { base: 25, growth: 1.5 },
  /**
   * 弓手佔守軍的比例 = 0.05 × 等級（上限 0.5），其餘是民兵。
   *
   * ★ 低階營地必須**真的很弱**。弓手對步兵防禦 62、民兵只有 12，
   *   固定四成弓手會讓 Lv1 營地的防禦力比它的獎勵值錢 ——
   *   而新手手上只有民兵（攻擊 10）。賽季模擬顯示那樣的 Lv1 營地
   *   要用 300 名民兵去清才划算，等於兩天的產出，
   *   `01` §7 的「新手期主要成長管道」完全不成立。
   */
  archerSharePerLevel: 0.05,
  archerShareMax: 0.5,
  /** 營寨的固有防禦 = 80 × 等級 */
  innateDefensePerLevel: 80,

  /** 清空獎勵，**每種資源** = base × growth^(L-1) */
  reward: { base: 2000, growth: 1.4 },
  /** Lv6 以上才掉遺物，數量 = ⌊等級 / 3⌋ */
  relicFromLevel: 6,

  /**
   * 等級分佈：權重 = decay^(L-1)，低階佔多數。
   * 前線出生帶周邊 +3 級（`SPAWN_BAND.campLevelBonus`）——
   * 遺物來源更近，代價是夏季一解封就是戰場中心。
   */
  levelWeightDecay: 0.92,
} as const;

// ─────────────────────────────────────────────────────────────
// 野地與征服（docs/02 §2.5、docs/11 §22）
// ─────────────────────────────────────────────────────────────

/**
 * 真人與真人的最小出生間距（切比雪夫，>10 格）。
 *
 * ★ 只管真人（`users` 表有帳號的）：全服 600 人一律 11 在幾何上不可行
 *   —— 中原帶的最密堆疊上限約 68 席，配額卻是 100（`11` §22.1 的算術）。
 *   AI 之間維持 `HARD_MIN_SPACING`。同行小隊豁免（自願聚落）。
 */
export const HUMAN_MIN_SPACING = 11;

/** 野地：無主格的等級、守衛與生產加成 */
export const WILDS = {
  maxLevel: 5,
  /** 等級權重 = decay^(L-1)：lv1 ≈ 56%、lv2 ≈ 25%、lv3 ≈ 11%、lv4 ≈ 5%、lv5 ≈ 2% */
  levelWeightDecay: 0.45,
  /** 稀有地形（LODE、MARSH）+1 級，封頂 maxLevel */
  richTerrainBonus: 1,
  /** 這一級（含）以上有守衛，要打下來才佔得到；以下可立旗 */
  guardedFromLevel: 2,

  /** 守衛人口 = base × growth^(L-1) × (1 + 距離 / distanceDivisor) */
  garrison: { base: 12, growth: 1.7 },
  distanceDivisor: 40,
  /** 弓手比例 = perLevel × L，封頂 shareMax；其餘民兵 */
  archerSharePerLevel: 0.08,
  archerShareMax: 0.4,
  /** 巢穴固有防禦 = perLevel × L */
  innateDefensePerLevel: 30,

} as const;
