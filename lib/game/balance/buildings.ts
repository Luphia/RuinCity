/**
 * 主堡、核心建築、領土設施。
 * 對應 docs/02-base-territory.md 與 docs/11-balance-tables.md §1–4。
 *
 * 所有「時間」欄位為**基準秒數**，實際值需除以 TIME_SCALE。
 * 所有「成本」欄位為實際值，不套用任何係數。
 */

// ─────────────────────────────────────────────────────────────
// 主堡 Citadel（固定於核心據點 A 格）
// ─────────────────────────────────────────────────────────────

export const CITADEL = {
  maxLevel: 30,
  cost: {
    timber: { base: 120, growth: 1.28 },
    stone: { base: 100, growth: 1.28 },
    iron: { base: 40, growth: 1.3 },
  },
  /** 基準秒數，實際 = base × growth^(L-1) / TIME_SCALE */
  time: { base: 300, growth: 1.26 },

  /** 領土容量 = 4 × 主堡等級 */
  territoryCapacityPerLevel: 4,
  /** 人口天花板 = 60 × 主堡等級^1.15 */
  popCap: { coefficient: 60, exponent: 1.15 },
  /** 據點固有防禦 = 主堡等級 × 120（不需城牆，見 16 §4.1） */
  innateDefensePerLevel: 120,
  /** 據點駐軍上限 = 1000 + 400 × 主堡等級 */
  garrisonCap: { base: 1000, perLevel: 400 },
  /** 領土設施佇列 = 1 + ⌊主堡等級 / 10⌋ */
  territoryQueues: { base: 1, per: 10, max: 4 },
  /** 前哨營上限 = ⌊主堡等級 / 6⌋ */
  outpostCap: { per: 6 },
  /** 執政官可同時啟用的方針數 = 1 + ⌊主堡等級 / 8⌋ */
  stewardDirectives: { base: 1, per: 8, max: 3 },
  /** 主堡基礎產出（每種資源）= 5 × 主堡等級 /h，保底不會餓死 */
  baseYieldPerLevel: 5,
  /** 儲存上限加成 */
  capacityPerLevel: 150,
} as const;

/**
 * ★ 核心建造佇列**永遠只有一條**，主堡與 B/C/D 共用，
 * 且不會因為任何等級、科技或付費而增加。
 *
 * 這是整個遊戲最尖銳的取捨點：
 * 每一分鐘你在升級主堡，就是一分鐘你沒有在升級兵營。
 */
export const CORE_QUEUE_COUNT = 1 as const;

// ─────────────────────────────────────────────────────────────
// 核心建築（B / C / D 三格，7 選 3）
// ─────────────────────────────────────────────────────────────

export const CORE_BUILDINGS = [
  "BARRACKS",
  "STABLE",
  "WORKSHOP",
  "DEPOT",
  "ARCHIVE",
  "RAMPART",
  "INFIRMARY",
] as const;
export type CoreBuilding = (typeof CORE_BUILDINGS)[number];

export interface CoreBuildingSpec {
  readonly label: string;
  /** 成本與時間相對於主堡同級的係數 */
  readonly factor: number;
  readonly effect: string;
}

export const CORE_BUILDING: Record<CoreBuilding, CoreBuildingSpec> = {
  BARRACKS: { label: "兵營", factor: 0.7, effect: "解鎖步／弓兵；招募速度 +5%/等級" },
  STABLE: { label: "獸廄", factor: 0.9, effect: "解鎖騎兵；騎兵行軍速度 +2%/等級" },
  WORKSHOP: { label: "工坊", factor: 1.1, effect: "解鎖攻城單位；攻城傷害 +4%/等級" },
  DEPOT: { label: "倉庫", factor: 0.6, effect: "資源上限 +40%/等級；地窖 +80/等級" },
  ARCHIVE: { label: "檔案館", factor: 1.0, effect: "解鎖科技樹；研究速度 +6%/等級" },
  RAMPART: { label: "城牆", factor: 0.8, effect: "據點防禦 +8%/等級" },
  INFIRMARY: { label: "醫療帳", factor: 0.75, effect: "防守傷兵回收 25% + 2%/等級" },
} as const;

export const CORE_BUILDING_EFFECT = {
  barracksTrainSpeedPerLevel: 0.05,
  stableCavalrySpeedPerLevel: 0.02,
  workshopSiegeDamagePerLevel: 0.04,
  depotCapacityPerLevel: 0.4,
  depotVaultPerLevel: 80,
  archiveResearchSpeedPerLevel: 0.06,
  rampartDefensePerLevel: 0.08,
  infirmaryRecoveryBase: 0.25,
  infirmaryRecoveryPerLevel: 0.02,
  infirmaryRecoveryMax: 0.6,
} as const;

/** 拆除：可以轉型，但不能在每次被打之前臨時換 build */
export const DEMOLISH = {
  /** 基準秒數（12 小時 × TIME_SCALE，實際除回來是 3 小時） */
  baseSeconds: 12 * 60 * 60,
  refundRatio: 0.3,
  /** 基準秒數的冷卻 */
  cooldownSeconds: 24 * 60 * 60,
} as const;

// ─────────────────────────────────────────────────────────────
// 領土設施（每塊領土 1 個）
// ─────────────────────────────────────────────────────────────

export const FACILITIES = [
  "FARM",
  "SAWMILL",
  "QUARRY",
  "MINE",
  "WATCHTOWER",
  "OUTPOST",
  "MARKET",
] as const;
export type Facility = (typeof FACILITIES)[number];

export interface FacilitySpec {
  readonly label: string;
  readonly cost: Readonly<Partial<Record<"timber" | "stone" | "iron" | "grain", number>>>;
  /** 產出資源，null = 非產出設施 */
  readonly yields: "grain" | "timber" | "stone" | "iron" | null;
  /** 產出係數：yield = coefficient × level^1.35 */
  readonly yieldCoefficient: number;
}

export const FACILITY: Record<Facility, FacilitySpec> = {
  FARM: { label: "農田", cost: { timber: 100 }, yields: "grain", yieldCoefficient: 10 },
  SAWMILL: { label: "伐木場", cost: { timber: 80, stone: 40 }, yields: "timber", yieldCoefficient: 10 },
  QUARRY: { label: "採石場", cost: { timber: 120 }, yields: "stone", yieldCoefficient: 10 },
  MINE: { label: "鐵礦坑", cost: { timber: 150, stone: 100 }, yields: "iron", yieldCoefficient: 7 },
  WATCHTOWER: { label: "哨塔", cost: { timber: 200, stone: 200 }, yields: null, yieldCoefficient: 0 },
  OUTPOST: { label: "前哨營", cost: { timber: 500, stone: 500, iron: 300 }, yields: null, yieldCoefficient: 0 },
  MARKET: { label: "集市", cost: { timber: 300, stone: 200 }, yields: null, yieldCoefficient: 0 },
} as const;

export const FACILITY_SCALING = {
  /** 成本 = 基礎 × 1.32^(L-1) */
  costGrowth: 1.32,
  /** 基準秒數 = 240 × 1.30^(L-1) */
  time: { base: 240, growth: 1.3 },
  /** 產出指數 */
  yieldExponent: 1.35,
  /** 等級上限 = ⌊主堡等級 / 2⌋ */
  levelCapDivisor: 2,
  /** 領土格固有防禦 = 設施等級 × 30 */
  innateDefensePerLevel: 30,
  /** 領土格駐軍上限 = 200 + 300 × 設施等級 */
  garrisonCap: { base: 200, perLevel: 300 },
} as const;

export const WATCHTOWER = {
  /** 固定防禦 = 200 × 等級 */
  defensePerLevel: 200,
  /** 視野 = 4 + 等級 */
  visionBase: 4,
  /** 有哨塔時，來襲預警從行軍時間的 40% 拉到 60% */
  warningRatio: 0.6,
} as const;

export const OUTPOST = {
  /** 儲存上限 = 5000 × 等級 */
  storagePerLevel: 5000,
  /** 維護費（基準值，套用 TIME_SCALE 後為 −200/h） */
  upkeepGrainPerHour: 50,
  /** 駐軍上限 = 1500 + 1200 × 等級 */
  garrisonCap: { base: 1500, perLevel: 1200 },
  /** 對區域軍隊容量的貢獻 = 800 × 等級 */
  regionCapacityPerLevel: 800,
} as const;

export const MARKET = {
  /** 每位玩家上限 1 座 */
  maxPerPlayer: 1,
  /** 掛單數 = 2 × 等級 */
  listingsPerLevel: 2,
  /** 商隊速度（格/h，已含 MARCH_SCALE） */
  caravanSpeed: 60,
  /** 交易僅限同一聯盟成員；無稅 */
  taxRate: 0,
  /** 資源轉移日上限 = 500 × 主堡等級 */
  dailyTransferPerCitadelLevel: 500,
} as const;

// ─────────────────────────────────────────────────────────────
// 領土佔領
// ─────────────────────────────────────────────────────────────

export const CLAIM = {
  cost: { grain: 200, timber: 150 },
  /** 成本與時間隨已有領土遞增 */
  costGrowthDivisor: 15,
  /** 立旗基準秒數 = 1800 × 地形係數 × (1 + 領土數 / 20) */
  baseSeconds: 1800,
  timeGrowthDivisor: 20,
  /** ★ 佔領領土完全不消耗人口（領土是軍隊的來源，不是競爭者） */
  populationCost: 0,
  /** 孤立領土的產出懲罰 */
  isolatedYieldMultiplier: 0.5,
  /** 孤立多久後自動放棄（已套用 TIME_SCALE） */
  isolatedExpiryMs: 6 * 60 * 60 * 1000,
  /** 被打下後的動盪期（已套用 TIME_SCALE） */
  contestedMs: 30 * 60 * 1000,
} as const;
