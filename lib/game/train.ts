/**
 * 招募。純函式，無 I/O。
 * 對應 docs/02-base-territory.md §1.2 與 docs/04-military-combat.md。
 *
 * ## ★ 一座生產建築 = 一條招募佇列
 *
 * 兵營解鎖步／弓兵、獸廄解鎖騎兵、工坊解鎖攻城單位（`docs/11` §3 的
 * `requires`）。每一座各有**自己的**佇列，所以「同時能招幾種兵」
 * 直接等於「你在 B/C/D 三格裡放了幾座生產建築」。
 *
 * 這讓 7 選 3 的取捨延伸到軍事：想同時爆步兵與騎兵，就要付出兩格 ——
 * 而那兩格本來可以是倉庫與城牆。
 *
 * ## ★ 人口在**下單時**就被佔用
 *
 * 不是完成時。否則三條佇列可以各自下滿，總和遠超過人口上限 ——
 * 等到完成才發現超了，就只能在「憑空多出人口」與「白花資源」之間二選一。
 * 先扣起來，取消時再退（`docs/03` §3）。
 */

import { CORE_BUILDINGS, UNIT, UNITS, type CoreBuilding, type Unit } from "./balance";
import { trainSeconds } from "./formulas";
import type { CoreSlot, SlotState } from "./build";
import { zeroAmounts, type Amounts } from "./settle";

/** 有招募佇列的核心建築 */
export const PRODUCERS = ["BARRACKS", "STABLE", "WORKSHOP"] as const;
export type Producer = (typeof PRODUCERS)[number];

export function isProducer(b: CoreBuilding | null): b is Producer {
  return b !== null && (PRODUCERS as readonly string[]).includes(b);
}

/** 這個兵種由哪一座建築生產。民兵不需要任何建築 */
export function producerOf(unit: Unit): Producer | null {
  const requires = UNIT[unit].requires;
  if (!requires) return null;
  const [building] = requires;
  return isProducer(building as CoreBuilding) ? (building as Producer) : null;
}

export interface ProducerSlot {
  readonly slot: CoreSlot;
  readonly building: Producer;
  readonly level: number;
}

/** 玩家目前有哪些生產建築 */
export function producersOf(
  slots: Readonly<Record<CoreSlot, SlotState>>,
): readonly ProducerSlot[] {
  const out: ProducerSlot[] = [];
  for (const slot of ["B", "C", "D"] as const) {
    const s = slots[slot];
    if (isProducer(s.building) && s.level > 0) {
      out.push({ slot, building: s.building, level: s.level });
    }
  }
  return out;
}

export interface TrainState {
  readonly slots: Readonly<Record<CoreSlot, SlotState>>;
  /** 每一座生產建築的佇列完成時間；沒有那一座就沒有這個鍵 */
  readonly queues: Readonly<Partial<Record<Producer, { readonly doneAt: number } | null>>>;
  /**
   * 民兵佇列。民兵不需要任何建築（`UNIT.MILITIA.requires === null`），
   * 所以它有一條**自己的**佇列 —— 否則沒蓋兵營的人一個兵都招不了。
   */
  readonly militiaQueue: { readonly doneAt: number } | null;
}

export type TrainRejection =
  | "UNKNOWN_UNIT"
  | "NO_PRODUCER"
  | "PRODUCER_LEVEL"
  | "QUEUE_BUSY"
  | "NON_POSITIVE"
  | "INSUFFICIENT_RESOURCES"
  | "INSUFFICIENT_POPULATION"
  | "EXCEEDS_CAPACITY";

export interface TrainPlan {
  readonly unit: Unit;
  readonly count: number;
  /** null = 民兵佇列 */
  readonly producer: Producer | null;
  readonly cost: Amounts;
  readonly seconds: number;
  readonly population: number;
}

/**
 * 這個兵種現在招不招得動？只看**建築**，不看資源。
 *
 * 分開的理由跟 `checkBuild` 一樣：「等級不夠」是一條要去蓋東西的路，
 * 「錢不夠」是一條等一等就好的路，UI 必須分辨。
 */
export function unlockState(
  unit: Unit,
  slots: Readonly<Record<CoreSlot, SlotState>>,
): { readonly ok: true; readonly producer: Producer | null; readonly level: number }
  | { readonly ok: false; readonly reason: TrainRejection; readonly needs?: readonly [string, number] } {
  const spec = UNIT[unit];
  if (!spec.requires) return { ok: true, producer: null, level: 0 };

  const [building, level] = spec.requires;
  if (!isProducer(building as CoreBuilding)) {
    // 檔案館解鎖的遺跡單位不走招募路徑（`docs/17`）
    return { ok: false, reason: "NO_PRODUCER", needs: spec.requires };
  }

  const found = producersOf(slots).find((p) => p.building === building);
  if (!found) return { ok: false, reason: "NO_PRODUCER", needs: spec.requires };
  if (found.level < level) return { ok: false, reason: "PRODUCER_LEVEL", needs: spec.requires };

  return { ok: true, producer: found.building, level: found.level };
}

/** 那條佇列閒著嗎 */
export function queueFree(state: TrainState, producer: Producer | null, now: number): boolean {
  const q = producer === null ? state.militiaQueue : (state.queues[producer] ?? null);
  return !q || q.doneAt <= now;
}

/** 閒置的招募佇列數。執政官用它決定這一輪能不能募兵 */
export function freeTrainQueues(state: TrainState, now: number): number {
  let free = queueFree(state, null, now) ? 1 : 0;
  for (const p of producersOf(state.slots)) {
    if (queueFree(state, p.building, now)) free++;
  }
  return free;
}

/**
 * 規劃一次招募。
 *
 * ★ 時間是 `每單位秒數 × 數量`，不是固定值 —— 一次招 100 人就要
 *   100 倍的時間。少了這一點，「一次下大單」會變成沒有代價的最佳解，
 *   而招募速度加成（兵營 +5%/等級）也就失去意義。
 */
export function planTrain(
  state: TrainState,
  unit: string,
  count: number,
  now: number,
  opts: { readonly trainingModifier?: number } = {},
): TrainPlan | { readonly reason: TrainRejection } {
  if (!UNITS.includes(unit as Unit)) return { reason: "UNKNOWN_UNIT" };
  const u = unit as Unit;

  const n = Math.floor(count);
  if (!Number.isFinite(n) || n <= 0) return { reason: "NON_POSITIVE" };

  const unlock = unlockState(u, state.slots);
  if (!unlock.ok) return { reason: unlock.reason };
  if (!queueFree(state, unlock.producer, now)) return { reason: "QUEUE_BUSY" };

  const spec = UNIT[u];
  const cost = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) cost[r] = spec.cost[r] * n;

  // 招募速度受季節影響（`docs/14` §3），但這裡只要那一個係數
  const perUnit = trainSeconds(u, unlock.level) / (opts.trainingModifier ?? 1);

  return {
    unit: u,
    count: n,
    producer: unlock.producer,
    cost,
    seconds: perUnit * n,
    population: spec.population * n,
  };
}

export interface TrainCheck {
  readonly ok: boolean;
  readonly reason?: TrainRejection;
}

export function checkTrain(
  plan: TrainPlan,
  resources: Amounts,
  capacity: number,
  freePopulation: number,
): TrainCheck {
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    // 一次下的單超過倉庫容得下的量 = 永遠湊不齊，跟「現在不夠」是兩回事
    if (plan.cost[r] > capacity) return { ok: false, reason: "EXCEEDS_CAPACITY" };
    if (resources[r] < plan.cost[r]) return { ok: false, reason: "INSUFFICIENT_RESOURCES" };
  }
  if (freePopulation < plan.population) {
    return { ok: false, reason: "INSUFFICIENT_POPULATION" };
  }
  return { ok: true };
}

/**
 * 在資源、人口與倉庫上限之下，這個兵種**最多**招幾個。
 *
 * UI 的「最大」按鈕與執政官都用它 ——
 * 兩邊算出來的數字必須一樣，否則玩家會覺得執政官在亂花錢。
 */
export function maxAffordable(
  unit: Unit,
  resources: Amounts,
  capacity: number,
  freePopulation: number,
): number {
  const spec = UNIT[unit];
  let n = Math.floor(freePopulation / Math.max(1, spec.population));
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    if (spec.cost[r] <= 0) continue;
    n = Math.min(n, Math.floor(resources[r] / spec.cost[r]), Math.floor(capacity / spec.cost[r]));
  }
  return Math.max(0, n);
}

/** 把招募完成的部隊併進駐軍 */
export function mergeUnits(
  garrison: Readonly<Partial<Record<Unit, number>>>,
  unit: Unit,
  count: number,
): Partial<Record<Unit, number>> {
  return { ...garrison, [unit]: (garrison[unit] ?? 0) + count };
}

/** 駐軍佔用的人口 */
export function garrisonPopulation(garrison: Readonly<Partial<Record<Unit, number>>>): number {
  let total = 0;
  for (const [unit, n] of Object.entries(garrison)) {
    total += UNIT[unit as Unit].population * (n ?? 0);
  }
  return total;
}

/** UI 用：這一格核心建築解鎖了哪些兵種 */
export function unlockedUnits(
  slots: Readonly<Record<CoreSlot, SlotState>>,
): readonly Unit[] {
  return UNITS.filter((u) => {
    const spec = UNIT[u];
    if (!spec.requires) return true;
    if (!isProducer(spec.requires[0] as CoreBuilding)) return false;
    return unlockState(u, slots).ok;
  });
}

export { CORE_BUILDINGS };
