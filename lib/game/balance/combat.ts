/**
 * 戰鬥、行軍、補給與區域容量。
 * 對應 docs/04-military-combat.md、docs/16-supply-and-attrition.md。
 */

// ─────────────────────────────────────────────────────────────
// 行軍
// ─────────────────────────────────────────────────────────────

export const MARCH = {
  /** 防止貼臉玩家瞬間互殺，並保證預警窗口不為零 */
  minSeconds: 180,
  /** 超過即無法派遣 —— 跨陣營攻城遠征在物理上不可能直達，必須靠前哨營接力 */
  maxSeconds: 8 * 60 * 60,
  /** 沿起訖直線的地形取樣點數上限 */
  terrainSampleCap: 64,
} as const;

/**
 * 來襲預警：固定 30 分鐘在短程行軍下不可能成立
 * （隔壁鄰居總行軍只有 15 分鐘），因此改為按比例計算。
 *
 * 副作用是強化了地理意義：遠方來的敵人你看得早，
 * 隔壁鄰居的突襲幾乎是瞬間的 ——
 * 這讓「跟鄰居維持關係」比「築牆」更重要。
 */
export const WARNING = {
  ratio: 0.4,
  minSeconds: 3 * 60,
  maxSeconds: 30 * 60,
  watchtowerRatio: 0.6,
  watchtowerMinSeconds: 5 * 60,
  watchtowerMaxSeconds: 45 * 60,
} as const;

export const MARCH_TYPES = [
  "RAID",
  "ATTACK",
  "SCOUT",
  "CLAIM",
  "REINFORCE",
  "GARRISON",
  "RETURN",
] as const;
export type MarchType = (typeof MARCH_TYPES)[number];

// ─────────────────────────────────────────────────────────────
// 戰鬥
// ─────────────────────────────────────────────────────────────

export const COMBAT = {
  /** 損失曲線指數：險勝要付出慘痛代價，碾壓才划算 */
  lossExponent: 1.5,

  /**
   * 士氣指數。同時套用於**攻方戰力與攻方掠奪量** ——
   * 這是廢除新手保護期後的核心補償機制。
   */
  moraleExponent: 0.35,
  /** 攻擊人口低於自己此比例的玩家 → 不計任何賽季積分 */
  noScoreRatio: 1 / 5,

  /** 突襲：雙方損失都打折，低風險低回報 */
  raidLossMultiplier: 0.6,

  /** 城牆每級防禦加成 */
  rampartDefensePerLevel: 0.08,
  /** 無攻城單位攻打有城牆的據點：攻方戰力懲罰 */
  noSiegePenaltyPerWallLevel: 0.05,
  noSiegePenaltyMax: 0.5,

  /** 混合兵種時，守方防禦按騎兵佔比加權，避免二元跳變 */
  cavalryMixThreshold: 0.4,

  /** 建築破壞 */
  ramsPerExtraWallLevel: 20,
  wallDamageMax: 3,
  catapultsPerExtraBuildingLevel: 15,
  buildingDamageMax: 3,
} as const;

export const SCOUTING = {
  exponent: 1.5,
  watchtowerBonusPerLevel: 0.1,
  unitCountError: 0.1,
  resourceError: 0.15,
} as const;

// ─────────────────────────────────────────────────────────────
// 掠奪與保護
// ─────────────────────────────────────────────────────────────

export const RAIDING = {
  /** 地窖保護量（春季 ×2） */
  vault: { base: 300, perDepotLevel: 80, perCitadelLevel: 30 },
  /** 重複劫掠遞減：同一攻方對同一守方 */
  diminishing: { factor: 0.6, windowMs: 6 * 60 * 60 * 1000 },
  /** 連續被同一人打幾次後出現「求援」按鈕 */
  distressAfterHits: 3,
} as const;

// ─────────────────────────────────────────────────────────────
// ★ 補給：區域軍隊容納上限
//
// 核心原則：你能在一個地方投入多少兵力，
// 取決於你在那裡有多少基礎建設。
//
// 這一條同時產生了新手保護、補給線、防守優勢與戰爭節奏。
// ─────────────────────────────────────────────────────────────

export const REGION_CAPACITY = {
  /** 基礎容量（無需任何建設） */
  base: 2000,
  perTerritoryTile: 150,
  perOutpostLevel: 800,
  perCitadelLevel: 100,

  /** 超限懲罰：不是硬性禁止，是持續失血 */
  overflowAttritionPerHour: 0.05,
  overflowUpkeepMultiplier: 1.5,
} as const;

/** 遺跡的駐軍上限（不隨等級變動） */
export const RUIN_GARRISON_CAP = 3000;
