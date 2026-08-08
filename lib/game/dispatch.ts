/**
 * 派兵：六種行軍類型的規則與驗證。純函式，無 I/O。
 * 對應 docs/04-military-combat.md §2、§4。
 *
 * ## ★ 為什麼類型要在型別上分開，而不是一個布林旗標
 *
 * 突襲只交戰一輪、雙方損失 ×0.6、不破壞建築；攻擊是完整戰鬥；
 * 偵查根本不打（走機率對抗）；增援不打、部隊留在對方那裡。
 *
 * 這四件事的**結算路徑完全不同**。用一個 `isRaid` 布林去分岔，
 * 三個月後就會出現「偵查兵把城牆拆了」這種 bug。
 */

import { MARCH, UNIT, type Unit } from "./balance";
import { marchTime, type MarchTime, type Point } from "./march";
import { roadMultiplier, type RoadNetwork } from "./structures";
import { armyPopulation } from "./formulas";
import { isEmptyArmy, subtractArmy, type Army } from "./army";
import type { SeasonModifiers } from "./balance";

/**
 * 玩家可以主動發起的類型。`RETURN` 是自動產生的。
 * `CLAIM` 是**征服**（docs/02 §2.5）：lv≥2 的野地有守衛，士兵打下來才佔得到；
 * 無守衛格的立旗仍走領土佇列（`claimTileFor`），不經過這裡。
 */
export const DISPATCHABLE = ["RAID", "ATTACK", "SCOUT", "CLAIM", "REINFORCE", "GARRISON"] as const;
export type DispatchType = (typeof DISPATCHABLE)[number];

export function isDispatchable(t: string): t is DispatchType {
  return (DISPATCHABLE as readonly string[]).includes(t);
}

export interface DispatchState {
  readonly from: Point;
  /** 出發地的駐軍 —— 出擊規模不能超過它 */
  readonly garrison: Army;
  readonly season?: SeasonModifiers;
  readonly speedBonus?: { techBonus?: number; stableBonus?: number; ruinBonus?: number };
  /** 沿途地形的平均行軍係數，由呼叫端取樣 */
  readonly terrainFactor?: number;
  /**
   * 自己的要塞路網（`docs/02` §2.6）。起訖都在網上時速度 ×4。
   * 沒傳就是沒有路網加速 —— 舊的呼叫端不會因此變快或變慢。
   */
  readonly road?: RoadNetwork | null;
}

export type DispatchRejection =
  | "UNKNOWN_TYPE"
  | "EMPTY_ARMY"
  | "NOT_IN_GARRISON"
  | "SELF_TARGET"
  | "SCOUT_ONLY"
  | "SCOUT_REQUIRES_SCOUTS"
  | "TOO_FAR"
  | "SAME_TILE";

export interface DispatchPlan {
  readonly type: DispatchType;
  readonly army: Army;
  readonly from: Point;
  readonly to: Point;
  readonly time: MarchTime;
  readonly arrivesAt: number;
  /** 出發後留在原地的駐軍 */
  readonly remainingGarrison: Army;
  readonly population: number;
}

/**
 * 規劃一次派兵。
 *
 * ★ **出擊規模 ≤ 出發地駐軍量**（`docs/10` M3b）。這一條看起來是廢話，
 *   但少了它，玩家可以同時派出十份同一支軍隊 ——
 *   而「軍隊在路上就不能防守」正是這個遊戲所有攻防取捨的基礎。
 */
export function planDispatch(
  state: DispatchState,
  type: string,
  to: Point,
  army: Army,
  now: number,
): DispatchPlan | { readonly reason: DispatchRejection } {
  if (!isDispatchable(type)) return { reason: "UNKNOWN_TYPE" };
  if (isEmptyArmy(army)) return { reason: "EMPTY_ARMY" };

  if (state.from.x === to.x && state.from.y === to.y) return { reason: "SAME_TILE" };

  const remaining = subtractArmy(state.garrison, army);
  if (remaining === null) return { reason: "NOT_IN_GARRISON" };

  /**
   * 偵查**只能派偵查兵**（`docs/04` §4）。
   *
   * 這不是防呆：偵查走的是機率對抗而不是戰鬥，
   * 混進一個劍士就得決定「他算不算戰力」—— 而答案是「不該有這個問題」。
   */
  if (type === "SCOUT") {
    const onlyScouts = Object.entries(army).every(([u, n]) => !n || u === "SCOUT");
    if (!onlyScouts) return { reason: "SCOUT_ONLY" };
    if ((army.SCOUT ?? 0) <= 0) return { reason: "SCOUT_REQUIRES_SCOUTS" };
  }

  const time = marchTime({
    from: state.from,
    to,
    army,
    terrainFactor: state.terrainFactor,
    season: state.season,
    speedBonus: state.speedBonus,
    roadMultiplier: roadMultiplier(state.from, to, state.road),
  });

  /**
   * ★ 8 小時上限是**地圖設計約束**，不是防呆（`march.ts`）：
   *   跨陣營的攻城遠征在物理上不可能直達，主力必須先進駐前哨營
   *   再重新出發。這讓「建立補給線」成為秋季大會戰前的核心任務。
   */
  if (time.exceedsLimit) return { reason: "TOO_FAR" };

  return {
    type,
    army,
    from: state.from,
    to,
    time,
    arrivesAt: now + Math.round(time.seconds * 1000),
    remainingGarrison: remaining,
    population: armyPopulation(army),
  };
}

/**
 * 回程。
 *
 * ★ 回程的速度與去程相同，但**要用實際回去的那支部隊重算** ——
 *   打完之後慢的單位可能全死了，剩下的騎兵跑得比較快。
 *   直接沿用去程時間會讓「全滅到只剩騎兵」反而回得比較慢。
 */
export function planReturn(
  survivors: Army,
  from: Point,
  to: Point,
  now: number,
  opts: {
    season?: SeasonModifiers;
    terrainFactor?: number;
    speedBonus?: DispatchState["speedBonus"];
    road?: RoadNetwork | null;
  } = {},
): { readonly arrivesAt: number; readonly seconds: number } | null {
  if (isEmptyArmy(survivors)) return null;
  // 回程一樣吃路網 —— 打完仗撤回自己的驛道上本來就該快
  const time = marchTime({
    from,
    to,
    army: survivors,
    terrainFactor: opts.terrainFactor,
    season: opts.season,
    speedBonus: opts.speedBonus,
    roadMultiplier: roadMultiplier(from, to, opts.road),
  });
  const seconds = Math.min(time.seconds, MARCH.maxSeconds);
  return { arrivesAt: now + Math.round(seconds * 1000), seconds };
}

// ─────────────────────────────────────────────────────────────
// 偵查
// ─────────────────────────────────────────────────────────────

/**
 * 偵查成功率（`docs/04` §4）：
 *
 * ```
 * N^1.5 / (N^1.5 + M^1.5 × (1 + 哨塔等級 × 0.1))
 * ```
 *
 * 守方一隻偵查兵都沒有時成功率為 1 —— 哨塔擋不住偵查，只提高門檻。
 */
export function scoutSuccessChance(
  attackers: number,
  defenders: number,
  watchtowerLevel = 0,
): number {
  if (attackers <= 0) return 0;
  const a = attackers ** 1.5;
  const d = defenders ** 1.5 * (1 + watchtowerLevel * 0.1);
  if (d <= 0) return 1;
  return a / (a + d);
}

export interface ScoutReport {
  readonly success: boolean;
  /** 成功時：守軍兵種與數量（±10% 誤差） */
  readonly army: Army | null;
  /** 成功時：資源量（±15% 誤差） */
  readonly resources: Partial<Record<"grain" | "timber" | "stone" | "iron", number>> | null;
  readonly citadelLevel: number | null;
  readonly wallLevel: number | null;
}

/**
 * 產生偵查回報。
 *
 * ★ 誤差是**確定性**的：由 `noise` 參數（呼叫端用 seed 決定）決定，
 *   不是每次讀取都重擲。一份會變動的情報等於沒有情報。
 */
export function scoutReport(
  success: boolean,
  truth: {
    army: Army;
    resources: Record<"grain" | "timber" | "stone" | "iron", number>;
    citadelLevel: number;
    wallLevel: number;
  },
  noise: (key: string) => number,
): ScoutReport {
  if (!success) {
    return { success: false, army: null, resources: null, citadelLevel: null, wallLevel: null };
  }

  const fuzz = (key: string, value: number, spread: number) =>
    Math.max(0, Math.round(value * (1 + (noise(key) * 2 - 1) * spread)));

  const army: Army = {};
  for (const [unit, n] of Object.entries(truth.army)) {
    if (!n) continue;
    army[unit as Unit] = fuzz(`army:${unit}`, n, 0.1);
  }

  const resources = {
    grain: fuzz("res:grain", truth.resources.grain, 0.15),
    timber: fuzz("res:timber", truth.resources.timber, 0.15),
    stone: fuzz("res:stone", truth.resources.stone, 0.15),
    iron: fuzz("res:iron", truth.resources.iron, 0.15),
  };

  return {
    success: true,
    army,
    resources,
    citadelLevel: truth.citadelLevel,
    wallLevel: truth.wallLevel,
  };
}

// ─────────────────────────────────────────────────────────────
// 固有防禦
// ─────────────────────────────────────────────────────────────

/**
 * 據點固有防禦 = `主堡等級 × 120`（`docs/10` M3、`docs/16` §4.1）。
 *
 * ★ 早期固有防禦不是「擊退」，是**讓交換比貴到不值得**（`docs/16` §4.1
 *   的修正）。Lv5 據點的 600 點固有防禦擋不住 46 名劍士，
 *   但會讓他們慘勝到只剩 0.5% —— 而那不值得。
 */
export function innateDefenseOf(citadelLevel: number, isLeaderBase = false): number {
  return citadelLevel * 120 * (isLeaderBase ? 2 : 1);
}

/** 領土格的固有防禦 = 設施等級 × 30 */
export function tileInnateDefense(facilityLevel: number): number {
  return facilityLevel * 30;
}

/** 哨塔的固定防禦 = 200 × 等級 */
export function watchtowerDefenseOf(level: number): number {
  return 200 * level;
}

/**
 * 突襲的損失折扣（`docs/04` §2.1）：只交戰一輪，**雙方損失 ×0.6**。
 *
 * 這讓突襲成為一個可以反覆做的動作 —— 而反覆做正是
 * 重複劫掠遞減（`army.ts`）存在的理由。
 */
export const RAID_LOSS_MULTIPLIER = 0.6;

export function scaleLosses(losses: Army, multiplier: number): Army {
  const out: Army = {};
  for (const [unit, n] of Object.entries(losses)) {
    if (!n) continue;
    const scaled = Math.floor(n * multiplier);
    if (scaled > 0) out[unit as Unit] = scaled;
  }
  return out;
}

/** 突襲時把「沒死成的人」加回存活者 */
export function reviveSpared(survivors: Army, original: Army, actualLosses: Army): Army {
  const out: Army = { ...survivors };
  for (const [unit, n] of Object.entries(original)) {
    if (!n) continue;
    const u = unit as Unit;
    out[u] = n - (actualLosses[u] ?? 0);
    if ((out[u] ?? 0) <= 0) delete out[u];
  }
  return out;
}

export { UNIT };
