/**
 * 陣營、聯盟、斬首與執政官。
 * 對應 docs/06-alliance.md 與 docs/18-steward.md。
 */

// ─────────────────────────────────────────────────────────────
// 聯盟
// ─────────────────────────────────────────────────────────────

export const ALLIANCE = {
  /** 每陣營 5 個名額（全場 15）—— 名額是陣營內的稀缺資源 */
  slotsPerFaction: 5,
  /** 真人成員上限 */
  maxMembers: 40,
  /** AI 成員另計 */
  maxAiMembers: 10,
  maxOfficers: 3,

  createCost: { timber: 2000, stone: 2000 },
  createRequiresCitadelLevel: 8,

  /** 退出冷卻：防止「戰前跳槽」 */
  leaveCooldownMs: 6 * 60 * 60 * 1000,

  /** 共享視野半徑 */
  vision: { member: 15, outpost: 10, ruin: 20 },

  /** AI 成員提供的增援比例 */
  aiReinforceRatio: 0.3,

  chatRateLimitPerMinute: 10,
} as const;

/**
 * 系統配發的 2 位 HEX 代碼（00–FF）。
 *
 * L3 戰略視圖每格只有 2px，塞不下名稱 —— 代碼是唯一讀得出來的識別。
 * 名稱與 tag 可以改，代碼不會，所以戰報、日誌、API、跨賽季統計都以它為準。
 * 以賽季 seed 洗牌後的序列依建立順序取出：公平且不可預測，沒有人能搶。
 */
export const ALLIANCE_CODE = {
  space: 256,
  digits: 2,
} as const;

/**
 * 15 種聯盟色，**同陣營 5 色同色系**。
 *
 * L3（2px）一眼看出三大勢力範圍，L2（8px）才分得出是哪個聯盟。
 * 色盲驗證：跨陣營的任兩色在 deuteranopia / tritanopia 模擬後必須可區分。
 */
export const ALLIANCE_COLORS: Record<1 | 2 | 3, readonly string[]> = {
  1: ["#c4442f", "#e07a3f", "#a8563a", "#d96c8a", "#8c3d2e"],
  2: ["#3f9aa3", "#4a72c4", "#2f7f8c", "#4f5fa8", "#6fa8b8"],
  3: ["#7fa832", "#3fa36b", "#9c9c4a", "#d9a441", "#5c8a45"],
} as const;

// ─────────────────────────────────────────────────────────────
// ★ 斬首 Decapitation：聯盟的死亡條件
// ─────────────────────────────────────────────────────────────

export const DECAPITATION = {
  /** 主旗加成：盟主據點天生最硬，但也是唯一致命的那一個 */
  standardDefenseMultiplier: 2,
  standardGarrisonMultiplier: 1.5,

  /** 圍城時長（真實時間） */
  siegeMs: 2 * 60 * 60 * 1000,
  /** 圍城部隊減員至此人口以下 → 斬首失敗 */
  siegeMinPopulation: 500,

  /** 春季不可斬首；夏季（遊戲月 4）起開放 */
  earliestGameMonth: 4,

  /** 盟主轉讓：事前的部署決策，不是事後的逃生門 */
  leaderTransferCooldownMs: 6 * 60 * 60 * 1000,
  leaderTransferDelayMs: 30 * 60 * 1000,
  leaderTransferBlockedDuringSiege: true,

  /** 淪陷後領土轉中立而非歸攻方 —— 避免滾雪球，且緊接一場搶地混戰 */
  territoryToNeutral: true,
} as const;

// ─────────────────────────────────────────────────────────────
// 執政官 Steward
//
// 鐵則：執行者，不是決策者。
// 只在對應佇列閒置時行動 → 玩家與執政官的衝突根本不會發生。
// ─────────────────────────────────────────────────────────────

export const STEWARD_DIRECTIVES = ["EXPANSION", "DEVELOPMENT", "LEVY"] as const;
export type StewardDirective = (typeof STEWARD_DIRECTIVES)[number];

export const STEWARD = {
  /** 可同時啟用的方針數 = 1 + ⌊主堡等級 / 8⌋，上限 3 */
  directiveSlots: { base: 1, perCitadelLevel: 8, max: 3 },

  /** 安全網頻率（主要仍靠佇列完成事件觸發） */
  tickIntervalMs: 2 * 60 * 60 * 1000,

  /** 領主接管：暫停時長 */
  pauseMs: { min: 1 * 60 * 60 * 1000, max: 24 * 60 * 60 * 1000, default: 6 * 60 * 60 * 1000 },

  /** 連續未登入多久 → 執政官取得「全權代理」（額外獲得防守調度與核心佇列權限） */
  fullProxyAfterMs: 48 * 60 * 60 * 1000,
  /** 報名後未首次登入多久 → 該位置根本沒有領主，直接轉為 AI */
  aiTakeoverAfterMs: 6 * 60 * 60 * 1000,

  /** 施政簡報素材的保留時長 */
  logRetentionMs: 48 * 60 * 60 * 1000,

  /**
   * ★ 執政官**永遠不能**碰的事。
   * 核心佇列與軍事決策是這個遊戲的全部樂趣，交出去等於不玩了。
   */
  forbidden: [
    "CORE_QUEUE",
    "MILITARY_MARCH",
    "DEMOLISH",
    "ALLIANCE_ACTION",
    "MARKET_TRADE",
  ] as const,

  /** 完全委託 vs 積極玩家的第 12 天總戰力目標比 */
  delegationParityTarget: [0.75, 0.85] as const,
} as const;
