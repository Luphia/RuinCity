/**
 * 建造：主堡、核心建築 B/C/D、領土設施。純函式，無 I/O。
 * 對應 docs/02-base-territory.md §1–3。
 *
 * ## ★ 核心建造佇列永遠只有一條
 *
 * 主堡與 B/C/D 三座核心建築**共用唯一一條建造佇列**，
 * 且不會因為任何等級、科技或付費而增加（`docs/02` §1.1）。
 * 這是整個遊戲最尖銳的取捨點：每一分鐘你在升級主堡，
 * 就是一分鐘你沒有在升級兵營。
 *
 * 領土設施佇列則是 `1 + ⌊主堡等級 / 10⌋` 條（1–4）——
 * 主堡提升的是**橫向鋪產出**的能力，不是核心取捨的空間。
 */

import {
  CITADEL,
  CORE_BUILDING,
  CORE_BUILDINGS,
  DEMOLISH,
  FACILITIES,
  FACILITY,
  TIME_SCALE,
  type CoreBuilding,
  type Facility,
} from "./balance";
import {
  citadelUpgradeCost,
  citadelUpgradeSeconds,
  coreBuildingCost,
  coreBuildingSeconds,
  facilityCost,
  facilitySeconds,
  facilityLevelCap,
  territoryQueues,
} from "./formulas";
import type { Amounts, SettleResource } from "./settle";

export const CORE_SLOTS = ["B", "C", "D"] as const;
export type CoreSlot = (typeof CORE_SLOTS)[number];

export interface SlotState {
  readonly building: CoreBuilding | null;
  readonly level: number;
}

export interface BuildState {
  readonly citadel: number;
  readonly slots: Readonly<Record<CoreSlot, SlotState>>;
  /** 核心佇列上正在蓋的東西；null = 閒置 */
  readonly coreQueue: { readonly target: "CITADEL" | CoreSlot; readonly doneAt: number } | null;
  /** 領土佇列，長度等於可用佇列數 */
  readonly territoryQueue: readonly ({ readonly doneAt: number } | null)[];
  readonly lastDemolishAt: number | null;
}

export type BuildTarget = "CITADEL" | CoreSlot;

export interface BuildPlan {
  readonly target: BuildTarget;
  readonly building: CoreBuilding | null;
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly cost: Amounts;
  readonly seconds: number;
}

export type BuildRejection =
  | "CORE_QUEUE_BUSY"
  | "CITADEL_MAXED"
  | "SLOT_EMPTY"
  | "SLOT_OCCUPIED"
  | "ABOVE_CITADEL"
  | "UNKNOWN_BUILDING"
  | "INSUFFICIENT_RESOURCES"
  | "EXCEEDS_CAPACITY";

export type BuildCheck =
  | { readonly ok: true; readonly plan: BuildPlan }
  | { readonly ok: false; readonly reason: BuildRejection; readonly plan?: BuildPlan };

const asAmounts = (c: Partial<Record<SettleResource, number>>): Amounts => ({
  grain: c.grain ?? 0,
  timber: c.timber ?? 0,
  stone: c.stone ?? 0,
  iron: c.iron ?? 0,
});

export function canAfford(resources: Amounts, cost: Amounts): boolean {
  return (
    resources.grain >= cost.grain &&
    resources.timber >= cost.timber &&
    resources.stone >= cost.stone &&
    resources.iron >= cost.iron
  );
}

/**
 * 成本超過儲存上限 = **永遠存不到**。
 *
 * 這不是「現在買不起」，是「這條路被鎖住了，去蓋倉庫」——
 * UI 必須分辨這兩種情況，否則玩家會一直等一個永遠不會到的數字。
 * （M1 的賽季模擬就在這裡卡過：主堡 Lv27 之後儲存上限低於升級成本。）
 */
export function exceedsCapacity(cost: Amounts, capacity: number): boolean {
  return (
    cost.grain > capacity ||
    cost.timber > capacity ||
    cost.stone > capacity ||
    cost.iron > capacity
  );
}

/** 規劃一次核心建造（升主堡或升 B/C/D） */
export function planCoreBuild(
  state: BuildState,
  target: BuildTarget,
  now: number,
): BuildPlan | { readonly reason: BuildRejection } {
  if (state.coreQueue && state.coreQueue.doneAt > now) return { reason: "CORE_QUEUE_BUSY" };

  if (target === "CITADEL") {
    if (state.citadel >= CITADEL.maxLevel) return { reason: "CITADEL_MAXED" };
    const to = state.citadel + 1;
    return {
      target,
      building: null,
      fromLevel: state.citadel,
      toLevel: to,
      cost: asAmounts(citadelUpgradeCost(to)),
      seconds: citadelUpgradeSeconds(to),
    };
  }

  const slot = state.slots[target];
  if (!slot?.building) return { reason: "SLOT_EMPTY" };
  // 其他建築等級 ≤ 主堡等級（`docs/02` §1）
  if (slot.level >= state.citadel) return { reason: "ABOVE_CITADEL" };

  const to = slot.level + 1;
  return {
    target,
    building: slot.building,
    fromLevel: slot.level,
    toLevel: to,
    cost: asAmounts(coreBuildingCost(slot.building, to)),
    seconds: coreBuildingSeconds(slot.building, to),
  };
}

/** 在空的 B/C/D 格上蓋一座新建築（7 選 3，見 `docs/02` §1.2） */
export function planCoreConstruct(
  state: BuildState,
  slot: CoreSlot,
  building: string,
  now: number,
): BuildPlan | { readonly reason: BuildRejection } {
  if (state.coreQueue && state.coreQueue.doneAt > now) return { reason: "CORE_QUEUE_BUSY" };
  if (!CORE_BUILDINGS.includes(building as CoreBuilding)) return { reason: "UNKNOWN_BUILDING" };
  if (state.slots[slot]?.building) return { reason: "SLOT_OCCUPIED" };

  const b = building as CoreBuilding;
  return {
    target: slot,
    building: b,
    fromLevel: 0,
    toLevel: 1,
    cost: asAmounts(coreBuildingCost(b, 1)),
    seconds: coreBuildingSeconds(b, 1),
  };
}

export function checkBuild(
  state: BuildState,
  resources: Amounts,
  capacity: number,
  planned: BuildPlan | { readonly reason: BuildRejection },
): BuildCheck {
  if ("reason" in planned) return { ok: false, reason: planned.reason };
  if (exceedsCapacity(planned.cost, capacity)) {
    return { ok: false, reason: "EXCEEDS_CAPACITY", plan: planned };
  }
  if (!canAfford(resources, planned.cost)) {
    return { ok: false, reason: "INSUFFICIENT_RESOURCES", plan: planned };
  }
  return { ok: true, plan: planned };
}

// ─────────────────────────────────────────────────────────────
// 領土設施
// ─────────────────────────────────────────────────────────────

export interface FacilityPlan {
  readonly facility: Facility;
  readonly fromLevel: number;
  readonly toLevel: number;
  readonly cost: Amounts;
  readonly seconds: number;
  /** 用第幾條領土佇列 */
  readonly queueIndex: number;
}

export type FacilityRejection =
  | "NO_FREE_QUEUE"
  | "UNKNOWN_FACILITY"
  | "LEVEL_CAPPED"
  | "INSUFFICIENT_RESOURCES"
  | "EXCEEDS_CAPACITY";

/** 找一條閒著的領土佇列。回傳 −1 代表全滿 */
export function freeTerritoryQueue(state: BuildState, now: number): number {
  const count = territoryQueues(state.citadel);
  for (let i = 0; i < count; i++) {
    const q = state.territoryQueue[i];
    if (!q || q.doneAt <= now) return i;
  }
  return -1;
}

export function planFacility(
  state: BuildState,
  facility: string,
  currentLevel: number,
  now: number,
): FacilityPlan | { readonly reason: FacilityRejection } {
  if (!FACILITIES.includes(facility as Facility)) return { reason: "UNKNOWN_FACILITY" };
  const queueIndex = freeTerritoryQueue(state, now);
  if (queueIndex < 0) return { reason: "NO_FREE_QUEUE" };

  const f = facility as Facility;
  const to = currentLevel + 1;
  // 設施等級上限 = ⌊主堡等級 / 1.6⌋（`docs/11` §3）
  if (to > facilityLevelCap(state.citadel)) return { reason: "LEVEL_CAPPED" };

  return {
    facility: f,
    fromLevel: currentLevel,
    toLevel: to,
    cost: asAmounts(facilityCost(f, to)),
    seconds: facilitySeconds(to),
    queueIndex,
  };
}

// ─────────────────────────────────────────────────────────────
// 拆除
// ─────────────────────────────────────────────────────────────

export type DemolishRejection = "CORE_QUEUE_BUSY" | "SLOT_EMPTY" | "COOLDOWN";

/**
 * 拆除冷卻（毫秒，已套用 TIME_SCALE）。
 *
 * ★ 匯出成常數而不是就地算，是因為 `events.ts` 也要用它 ——
 *   從 `cooldownUntil` 反推下單時間。兩邊各寫一次就是兩個真相。
 */
export const DEMOLISH_COOLDOWN_MS = (DEMOLISH.cooldownSeconds / TIME_SCALE) * 1000;
export const DEMOLISH_SECONDS = DEMOLISH.baseSeconds / TIME_SCALE;

export interface DemolishPlan {
  readonly slot: CoreSlot;
  readonly building: CoreBuilding;
  readonly refund: Amounts;
  readonly seconds: number;
  readonly cooldownUntil: number;
}

/**
 * 拆除核心建築。
 *
 * 可以轉型，但**不能在每次被打之前臨時換 build**——
 * 所以有 3 小時的施工時間、只退 30%，而且 6 小時內不能再拆一次
 * （`docs/02` §1.3 的數字已套用 TIME_SCALE）。
 */
export function planDemolish(
  state: BuildState,
  slot: CoreSlot,
  now: number,
): DemolishPlan | { readonly reason: DemolishRejection } {
  if (state.coreQueue && state.coreQueue.doneAt > now) return { reason: "CORE_QUEUE_BUSY" };
  const current = state.slots[slot];
  if (!current?.building) return { reason: "SLOT_EMPTY" };

  const cooldownMs = DEMOLISH_COOLDOWN_MS;
  if (state.lastDemolishAt !== null && now - state.lastDemolishAt < cooldownMs) {
    return { reason: "COOLDOWN" };
  }

  // 退還累積投入建材的 30%
  const refund = zeroCost();
  for (let level = 1; level <= current.level; level++) {
    const c = asAmounts(coreBuildingCost(current.building, level));
    refund.grain += c.grain * DEMOLISH.refundRatio;
    refund.timber += c.timber * DEMOLISH.refundRatio;
    refund.stone += c.stone * DEMOLISH.refundRatio;
    refund.iron += c.iron * DEMOLISH.refundRatio;
  }

  return {
    slot,
    building: current.building,
    refund,
    seconds: DEMOLISH_SECONDS,
    cooldownUntil: now + cooldownMs,
  };
}

function zeroCost(): Amounts {
  return { grain: 0, timber: 0, stone: 0, iron: 0 };
}

/** 這座建築給的能力說明，UI 用 */
export function describeCoreBuilding(building: CoreBuilding): string {
  return CORE_BUILDING[building].effect;
}

export function describeFacility(facility: Facility): string {
  const spec = FACILITY[facility];
  return spec.yields
    ? `${spec.label}：${spec.yields} ${spec.yieldCoefficient} × L^1.35 /h`
    : spec.label;
}
