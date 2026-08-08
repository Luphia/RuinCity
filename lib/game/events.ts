/**
 * 事件結算：把一個到期的事件套用到玩家的**結構狀態**上。純函式，無 I/O。
 *
 * ## ★ 為什麼需要這一層
 *
 * `settle.ts` 負責的是「速率 × 時間」的積分，它**不知道**事件的內容 ——
 * 它只知道「這個時間點速率變了，切一段」。真正決定速率怎麼變的是這裡：
 * 蓋好一座農田、佔到一塊地、拆掉一座建築，都會改變 `deriveRates()` 的輸入。
 *
 * 少了這一層，玩家花掉的資源就永遠換不到東西 ——
 * 事件會被標記成已結算，但主堡等級不會動。
 *
 * ## ★ 為什麼 `createEventApplier` 有可變狀態
 *
 * `settlePlayer` 的 `apply` 簽章是 `(economy, event) => economy`，
 * 它不搬運結構狀態。但結構狀態**必須**在分段積分的中途改變 ——
 * 農田是在第 3 小時蓋好的，不是在結算的最後。
 *
 * 所以這裡用一個 closure 把結構狀態帶著走。它仍然是**確定性**的：
 * 同一組 (初始狀態, 事件序列) 永遠得到同一個結果，賽季模擬照樣能重放。
 * 不確定性的來源只有 I/O，而這裡一個都沒有。
 */

import type { CoreBuilding, Facility, Terrain, Unit } from "./balance";
import { UNITS } from "./balance";
import { mergeUnits, PRODUCERS, type Producer } from "./train";
import { CORE_SLOTS, DEMOLISH_COOLDOWN_MS, type CoreSlot, type SlotState } from "./build";
import { deriveRates, outpostUpkeep, type TileWithFacility } from "./economy-state";
import { zeroAmounts, type Amounts, type PlayerEconomy, type ScheduledEvent } from "./settle";
import { CORE_BUILDINGS, FACILITIES } from "./balance";

/** 玩家的結構狀態 —— 決定速率的那些東西 */
export interface WorldState {
  readonly citadel: number;
  readonly slots: Readonly<Record<CoreSlot, SlotState>>;
  readonly tiles: readonly TileWithFacility[];
  readonly lastDemolishAt: number | null;
  /** 本營駐軍。行軍與戰鬥是 M3，這裡只有「招募完成後放哪裡」 */
  readonly garrison: Readonly<Partial<Record<Unit, number>>>;
  /** 出生環帶的領土容量加成。整場賽季不變，但每次重算速率都要帶上 */
  readonly bandBonus?: number;
}

export type M2Payload =
  | {
      readonly kind: "CORE";
      readonly target: "CITADEL" | CoreSlot;
      readonly building: CoreBuilding | null;
      readonly toLevel: number;
    }
  | {
      readonly kind: "FACILITY";
      readonly x: number;
      readonly y: number;
      readonly facility: Facility;
      readonly toLevel: number;
      readonly queueIndex: number;
    }
  | {
      readonly kind: "CLAIM";
      readonly x: number;
      readonly y: number;
      readonly militia: number;
      readonly terrain: Terrain;
      readonly level: number;
      readonly queueIndex: number;
    }
  | {
      readonly kind: "DEMOLISH";
      readonly slot: CoreSlot;
      readonly refund: Amounts;
      readonly cooldownUntil: number;
    }
  | { readonly kind: "ISOLATION_EXPIRE"; readonly x: number; readonly y: number }
  | { readonly kind: "DELIVERY"; readonly listingId: number; readonly amounts: Amounts }
  | {
      readonly kind: "TRAIN";
      readonly unit: Unit;
      readonly count: number;
      /** null = 民兵佇列 */
      readonly producer: string | null;
    };

const isSlot = (v: unknown): v is CoreSlot => CORE_SLOTS.includes(v as CoreSlot);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function amountsOf(v: unknown): Amounts {
  const o = (v ?? {}) as Partial<Record<keyof Amounts, unknown>>;
  const out = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    if (isNum(o[r])) out[r] = o[r];
  }
  return out;
}

/**
 * 把資料庫裡的 jsonb 轉成型別化的 payload。
 *
 * ★ 一律當作不可信輸入處理。事件表是我們自己寫的，但 schema 會演進，
 *   而舊事件會留在表裡 —— 認不出來就回 `null` 讓呼叫端跳過，
 *   不要讓一筆壞資料把整個結算炸掉。
 */
export function parsePayload(type: string, raw: unknown): M2Payload | null {
  const p = (raw ?? {}) as Record<string, unknown>;

  switch (type) {
    case "BUILD_DONE": {
      if (p.kind === "FACILITY") {
        if (!isNum(p.x) || !isNum(p.y) || !isNum(p.toLevel)) return null;
        if (!FACILITIES.includes(p.facility as Facility)) return null;
        return {
          kind: "FACILITY",
          x: p.x,
          y: p.y,
          facility: p.facility as Facility,
          toLevel: p.toLevel,
          queueIndex: isNum(p.queueIndex) ? p.queueIndex : 0,
        };
      }
      if (!isNum(p.toLevel)) return null;
      if (p.target !== "CITADEL" && !isSlot(p.target)) return null;
      const building =
        typeof p.building === "string" && CORE_BUILDINGS.includes(p.building as CoreBuilding)
          ? (p.building as CoreBuilding)
          : null;
      return { kind: "CORE", target: p.target, building, toLevel: p.toLevel };
    }

    case "CLAIM_DONE": {
      if (!isNum(p.x) || !isNum(p.y)) return null;
      return {
        kind: "CLAIM",
        x: p.x,
        y: p.y,
        militia: isNum(p.militia) ? p.militia : 0,
        terrain: (typeof p.terrain === "string" ? p.terrain : "PLAIN") as Terrain,
        level: isNum(p.level) ? p.level : 1,
        queueIndex: isNum(p.queueIndex) ? p.queueIndex : 0,
      };
    }

    case "DEMOLISH_DONE": {
      if (!isSlot(p.slot)) return null;
      return {
        kind: "DEMOLISH",
        slot: p.slot,
        refund: amountsOf(p.refund),
        cooldownUntil: isNum(p.cooldownUntil) ? p.cooldownUntil : 0,
      };
    }

    case "ISOLATION_EXPIRE": {
      if (!isNum(p.x) || !isNum(p.y)) return null;
      return { kind: "ISOLATION_EXPIRE", x: p.x, y: p.y };
    }

    case "TRAIN_DONE": {
      if (!isNum(p.count) || p.count <= 0) return null;
      if (!UNITS.includes(p.unit as Unit)) return null;
      return {
        kind: "TRAIN",
        unit: p.unit as Unit,
        count: Math.floor(p.count),
        producer: typeof p.producer === "string" ? p.producer : null,
      };
    }

    case "MARKET_DELIVERY": {
      if (!isNum(p.listingId)) return null;
      return { kind: "DELIVERY", listingId: p.listingId, amounts: amountsOf(p.amounts) };
    }

    default:
      return null;
  }
}

export interface ResolveOutcome {
  readonly world: WorldState;
  /** 要加回資源池的量（目前只有拆除退款） */
  readonly credit: Amounts;
  /** `population.used` 的變化（拓荒隊帶走的民兵） */
  readonly populationUsedDelta: number;
}

/** 套用一個事件到結構狀態上。不改資源速率 —— 那由呼叫端重算 */
export function resolveEvent(world: WorldState, payload: M2Payload): ResolveOutcome {
  const none = { credit: zeroAmounts(), populationUsedDelta: 0 };

  switch (payload.kind) {
    case "CORE": {
      if (payload.target === "CITADEL") {
        return { ...none, world: { ...world, citadel: payload.toLevel } };
      }
      const prev = world.slots[payload.target];
      return {
        ...none,
        world: {
          ...world,
          slots: {
            ...world.slots,
            // 新建時 payload 帶著 building；升級時沿用原本的
            [payload.target]: {
              building: payload.building ?? prev.building,
              level: payload.toLevel,
            },
          },
        },
      };
    }

    case "FACILITY": {
      const tiles = world.tiles.map((t) =>
        t.x === payload.x && t.y === payload.y
          ? { ...t, facility: payload.facility, facilityLevel: payload.toLevel }
          : t,
      );
      return { ...none, world: { ...world, tiles } };
    }

    case "CLAIM": {
      // 已經有了就不重複加 —— 事件結算必須冪等
      if (world.tiles.some((t) => t.x === payload.x && t.y === payload.y)) {
        return { ...none, world };
      }
      const tile: TileWithFacility = {
        x: payload.x,
        y: payload.y,
        state: "NORMAL",
        facility: null,
        facilityLevel: 0,
        terrain: payload.terrain,
        level: payload.level,
      };
      /**
       * ★ 人口在**下單時**就被扣了（`base-ops.ts` 的 `claimTileFor`）。
       *   這裡再扣一次就是扣兩次 —— 拓荒隊出發那一刻人就走了，
       *   不是立旗那一刻才走。
       */
      return { ...none, world: { ...world, tiles: [...world.tiles, tile] } };
    }

    case "DEMOLISH": {
      return {
        credit: payload.refund,
        populationUsedDelta: 0,
        // `lastDemolishAt` 不在這裡設 —— 冷卻從**下單**起算，
        // 由 `deriveQueues` 從事件的 `cooldownUntil` 反推
        world: {
          ...world,
          slots: { ...world.slots, [payload.slot]: { building: null, level: 0 } },
        },
      };
    }

    case "TRAIN": {
      /**
       * ★ 只把部隊放進駐軍，**不動人口** ——
       *   人口在下單時就被佔用了（`train.ts` 的開頭）。
       *   在這裡再扣一次就是扣兩次。
       */
      return {
        ...none,
        world: {
          ...world,
          garrison: mergeUnits(world.garrison, payload.unit, payload.count),
        },
      };
    }

    case "DELIVERY": {
      // 商隊送達。只加資源，不動結構 ——
      // 儲存上限由 applier 統一套（`docs/03` §5：不能拿盟友的倉庫當第二個倉庫）
      return { world, credit: payload.amounts, populationUsedDelta: 0 };
    }

    case "ISOLATION_EXPIRE": {
      // 時限內沒接回來就自動放棄（`docs/02` §2.4）。
      // 只有**還在孤立中**的格才放棄 —— 中途接回來的不算
      const target = world.tiles.find((t) => t.x === payload.x && t.y === payload.y);
      if (!target || target.state !== "ISOLATED") return { ...none, world };
      return {
        ...none,
        world: {
          ...world,
          tiles: world.tiles.filter((t) => !(t.x === payload.x && t.y === payload.y)),
        },
      };
    }
  }
}

/** 從結構狀態算出目前的倉庫等級（`deriveRates` 要） */
export function depotLevelOf(slots: WorldState["slots"]): number {
  for (const s of CORE_SLOTS) if (slots[s].building === "DEPOT") return slots[s].level;
  return 0;
}

export interface EventApplier {
  /** 直接餵給 `settlePlayer` 的 `ctx.apply` */
  readonly apply: (economy: PlayerEconomy, event: ScheduledEvent) => PlayerEconomy;
  /** 結算結束後的結構狀態 —— 呼叫端拿它寫回資料庫 */
  readonly world: () => WorldState;
  /** 這次結算裡跳過的事件（payload 認不出來） */
  readonly skipped: () => readonly ScheduledEvent[];
}

/**
 * 造一個把事件套進結算流程的 applier。
 *
 * 每套用一個事件就**重算一次速率**，下一段積分才會用到新的速率 ——
 * 這正是分段積分存在的理由。
 */
export function createEventApplier(initial: WorldState): EventApplier {
  let world = initial;
  const skipped: ScheduledEvent[] = [];

  const apply = (economy: PlayerEconomy, event: ScheduledEvent): PlayerEconomy => {
    const payload = parsePayload(event.type, event.payload);
    if (!payload) {
      skipped.push(event);
      return economy;
    }

    const outcome = resolveEvent(world, payload);
    world = outcome.world;

    const derived = deriveRates({
      citadel: world.citadel,
      depotLevel: depotLevelOf(world.slots),
      tiles: world.tiles,
      bandBonus: world.bandBonus,
    });

    const resources = { ...economy.resources };
    for (const r of ["grain", "timber", "stone", "iron"] as const) {
      // 退款也受儲存上限約束 —— 拆一座滿級兵營不能瞬間爆倉
      resources[r] = Math.min(derived.capacity, resources[r] + outcome.credit[r]);
    }

    return {
      ...economy,
      resources,
      baseRates: derived.baseRates,
      baseUpkeep: outpostUpkeep(derived.outpostLevels),
      capacity: derived.capacity,
      population: {
        ...economy.population,
        rate: derived.populationRate,
        cap: derived.populationCap,
        used: Math.max(0, economy.population.used + outcome.populationUsedDelta),
      },
    };
  };

  return { apply, world: () => world, skipped: () => skipped };
}

// ─────────────────────────────────────────────────────────────
// 佇列狀態
// ─────────────────────────────────────────────────────────────

export interface QueueSnapshot {
  readonly coreQueue: { readonly target: "CITADEL" | CoreSlot; readonly doneAt: number } | null;
  readonly territoryQueue: readonly ({ readonly doneAt: number } | null)[];
  readonly lastDemolishAt: number | null;
  /** 每一座生產建築的招募佇列；`null` 這個鍵是民兵佇列 */
  readonly trainQueues: Readonly<Partial<Record<Producer, { readonly doneAt: number } | null>>>;
  readonly militiaQueue: { readonly doneAt: number } | null;
}

/**
 * 從**尚未結算**的事件推導出佇列狀態。
 *
 * ★ 佇列不是一張表，是事件表的一個 view。
 *   多存一份「目前在蓋什麼」就會有兩個真相，而它們遲早會不一致 ——
 *   已經到期但還沒被讀取結算的事件，就是那個「遲早」。
 *
 * @param queueCount 領土佇列數 `territoryQueues(主堡等級)`
 */
export function deriveQueues(
  pending: readonly ScheduledEvent[],
  now: number,
  queueCount: number,
): QueueSnapshot {
  let coreQueue: QueueSnapshot["coreQueue"] = null;
  const territoryQueue: ({ doneAt: number } | null)[] = Array.from({ length: queueCount }, () => null);
  let lastDemolishAt: number | null = null;
  const trainQueues: Partial<Record<Producer, { doneAt: number } | null>> = {};
  let militiaQueue: { doneAt: number } | null = null;

  for (const e of pending) {
    const p = parsePayload(e.type, e.payload);
    if (!p) continue;

    if (p.kind === "DEMOLISH") {
      // 冷卻從**下單**那一刻起算，而 `cooldownUntil` 是下單時算好的
      const requestedAt = p.cooldownUntil - DEMOLISH_COOLDOWN_MS;
      if (lastDemolishAt === null || requestedAt > lastDemolishAt) lastDemolishAt = requestedAt;
    }

    // 已經到期的事件不佔佇列 —— 它下一次結算就會被清掉
    if (e.resolveAt <= now) continue;

    switch (p.kind) {
      case "CORE":
        if (!coreQueue || e.resolveAt > coreQueue.doneAt) {
          coreQueue = { target: p.target, doneAt: e.resolveAt };
        }
        break;
      case "DEMOLISH":
        if (!coreQueue || e.resolveAt > coreQueue.doneAt) {
          coreQueue = { target: p.slot, doneAt: e.resolveAt };
        }
        break;
      case "TRAIN": {
        if (p.producer === null) {
          if (!militiaQueue || e.resolveAt > militiaQueue.doneAt) {
            militiaQueue = { doneAt: e.resolveAt };
          }
        } else if (PRODUCERS.includes(p.producer as Producer)) {
          const key = p.producer as Producer;
          const cur = trainQueues[key];
          if (!cur || e.resolveAt > cur.doneAt) trainQueues[key] = { doneAt: e.resolveAt };
        }
        break;
      }
      case "FACILITY":
      case "CLAIM": {
        const i = p.queueIndex;
        if (i >= 0 && i < queueCount) {
          const cur = territoryQueue[i];
          if (!cur || e.resolveAt > cur.doneAt) territoryQueue[i] = { doneAt: e.resolveAt };
        }
        break;
      }
      default:
        break;
    }
  }

  return { coreQueue, territoryQueue, lastDemolishAt, trainQueues, militiaQueue };
}
