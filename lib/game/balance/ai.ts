/**
 * AI 玩家。
 * 對應 docs/15-ai-players.md。
 *
 * AI 的任務不是假裝成真人，而是保證地圖密度與賽季弧線的一致性。
 * 代價是必須誠實：`◈` 標示、公開人數比、公開行為腳本、真人排名並列。
 */

export const AI_PERSONAS = ["SETTLER", "WARDEN", "WARLORD"] as const;
export type AiPersona = (typeof AI_PERSONAS)[number];

export interface AiPersonaSpec {
  readonly label: string;
  readonly tag: string;
  readonly share: number;
  readonly initiatesAttacks: boolean;
  readonly seizesTerritory: boolean;
  readonly garrisonsRuins: boolean;
  /** 兵種配比 */
  readonly composition: Readonly<Record<string, number>>;
}

export const AI_PERSONA: Record<AiPersona, AiPersonaSpec> = {
  SETTLER: {
    label: "拓荒者", tag: "◈S", share: 0.5,
    initiatesAttacks: false, seizesTerritory: false, garrisonsRuins: false,
    composition: { SPEARMAN: 0.4, ARCHER: 0.45, MILITIA: 0.15 },
  },
  WARDEN: {
    label: "巡守者", tag: "◈W", share: 0.35,
    initiatesAttacks: true, seizesTerritory: true, garrisonsRuins: false,
    composition: { SPEARMAN: 0.3, ARCHER: 0.3, SWORDSMAN: 0.25, RAIDER: 0.15 },
  },
  WARLORD: {
    label: "領主", tag: "◈L", share: 0.15,
    initiatesAttacks: true, seizesTerritory: true, garrisonsRuins: true,
    composition: { SWORDSMAN: 0.35, LANCER: 0.2, ARCHER: 0.2, SPEARMAN: 0.15, RAM: 0.1 },
  },
} as const;

/**
 * 固定腳本曲線，索引為遊戲月 1–12。
 *
 * 與遺跡軍團採固定難度是同一個原則：透明的固定值勝過隱形的動態難度。
 * 玩家可以學習：「第 6 月的 ◈W 大概 780 人口，我帶 1,200 去打穩贏」。
 */
export const AI_CURVE = [
  { month: 1, citadel: 4, territory: 6, pop: { SETTLER: 40, WARDEN: 60, WARLORD: 80 } },
  { month: 2, citadel: 7, territory: 12, pop: { SETTLER: 90, WARDEN: 140, WARLORD: 190 } },
  { month: 3, citadel: 10, territory: 20, pop: { SETTLER: 170, WARDEN: 260, WARLORD: 360 } },
  { month: 4, citadel: 12, territory: 28, pop: { SETTLER: 260, WARDEN: 400, WARLORD: 560 } },
  { month: 5, citadel: 15, territory: 36, pop: { SETTLER: 380, WARDEN: 580, WARLORD: 820 } },
  { month: 6, citadel: 17, territory: 44, pop: { SETTLER: 510, WARDEN: 780, WARLORD: 1100 } },
  { month: 7, citadel: 19, territory: 52, pop: { SETTLER: 660, WARDEN: 1010, WARLORD: 1420 } },
  { month: 8, citadel: 21, territory: 58, pop: { SETTLER: 820, WARDEN: 1250, WARLORD: 1760 } },
  { month: 9, citadel: 22, territory: 64, pop: { SETTLER: 990, WARDEN: 1510, WARLORD: 2120 } },
  { month: 10, citadel: 23, territory: 68, pop: { SETTLER: 1050, WARDEN: 1600, WARLORD: 2240 } },
  { month: 11, citadel: 24, territory: 70, pop: { SETTLER: 1080, WARDEN: 1650, WARLORD: 2300 } },
  { month: 12, citadel: 25, territory: 72, pop: { SETTLER: 1090, WARDEN: 1660, WARLORD: 2320 } },
] as const;

export const AI_BEHAVIOR = {
  /** 個體變異，賽季開始時由 seed 決定後固定 */
  variance: 0.15,
  /** 決策間隔 = 每個遊戲月邊界 */
  tickIntervalMs: 24 * 60 * 60 * 1000,
  /** 被攻擊後的反擊延遲 */
  retaliateDelayMs: [1 * 60 * 60 * 1000, 4 * 60 * 60 * 1000] as const,
  /** 反擊兵力佔當前的比例 */
  retaliateForceRatio: [0.4, 0.7] as const,
  /** AI 只在地緣鄰近範圍活動 */
  maxMarchSeconds: 2 * 60 * 60,

  /** AI 絕不做的事 */
  forbidden: [
    "CREATE_ALLIANCE",
    "DRIVE_RUIN_CAPTURE",
    "TRIGGER_SEASON_VICTORY",
    "MARKET_TRADE",
    "ATTACK_MUCH_WEAKER",
  ] as const,
} as const;
