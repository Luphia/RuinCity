import { describe, expect, it } from "vitest";

import { SEASON_MODIFIERS, type Season } from "./balance";
import { DEMOLISH_COOLDOWN_MS, type CoreSlot } from "./build";
import { deriveRates, type TileWithFacility } from "./economy-state";
import {
  createEventApplier,
  depotLevelOf,
  deriveQueues,
  parsePayload,
  resolveEvent,
  type WorldState,
} from "./events";
import { settlePlayer, zeroAmounts, type PlayerEconomy, type ScheduledEvent } from "./settle";

const T0 = Date.UTC(2026, 7, 10);
const HOUR = 3_600_000;

const modifiersOf = (s: Season) => ({
  production: SEASON_MODIFIERS[s].production,
  upkeep: SEASON_MODIFIERS[s].upkeep,
});

function world(over: Partial<WorldState> = {}): WorldState {
  return {
    citadel: 5,
    slots: {
      B: { building: null, level: 0 },
      C: { building: null, level: 0 },
      D: { building: null, level: 0 },
    },
    tiles: [],
    lastDemolishAt: null,
    ...over,
  };
}

function economyFor(w: WorldState, resources = 0): PlayerEconomy {
  const d = deriveRates({
    citadel: w.citadel,
    depotLevel: depotLevelOf(w.slots),
    tiles: w.tiles,
  });
  return {
    resources: { grain: resources, timber: resources, stone: resources, iron: resources },
    baseRates: d.baseRates,
    baseUpkeep: zeroAmounts(),
    capacity: d.capacity,
    population: { amount: 0, rate: d.populationRate, cap: d.populationCap, used: 0 },
    settledAt: T0,
  };
}

const ev = (
  id: number,
  type: string,
  resolveAt: number,
  payload: unknown,
): ScheduledEvent => ({ id, type, resolveAt, seq: 0, payload });

describe("parsePayload", () => {
  it("認得核心建造", () => {
    expect(parsePayload("BUILD_DONE", { kind: "CORE", target: "CITADEL", toLevel: 6 })).toEqual({
      kind: "CORE",
      target: "CITADEL",
      building: null,
      toLevel: 6,
    });
  });

  it("認得設施建造", () => {
    const p = parsePayload("BUILD_DONE", {
      kind: "FACILITY",
      x: 3,
      y: 4,
      facility: "FARM",
      toLevel: 2,
      queueIndex: 1,
    });
    expect(p).toMatchObject({ kind: "FACILITY", x: 3, y: 4, facility: "FARM", queueIndex: 1 });
  });

  it("★ 認不出來的 payload 回 null，不會炸掉結算", () => {
    expect(parsePayload("BUILD_DONE", { target: "Z", toLevel: 1 })).toBeNull();
    expect(parsePayload("BUILD_DONE", { kind: "FACILITY", x: 1, y: 1, facility: "🐟" })).toBeNull();
    expect(parsePayload("MARCH_ARRIVE", { anything: true })).toBeNull();
    expect(parsePayload("CLAIM_DONE", null)).toBeNull();
  });

  it("缺欄位時用安全的預設值，而不是 NaN", () => {
    const p = parsePayload("CLAIM_DONE", { x: 1, y: 2 });
    expect(p).toEqual({ kind: "CLAIM", x: 1, y: 2, militia: 0, terrain: "PLAIN", queueIndex: 0 });
  });
});

describe("resolveEvent", () => {
  it("升主堡改的是主堡等級", () => {
    const r = resolveEvent(world(), { kind: "CORE", target: "CITADEL", building: null, toLevel: 6 });
    expect(r.world.citadel).toBe(6);
  });

  it("升 B/C/D 時沿用原本的建築種類", () => {
    const w = world({
      slots: {
        B: { building: "BARRACKS", level: 2 },
        C: { building: null, level: 0 },
        D: { building: null, level: 0 },
      },
    });
    const r = resolveEvent(w, { kind: "CORE", target: "B", building: null, toLevel: 3 });
    expect(r.world.slots.B).toEqual({ building: "BARRACKS", level: 3 });
  });

  it("拓荒把新的一格加進來，並佔用民兵", () => {
    const r = resolveEvent(world(), {
      kind: "CLAIM",
      x: 10,
      y: 11,
      militia: 5,
      terrain: "FOREST",
      queueIndex: 0,
    });
    expect(r.world.tiles).toHaveLength(1);
    expect(r.world.tiles[0]).toMatchObject({ x: 10, y: 11, terrain: "FOREST", state: "NORMAL" });
    expect(r.populationUsedDelta).toBe(5);
  });

  it("★ 同一塊地重複結算不會變成兩塊", () => {
    const payload = {
      kind: "CLAIM" as const,
      x: 10,
      y: 11,
      militia: 5,
      terrain: "PLAIN" as const,
      queueIndex: 0,
    };
    const once = resolveEvent(world(), payload);
    const twice = resolveEvent(once.world, payload);
    expect(twice.world.tiles).toHaveLength(1);
    expect(twice.populationUsedDelta).toBe(0);
  });

  it("拆除清空格子並退款", () => {
    const w = world({
      slots: {
        B: { building: "BARRACKS", level: 3 },
        C: { building: null, level: 0 },
        D: { building: null, level: 0 },
      },
    });
    const r = resolveEvent(w, {
      kind: "DEMOLISH",
      slot: "B",
      refund: { grain: 0, timber: 100, stone: 50, iron: 0 },
      cooldownUntil: T0 + DEMOLISH_COOLDOWN_MS,
    });
    expect(r.world.slots.B).toEqual({ building: null, level: 0 });
    expect(r.credit.timber).toBe(100);
  });

  it("★ 孤立時限到了才放棄；中途接回來的不放棄", () => {
    const isolated: TileWithFacility = {
      x: 1,
      y: 1,
      state: "ISOLATED",
      facility: null,
      facilityLevel: 0,
      terrain: "PLAIN",
    };
    const gone = resolveEvent(world({ tiles: [isolated] }), {
      kind: "ISOLATION_EXPIRE",
      x: 1,
      y: 1,
    });
    expect(gone.world.tiles).toHaveLength(0);

    const kept = resolveEvent(world({ tiles: [{ ...isolated, state: "NORMAL" }] }), {
      kind: "ISOLATION_EXPIRE",
      x: 1,
      y: 1,
    });
    expect(kept.world.tiles).toHaveLength(1);
  });
});

describe("★ 事件套進分段積分：速率在事件那一刻才改變", () => {
  it("農田在第 1 小時蓋好，前 1 小時用舊速率、後 1 小時用新速率", () => {
    const w = world({
      tiles: [
        { x: 1, y: 0, state: "NORMAL", facility: null, facilityLevel: 0, terrain: "PLAIN" },
      ],
    });
    const applier = createEventApplier(w);
    const e = economyFor(w);

    const before = deriveRates({ citadel: 5, depotLevel: 0, tiles: w.tiles }).baseRates.grain;
    const after = deriveRates({
      citadel: 5,
      depotLevel: 0,
      tiles: [{ ...w.tiles[0]!, facility: "FARM", facilityLevel: 3 }],
    }).baseRates.grain;
    expect(after).toBeGreaterThan(before);

    const r = settlePlayer(
      e,
      [
        ev(1, "BUILD_DONE", T0 + HOUR, {
          kind: "FACILITY",
          x: 1,
          y: 0,
          facility: "FARM",
          toLevel: 3,
          queueIndex: 0,
        }),
      ],
      T0 + 2 * HOUR,
      { seasonStartedAt: T0, modifiersOf, apply: applier.apply },
    );

    const spring = SEASON_MODIFIERS.SPRING.production;
    expect(r.economy.resources.grain).toBeCloseTo((before + after) * spring, 4);
    expect(applier.world().tiles[0]!.facilityLevel).toBe(3);
  });

  it("★ 對比：如果事件不改速率，兩小時都是舊速率 —— 玩家等於白花資源", () => {
    const w = world({
      tiles: [
        { x: 1, y: 0, state: "NORMAL", facility: null, facilityLevel: 0, terrain: "PLAIN" },
      ],
    });
    const e = economyFor(w);
    const before = deriveRates({ citadel: 5, depotLevel: 0, tiles: w.tiles }).baseRates.grain;

    const naive = settlePlayer(
      e,
      [
        ev(1, "BUILD_DONE", T0 + HOUR, {
          kind: "FACILITY",
          x: 1,
          y: 0,
          facility: "FARM",
          toLevel: 3,
          queueIndex: 0,
        }),
      ],
      T0 + 2 * HOUR,
      { seasonStartedAt: T0, modifiersOf, apply: (x) => x },
    );

    expect(naive.economy.resources.grain).toBeCloseTo(
      2 * before * SEASON_MODIFIERS.SPRING.production,
      4,
    );
  });

  it("主堡升級同時提高上限、人口上限與保底產出", () => {
    const w = world({ citadel: 5 });
    const applier = createEventApplier(w);
    const r = settlePlayer(
      economyFor(w),
      [ev(1, "BUILD_DONE", T0 + HOUR, { kind: "CORE", target: "CITADEL", toLevel: 6 })],
      T0 + 2 * HOUR,
      { seasonStartedAt: T0, modifiersOf, apply: applier.apply },
    );
    const d6 = deriveRates({ citadel: 6, depotLevel: 0, tiles: [] });
    expect(r.economy.capacity).toBe(d6.capacity);
    expect(r.economy.population.cap).toBe(d6.populationCap);
    expect(applier.world().citadel).toBe(6);
  });

  it("拆除退款受儲存上限約束，不會瞬間爆倉", () => {
    const w = world({
      citadel: 3,
      slots: {
        B: { building: "BARRACKS", level: 3 },
        C: { building: null, level: 0 },
        D: { building: null, level: 0 },
      },
    });
    const applier = createEventApplier(w);
    const cap = deriveRates({ citadel: 3, depotLevel: 0, tiles: [] }).capacity;

    const r = settlePlayer(
      { ...economyFor(w), resources: { grain: cap, timber: cap, stone: cap, iron: cap } },
      [
        ev(1, "DEMOLISH_DONE", T0 + HOUR, {
          kind: "DEMOLISH",
          slot: "B",
          refund: { grain: 0, timber: 99_999, stone: 0, iron: 0 },
          cooldownUntil: T0 + DEMOLISH_COOLDOWN_MS,
        }),
      ],
      T0 + 2 * HOUR,
      { seasonStartedAt: T0, modifiersOf, apply: applier.apply },
    );

    expect(r.economy.resources.timber).toBeLessThanOrEqual(cap);
    expect(applier.world().slots.B.building).toBeNull();
  });

  it("認不出來的事件被跳過，其餘照常結算", () => {
    const applier = createEventApplier(world());
    const r = settlePlayer(
      economyFor(world()),
      [
        ev(1, "MARCH_ARRIVE", T0 + HOUR, { units: {} }),
        ev(2, "BUILD_DONE", T0 + HOUR, { kind: "CORE", target: "CITADEL", toLevel: 6 }),
      ],
      T0 + 2 * HOUR,
      { seasonStartedAt: T0, modifiersOf, apply: applier.apply },
    );
    expect(applier.skipped()).toHaveLength(1);
    expect(applier.world().citadel).toBe(6);
    // 兩個事件都算「處理過」—— MARCH_ARRIVE 由 M3 的 applier 接手
    expect(r.resolved).toHaveLength(2);
  });
});

describe("deriveQueues：佇列是事件表的一個 view", () => {
  const core = ev(1, "BUILD_DONE", T0 + HOUR, {
    kind: "CORE",
    target: "CITADEL",
    toLevel: 6,
  });
  const facility = ev(2, "BUILD_DONE", T0 + 2 * HOUR, {
    kind: "FACILITY",
    x: 1,
    y: 1,
    facility: "FARM",
    toLevel: 1,
    queueIndex: 1,
  });

  it("未到期的核心事件佔住核心佇列", () => {
    const q = deriveQueues([core], T0, 2);
    expect(q.coreQueue).toEqual({ target: "CITADEL", doneAt: T0 + HOUR });
  });

  it("★ 已到期的事件不佔佇列 —— 否則玩家要多等一次讀取才能下一單", () => {
    expect(deriveQueues([core], T0 + 2 * HOUR, 2).coreQueue).toBeNull();
  });

  it("設施事件佔住它自己那一條領土佇列", () => {
    const q = deriveQueues([facility], T0, 2);
    expect(q.territoryQueue[0]).toBeNull();
    expect(q.territoryQueue[1]).toEqual({ doneAt: T0 + 2 * HOUR });
  });

  it("超出佇列數的 queueIndex 被忽略，不會寫到陣列外", () => {
    const q = deriveQueues([{ ...facility, payload: { ...(facility.payload as object), queueIndex: 9 } }], T0, 2);
    expect(q.territoryQueue).toEqual([null, null]);
  });

  it("★ 拆除冷卻從下單起算，不是從完工起算", () => {
    const requestedAt = T0 - 1000;
    const q = deriveQueues(
      [
        ev(3, "DEMOLISH_DONE", T0 + 3 * HOUR, {
          kind: "DEMOLISH",
          slot: "B",
          refund: zeroAmounts(),
          cooldownUntil: requestedAt + DEMOLISH_COOLDOWN_MS,
        }),
      ],
      T0,
      2,
    );
    expect(q.lastDemolishAt).toBe(requestedAt);
    // 拆除也佔核心佇列
    expect(q.coreQueue).toEqual({ target: "B" as CoreSlot, doneAt: T0 + 3 * HOUR });
  });
});
