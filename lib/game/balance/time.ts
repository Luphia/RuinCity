/**
 * 時間、曆法與四季。
 * 對應 docs/14-time-and-cadence.md 與 docs/11-balance-tables.md §0。
 */

// ─────────────────────────────────────────────────────────────
// 全域時間係數
// ─────────────────────────────────────────────────────────────

/**
 * 生產性時間 ÷ 4，資源流速 × 4。
 * 數值表以「48 天賽季」為基準設計，壓縮到 12 天靠這個係數，
 * 而不是逐項重寫。在讀取數值的那一層統一套用。
 */
export const TIME_SCALE = 4 as const;

/**
 * 單位速度 × 2。
 *
 * 刻意不跟 TIME_SCALE 一樣是 4：行軍時間是這個遊戲的張力來源，
 * 若鄰近突襲從 30 分鐘壓到 7.5 分鐘，預警窗口會小到毫無意義，
 * 「離線也能玩」的支柱就垮了。
 */
export const MARCH_SCALE = 2 as const;

// ─────────────────────────────────────────────────────────────
// 曆法：1 真實日 = 1 遊戲月 = 30 遊戲日
// ─────────────────────────────────────────────────────────────

export const CALENDAR = {
  /** 一個遊戲月 = 24 真實小時 */
  realMsPerGameMonth: 24 * 60 * 60 * 1000,
  /** 一個遊戲日 = 48 真實分鐘 */
  realMsPerGameDay: 48 * 60 * 1000,
  gameDaysPerMonth: 30,
  gameMonthsPerYear: 12,
  /** 賽季 = 12 遊戲月 = 1 遊戲年 = 12 真實日 */
  seasonGameMonths: 12,
  /** 廢曆的起始年份，純風味 */
  epochYear: 41,
} as const;

// ─────────────────────────────────────────────────────────────
// 四季
// ─────────────────────────────────────────────────────────────

export const SEASONS = ["SPRING", "SUMMER", "AUTUMN", "WINTER"] as const;
export type Season = (typeof SEASONS)[number];

export interface SeasonModifiers {
  /** 中文季名 */
  readonly label: string;
  /** 涵蓋的遊戲月（含頭含尾） */
  readonly months: readonly [number, number];
  /** 資源產出倍率 */
  readonly production: number;
  /** 養兵糧耗倍率 */
  readonly upkeep: number;
  /** 行軍時間倍率（> 1 代表更慢） */
  readonly marchTime: number;
  /** 招兵速度倍率（> 1 代表更快） */
  readonly training: number;
  /** 區域軍隊容納上限倍率 */
  readonly regionCapacity: number;
  /** 地窖保護量倍率 */
  readonly vault: number;
}

/**
 * 用兵高峰刻意落在 **秋冬**。
 *
 * 冬季的區域容量只小幅下修到 0.9（玩家仍打得動），
 * 改用糧食崩潰（產出 0.55、糧耗 1.40）逼他們把軍隊換成結果 ——
 * 你養不起一支不打仗的軍隊。
 */
export const SEASON_MODIFIERS: Record<Season, SeasonModifiers> = {
  SPRING: {
    label: "荒芽",
    months: [1, 3],
    production: 1.1,
    upkeep: 1.0,
    marchTime: 1.0,
    training: 1.0,
    regionCapacity: 0.8,
    vault: 2.0,
  },
  SUMMER: {
    label: "焦土",
    months: [4, 6],
    production: 1.0,
    upkeep: 1.0,
    marchTime: 1.0,
    training: 1.0,
    regionCapacity: 1.0,
    vault: 1.0,
  },
  AUTUMN: {
    label: "豐鏽",
    months: [7, 9],
    production: 1.2,
    upkeep: 1.0,
    marchTime: 1.0,
    training: 1.15,
    regionCapacity: 1.3,
    vault: 1.0,
  },
  /**
   * ★ production 0.55 → 0.70、upkeep 1.4 → 1.25。
   *
   *   原本的組合讓收支在入冬瞬間惡化 3.05 倍（1.2/0.55 × 1.4），
   *   賽季模擬顯示中位數玩家在入冬第一週就被餓掉一半的部隊 ——
   *   「用兵在秋冬兩季達高峰」因此退化成「只有秋季有高峰」。
   *
   *   0.70 / 1.25 讓軍隊還能爬進冬季（月 10 觸及人口上限），
   *   接著在月 11–12 被消耗回 2,000 上下：冬天依然很痛，但不是清空。
   */
  WINTER: {
    label: "長夜",
    months: [10, 12],
    production: 0.7,
    upkeep: 1.3,
    marchTime: 1.15,
    training: 1.0,
    regionCapacity: 0.9,
    vault: 1.0,
  },
} as const;

/** 季節切換前多久發出全服預告與個人化糧食收支預測 */
export const SEASON_CHANGE_WARNING_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// 賽季生命週期與輪替
// ─────────────────────────────────────────────────────────────

export const SEASON_LIFECYCLE = {
  /** 登記期長度 */
  registrationMs: 3 * 24 * 60 * 60 * 1000,
  /** 封盤期長度（停止登記 → 開賽） */
  sealedMs: 12 * 60 * 60 * 1000,
  /** 賽季本體長度 = 12 真實日 */
  runningMs: 12 * 24 * 60 * 60 * 1000,
  /** 終戰期（地圖凍結、結算、歸檔） */
  endingMs: 12 * 60 * 60 * 1000,
  /** 每 7 天開新的一場 → 任何時刻有兩場並行，重疊 5 天 */
  cadenceMs: 7 * 24 * 60 * 60 * 1000,
  /** 下一場的登記在自己賽季的第 11 日開放（社群關係最熱時） */
  nextSeasonSignupOnDay: 11,
  /** 三遺跡同控滿此時數即賽季結束 */
  victoryHoldMs: 6 * 60 * 60 * 1000,
} as const;
