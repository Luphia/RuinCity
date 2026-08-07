/**
 * 軍隊的維持與消耗。純函式，無 I/O。
 * 對應 docs/03-economy.md §3、docs/16-supply-and-attrition.md。
 *
 * ## ★ 你不能把軍隊留著不用
 *
 * 部隊每小時吃糧，而冬季產出 ×0.70、糧耗 ×1.40 ——
 * 多數玩家的糧食收支會由正轉負（`docs/03` §3）。
 * 這不是懲罰，是賽季的收束機制：**龜縮到期滿不再是可行策略**。
 *
 * 所以糧食歸零時軍隊會餓死，而且**優先餓死糧耗最高的**：
 * 你先失去的是騎兵與攻城器械，不是民兵。
 */

import { RAIDING, RESOURCES, UNIT, UNITS, type Resource, type Unit } from "./balance";
import { armyCarry, armyPopulation, upkeepPerHour, vaultProtection } from "./formulas";
import { zeroAmounts, type Amounts, type SettleResource } from "./settle";

export type Army = Partial<Record<Unit, number>>;

// ─────────────────────────────────────────────────────────────
// 餓死
// ─────────────────────────────────────────────────────────────

/** 每 10 分鐘一次判定（`docs/03` §3） */
export const STARVATION_TICK_MS = 10 * 60 * 1000;
/** 每次餓死 3% */
export const STARVATION_RATE = 0.03;
/** 提前多久紅字警告 */
export const STARVATION_WARNING_MS = 6 * 60 * 60 * 1000;

export interface StarvationResult {
  readonly survivors: Army;
  readonly lost: Army;
  /** 這一段時間內判定了幾次 */
  readonly ticks: number;
}

/**
 * 糧食見底之後餓死部隊。
 *
 * ★ **優先餓死糧耗最高的**（`docs/03` §3）。這一條不是風味 ——
 *   它讓「養一支吃不起的騎兵隊」的代價立刻可見，
 *   而且餓死的順序剛好與「先賣掉最貴的東西」的直覺一致。
 *
 * ★ 沒有隨機。文件寫「隨機餓死 3%」，但結算必須是**確定性**的：
 *   同一個狀態結算兩次得到同一個結果，否則重放與冪等都不成立
 *   （見 `settle.ts` 的核心不變式）。3% 是比例，不需要擲骰。
 */
export function starve(army: Army, elapsedMs: number): StarvationResult {
  const ticks = Math.floor(Math.max(0, elapsedMs) / STARVATION_TICK_MS);
  if (ticks <= 0) return { survivors: { ...army }, lost: {}, ticks: 0 };

  const survivors: Army = { ...army };
  const lost: Army = {};

  // 糧耗高的排前面；同糧耗時依 UNITS 的宣告順序，確保確定性
  const order = (Object.keys(survivors) as Unit[])
    .filter((u) => (survivors[u] ?? 0) > 0)
    .sort(
      (a, b) => UNIT[b].upkeep - UNIT[a].upkeep || UNITS.indexOf(a) - UNITS.indexOf(b),
    );

  for (let t = 0; t < ticks; t++) {
    const total = totalUnits(survivors);
    if (total <= 0) break;
    // 每次要死掉的「人頭數」——不足一人時至少死一個，否則小部隊永遠餓不死
    let quota = Math.max(1, Math.floor(total * STARVATION_RATE));

    for (const unit of order) {
      if (quota <= 0) break;
      const have = survivors[unit] ?? 0;
      if (have <= 0) continue;
      const kill = Math.min(have, quota);
      survivors[unit] = have - kill;
      lost[unit] = (lost[unit] ?? 0) + kill;
      quota -= kill;
    }
  }

  for (const u of Object.keys(survivors) as Unit[]) {
    if ((survivors[u] ?? 0) <= 0) delete survivors[u];
  }
  return { survivors, lost, ticks };
}

function totalUnits(army: Army): number {
  let n = 0;
  for (const v of Object.values(army)) n += v ?? 0;
  return n;
}

/**
 * 距離糧食見底還有多久（毫秒）。UI 用它做提前 6 小時的紅字警告。
 *
 * 回傳 `Infinity` 代表收支為正或持平。
 */
export function msUntilStarvation(grain: number, netGrainPerHour: number): number {
  if (netGrainPerHour >= 0) return Infinity;
  return (grain / -netGrainPerHour) * 3_600_000;
}

// ─────────────────────────────────────────────────────────────
// 糧耗
// ─────────────────────────────────────────────────────────────

/**
 * 駐軍與行軍中部隊的糧耗，併進 `PlayerEconomy.baseUpkeep`。
 *
 * ★ **行軍中的部隊照吃糧**。不然「把軍隊派出去繞圈」就是免費的倉庫，
 *   而冬季的收束機制會整個失效。
 */
export function armyUpkeep(armies: readonly Army[]): Amounts {
  const up = zeroAmounts();
  for (const army of armies) up.grain += upkeepPerHour(army);
  return up;
}

// ─────────────────────────────────────────────────────────────
// 掠奪
// ─────────────────────────────────────────────────────────────

export type Lootable = Partial<Record<Resource, number>>;

/**
 * 守方**可被掠奪**的量 = 庫存 − 地窖保護。
 *
 * 地窖春季 ×2（`docs/16` §7）—— 這是唯一保留的「時間性」保護，
 * 也是「第 1 天的新手被 200 劍士攻擊，資源損失為 0」的來源。
 */
export function lootableOf(
  resources: Amounts,
  citadelLevel: number,
  depotLevel: number,
  vaultMultiplier: number,
): Lootable {
  const vault = vaultProtection(citadelLevel, depotLevel, { vault: vaultMultiplier });
  const out: Lootable = {};
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    out[r] = Math.max(0, resources[r] - vault);
  }
  return out;
}

/**
 * 重複劫掠遞減（`docs/03` §4.3）。
 *
 * 同一攻方對同一守方，6 小時內第 n 次成功掠奪：`× 0.6^(n-1)`。
 * 第 1 次 100%、第 2 次 60%、第 3 次 36%、第 4 次 21.6%…
 *
 * ★ 只算**成功**的掠奪。打輸了不該把冷卻用掉 ——
 *   否則守方會發現「讓對方打贏一次比較划算」。
 */
export function diminishingFactor(previousSuccessfulRaids: number): number {
  return RAIDING.diminishing.factor ** Math.max(0, previousSuccessfulRaids);
}

export const RAID_WINDOW_MS = RAIDING.diminishing.windowMs;

/** 連續被同一人打幾次之後出現「求援」按鈕 */
export const DISTRESS_AFTER_HITS = RAIDING.distressAfterHits;

/**
 * 把掠奪量套上遞減，再夾在載重上限之內。
 *
 * ★ 各資源**按未保護量的比例分攤載重**（`docs/03` §4.2）——
 *   不會只搶一種。少了這一條，掠奪騎兵會永遠只扛糧食，
 *   而「石頭滿了但木頭見底」這個逼人交易的困境就消失了。
 */
export function applyCarryLimit(loot: Lootable, carry: number): Lootable {
  const total = RESOURCES.reduce((s, r) => s + (loot[r] ?? 0), 0);
  if (total <= carry || total <= 0) return { ...loot };

  const scale = carry / total;
  const out: Lootable = {};
  for (const r of RESOURCES) {
    const v = loot[r] ?? 0;
    if (v > 0) out[r] = Math.floor(v * scale);
  }
  return out;
}

/** 部隊總載重 */
export function carryOf(army: Army): number {
  return armyCarry(army);
}

// ─────────────────────────────────────────────────────────────
// 傷兵
// ─────────────────────────────────────────────────────────────

/**
 * 醫療帳回收傷兵（`docs/04` §5）：`25% + 2%/等級`，
 * **只在自己據點防守時生效**。
 *
 * 傷兵要花「糧食 30% 的招募成本 + 一半招募時間」才能歸隊 ——
 * 這裡只算「有幾個人回得來」，復原的排程由呼叫端負責。
 */
export function woundedRecoveryCost(wounded: Army): Amounts {
  const cost = zeroAmounts();
  for (const [unit, n] of Object.entries(wounded)) {
    if (!n) continue;
    cost.grain += UNIT[unit as Unit].cost.grain * 0.3 * n;
  }
  return cost;
}

export function woundedRecoverySeconds(wounded: Army, producerLevel: number): number {
  let seconds = 0;
  for (const [unit, n] of Object.entries(wounded)) {
    if (!n) continue;
    const speedup = 1 + 0.05 * producerLevel;
    seconds += (UNIT[unit as Unit].trainSeconds / speedup / 4) * n * 0.5;
  }
  return seconds;
}

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

export function mergeArmies(a: Army, b: Army): Army {
  const out: Army = { ...a };
  for (const [unit, n] of Object.entries(b)) {
    if (!n) continue;
    out[unit as Unit] = (out[unit as Unit] ?? 0) + n;
  }
  return out;
}

/** 從 `a` 扣掉 `b`。不足時回 null —— 呼叫端要當作「兵不夠」處理 */
export function subtractArmy(a: Army, b: Army): Army | null {
  const out: Army = { ...a };
  for (const [unit, n] of Object.entries(b)) {
    if (!n) continue;
    const have = out[unit as Unit] ?? 0;
    if (have < n) return null;
    const left = have - n;
    if (left === 0) delete out[unit as Unit];
    else out[unit as Unit] = left;
  }
  return out;
}

export function isEmptyArmy(army: Army): boolean {
  return totalUnits(army) <= 0;
}

export { armyPopulation, armyCarry, upkeepPerHour };

/** 從不可信的 jsonb 讀出一支部隊 */
export function parseArmy(raw: unknown): Army {
  const o = (raw ?? {}) as Record<string, unknown>;
  const out: Army = {};
  for (const u of UNITS) {
    const v = o[u];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[u] = Math.floor(v);
  }
  return out;
}

/** 從不可信的 jsonb 讀出一筆資源 */
export function parseAmounts(raw: unknown): Amounts {
  const o = (raw ?? {}) as Partial<Record<SettleResource, unknown>>;
  const out = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    const v = o[r];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[r] = v;
  }
  return out;
}
