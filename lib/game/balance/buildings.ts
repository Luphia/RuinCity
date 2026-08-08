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
  /**
   * ★ 33（原 30）。
   *
   * 賽季模擬顯示中位數玩家在賽季結束時走完 **85%** 的發展度，
   * 而第 80 百分位是 86% —— 兩者只差 1 個百分點。
   * 也就是說天花板不但摸得到，摸到之後**多打也沒有用**：
   * 99% 的人頂到領土上限、94% 頂到設施上限，剩下的產出直接蒸發。
   *
   * 設計目標改為「**80% 的玩家只走得完 80%**」，天花板要看得見、摸不到。
   * 見 `docs/11` §14。
   */
  maxLevel: 33,
  /**
   * ★ growth 1.28 → 1.36（鐵 1.30 → 1.38）。
   *   賽季模擬顯示原曲線太淺：中位數玩家在遊戲月 6 就把主堡推到 26、
   *   月 7 之後整個經濟完全飽和，賽季後半沒有任何經濟推進可言。
   *   拉陡成長率會壓住中後期而幾乎不動早期，正好對上 `docs/03` §6 的目標曲線。
   */
  cost: {
    timber: { base: 120, growth: 1.36 },
    stone: { base: 100, growth: 1.36 },
    iron: { base: 40, growth: 1.38 },
  },
  /**
   * 基準秒數，實際 = base × growth^(L-1) / TIME_SCALE。
   *
   * ★ base 780（原 300）：`docs/02` §1.1 與 `docs/11` §1 都寫「Lv1→Lv30
   *   約 7 天純建造時間，佔滿這條佇列」，但 base 300 只給得出 2.7 天。
   *   賽季模擬顯示核心佇列只有 18% 的時間在動工 ——「每一分鐘你在升主堡，
   *   就是一分鐘你沒在升兵營」這個核心取捨因此根本不存在。780 讓
   *   Lv1→Lv30 剛好是 7.05 真實天，與文件敘述一致。
   */
  time: { base: 780, growth: 1.26 },

  /**
   * 領土容量 = 4 × 主堡等級。
   *
   * ★ 3 → 4。-b 版把它從 4 降到 3 是為了壓住領土數，但那讓 **99% 的玩家
   *   在賽季末頂在容量上限**——地圖上明明還有地，制度卻不讓你拿。
   *   改回 4 之後綁住玩家的變成**周圍實際可用的地**（中位數 100 塊、
   *   最少 36 塊、最多 438 塊），出生點的地理條件因此真的有意義：
   *   領土這一軸的 P50/P80 從 87/87 拉開到 57/76。
   */
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
  "FORTRESS",
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

/**
 * ★ 產出係數下調（伐木場／採石場 10 → 7.5，鐵礦坑 7 → 5.25，農田 10 → 9.75）。
 *
 *   原值下四種資源全季長期頂在倉庫上限，`docs/03` §7.2 說的「五道閘門」
 *   裡最重要的資源那一道形同虛設。
 *
 *   農田砍得比其他三者輕，是因為**糧食與建材餵的是不同的東西**：
 *   建材餵主堡曲線，糧食餵軍隊規模。兩者同幅下調時，
 *   主堡曲線與軍隊曲線會互相拉扯，永遠只能滿足其中一條。
 *   分開調之後兩條才同時落在 `docs/03` §6 的目標區間內。
 */
export const FACILITY: Record<Facility, FacilitySpec> = {
  FARM: { label: "農田", cost: { timber: 100 }, yields: "grain", yieldCoefficient: 9.75 },
  SAWMILL: { label: "伐木場", cost: { timber: 80, stone: 40 }, yields: "timber", yieldCoefficient: 7.5 },
  QUARRY: { label: "採石場", cost: { timber: 120 }, yields: "stone", yieldCoefficient: 7.5 },
  MINE: { label: "鐵礦坑", cost: { timber: 150, stone: 100 }, yields: "iron", yieldCoefficient: 5.25 },
  WATCHTOWER: { label: "哨塔", cost: { timber: 200, stone: 200 }, yields: null, yieldCoefficient: 0 },
  OUTPOST: { label: "前哨營", cost: { timber: 500, stone: 500, iron: 300 }, yields: null, yieldCoefficient: 0 },
  MARKET: { label: "集市", cost: { timber: 300, stone: 200 }, yields: null, yieldCoefficient: 0 },
  /**
   * ★ 要塞（`docs/02` §2.6）：把領地旗換成要塞石塔，並成為路網節點。
   *   它不產出任何東西 —— 它買的是**耐久**與**速度**。
   *   造價刻意比前哨營便宜、比哨塔貴：每一格都想蓋要塞會破產，
   *   但守住幾條要道是負擔得起的。
   */
  FORTRESS: { label: "要塞", cost: { timber: 400, stone: 600, iron: 200 }, yields: null, yieldCoefficient: 0 },
} as const;

export const FACILITY_SCALING = {
  /** 成本 = 基礎 × 1.36^(L-1)（原 1.32，理由同主堡成本曲線） */
  costGrowth: 1.36,
  /** 基準秒數 = 240 × 1.30^(L-1) */
  time: { base: 240, growth: 1.3 },
  /** 產出指數 */
  yieldExponent: 1.35,
  /**
   * 等級上限 = ⌊主堡等級 / 1.6⌋（原 / 2）。
   *
   * ★ 舊值下 94% 的玩家在賽季末頂到設施上限，之後產出無處可去。
   *   放寬到 1.6 之後只剩 34%，後期還有東西可以推。
   */
  levelCapDivisor: 1.6,
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
  /**
   * 成本與時間隨已有領土遞增。
   * ★ v2（docs/11 §22.4）收緊 15 → 8：格子自己會生產之後，
   *   「地換錢、錢換地」的雪球必須有更陡的煞車 ——
   *   模擬顯示 15 之下月 3 領土衝到 62（目標 16–26）。
   */
  costGrowthDivisor: 8,
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
