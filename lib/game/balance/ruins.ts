/**
 * 三座遺跡與遺跡軍團。
 * 對應 docs/05-ruins-season.md 與 docs/17-ruin-legions.md。
 */

export const RUIN_IDS = [1, 2, 3] as const;
export type RuinId = (typeof RUIN_IDS)[number];

export interface RuinSpec {
  readonly name: string;
  readonly nameEn: string;
  /** 對應的陣營 */
  readonly faction: 1 | 2 | 3;
  readonly factionName: string;
  /** 軍團基礎人口（解封時） */
  readonly legionBase: number;
  /** 給控制聯盟的增益 */
  readonly buff: Readonly<Record<string, number>>;
  readonly buffLabel: string;
}

export const RUIN: Record<RuinId, RuinSpec> = {
  1: {
    name: "灰燼尖塔", nameEn: "The Ashen Spire",
    faction: 1, factionName: "灰燼氏族",
    legionBase: 8000,
    buff: { marchSpeed: 0.2 },
    buffLabel: "全體行軍速度 +20%",
  },
  2: {
    name: "沉沒穹窖", nameEn: "The Drowned Vault",
    faction: 2, factionName: "穹窖商會",
    legionBase: 10000,
    buff: { production: 0.25, vault: 0.5 },
    buffLabel: "全體資源產出 +25%、地窖保護 +50%",
  },
  3: {
    name: "鐵之搖籃", nameEn: "The Iron Cradle",
    faction: 3, factionName: "鐵搖籃盟",
    legionBase: 12000,
    buff: { attack: 0.12, defense: 0.12 },
    buffLabel: "全體單位攻擊與防禦 +12%",
  },
} as const;

/**
 * ★ 陣營級分潤：自家遺跡由同陣營任一聯盟控制時，
 * 同陣營其他 4 盟也拿到一半的增益（遺物不分潤）。
 *
 * 於是陣營內的 5 個聯盟既是敵人也是共犯：
 * 你想自己拿（100%），但拿不到時寧願是同陣營的死對頭拿到（50%），
 * 也不要落到外族手裡（0%）。
 */
export const FACTION_BUFF_SHARE = 0.5;

// ─────────────────────────────────────────────────────────────
// 控制機制
// ─────────────────────────────────────────────────────────────

export const RUIN_CONTROL = {
  /** 遺跡容量 */
  capacity: 3000,
  /** 每分鐘進度變化 = (我方 − 他方) / capacity × 100 × rate */
  progressRatePerMinute: 0.02,
  /** 滿駐軍從 0 → 100% 所需分鐘數 */
  fullGarrisonMinutes: 50,

  /** 維持控制的最低駐軍 —— 難的不是打下來，是守住 */
  holdThreshold: 1500,
  /** 低於門檻時每分鐘的進度衰減 */
  decayPerMinute: 0.01,

  /** 爭奪狀態下雙方駐軍自動交戰的間隔 */
  contestBattleIntervalMs: 5 * 60 * 1000,

  /** 遺物產出（已含 TIME_SCALE） */
  relicPerHour: 48,
  /** 分配給多久內登入過的成員 */
  relicOnlineWindowMs: 12 * 60 * 60 * 1000,

  /** 首殺獎勵 */
  firstClearRelic: 200,
  firstClearScore: 500,
} as const;

// ─────────────────────────────────────────────────────────────
// 遺跡軍團：三顆定時炸彈
//
// 你在夏季清掉它 → 遺跡歸你，軍團永遠消失
// 你沒清掉       → 它一直長大，秋天吃你的領土，冬天直接來打你家
// ─────────────────────────────────────────────────────────────

export const RUIN_PHASES = [
  "SEALED",
  "DORMANT",
  "AWAKENED",
  "CONTESTED",
  "CONTROLLED",
] as const;
export type RuinPhase = (typeof RUIN_PHASES)[number];

export const LEGION = {
  /** 解封的遊戲月（夏季首日 D3） */
  unsealMonth: 4,

  /**
   * 軍團人口 = 基礎 × growth^(遊戲月 − 4)。
   *
   * 成長曲線預先定義、公開可查、**與玩家實力無關** ——
   * 這仍是固定難度，不是動態難度。時間壓力來自時鐘，不是來自你。
   */
  growthPerMonth: 1.15,

  /** 損傷不回血，但成長乘在當前人口上 → 打了一半就放著是最糟的選擇 */
  regenerates: false,
  /** 清空後永不重生 */
  respawns: false,

  /** 秋季：對外擴張 */
  autumn: {
    sortieIntervalMs: 6 * 60 * 60 * 1000,
    sortieRatio: 0.08,
    /** 拓殖隊優先佔中立空地，其次攻擊相鄰玩家領土 */
    preferNeutralTiles: true,
  },
  /** 冬季：四處征伐 */
  winter: {
    sortieIntervalMs: 4 * 60 * 60 * 1000,
    sortieRatio: 0.14,
    /** 目標權重：追逐規模，不打弱者 */
    weightMostTerritory: 3,
    weightNearest: 2,
    weightOther: 1,
    /** 目標類型分配 */
    targetCoreShare: 0.6,
    targetTerritoryShare: 0.4,
  },
  /** 單次出兵的人口上限（兩季共用） */
  sortieCap: 3000,

  /** 遺跡哨所 */
  outpost: { defense: 400, destructible: true },

  /** 遺跡軍團**不會圍城** —— AI 不能終結真人的賽季 */
  canSiege: false,
} as const;

// ─────────────────────────────────────────────────────────────
// 賽季結算
// ─────────────────────────────────────────────────────────────

export const SEASON_SCORE = {
  ruinControlHour: 300,
  territoryTile: 2,
  citadelLevel: 1,
  firstClear: 500,
  /** 冬季（D9 後）仍持有遺跡的每小時額外加權 */
  winterRuinHour: 200,
  /** 斬首一個聯盟 */
  decapitation: 1500,
} as const;
