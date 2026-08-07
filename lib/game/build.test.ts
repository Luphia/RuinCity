import { describe, expect, it } from "vitest";

import { CITADEL, DEMOLISH } from "./balance";
import {
  CORE_SLOTS,
  canAfford,
  checkBuild,
  exceedsCapacity,
  freeTerritoryQueue,
  planCoreBuild,
  planCoreConstruct,
  planDemolish,
  planFacility,
  type BuildState,
} from "./build";
import { citadelUpgradeCost, territoryQueues } from "./formulas";
import {
  ISOLATION_GRACE_MS,
  claimCost,
  claimMilitia,
  coreTiles,
  findDisconnected,
  isAdjacentToOwned,
  planClaim,
  recomputeIsolation,
  yieldMultiplierFor,
  type ClaimContext,
  type OwnedTile,
} from "./territory";

const NOW = 1_000_000;

function state(over: Partial<BuildState> = {}): BuildState {
  return {
    citadel: 10,
    slots: {
      B: { building: "BARRACKS", level: 5 },
      C: { building: null, level: 0 },
      D: { building: "DEPOT", level: 3 },
    },
    coreQueue: null,
    territoryQueue: [],
    lastDemolishAt: null,
    ...over,
  };
}

const rich = { grain: 1e9, timber: 1e9, stone: 1e9, iron: 1e9 };

describe("★ 核心佇列永遠只有一條", () => {
  it("佇列忙碌時，主堡與 B/C/D 全部擋下 —— 這是遊戲最尖銳的取捨", () => {
    const busy = state({ coreQueue: { target: "CITADEL", doneAt: NOW + 1000 } });
    expect(planCoreBuild(busy, "CITADEL", NOW)).toEqual({ reason: "CORE_QUEUE_BUSY" });
    expect(planCoreBuild(busy, "B", NOW)).toEqual({ reason: "CORE_QUEUE_BUSY" });
    expect(planCoreConstruct(busy, "C", "ARCHIVE", NOW)).toEqual({ reason: "CORE_QUEUE_BUSY" });
    expect(planDemolish(busy, "B", NOW)).toEqual({ reason: "CORE_QUEUE_BUSY" });
  });

  it("佇列到期後就放行", () => {
    const done = state({ coreQueue: { target: "CITADEL", doneAt: NOW } });
    expect(planCoreBuild(done, "CITADEL", NOW)).toHaveProperty("toLevel", 11);
  });

  it("領土佇列**不**受核心佇列影響（橫向鋪產出不佔核心取捨）", () => {
    const busy = state({ coreQueue: { target: "CITADEL", doneAt: NOW + 1000 } });
    expect(planFacility(busy, "FARM", 0, NOW)).toHaveProperty("toLevel", 1);
  });
});

describe("主堡與核心建築", () => {
  it("升級成本與時間來自數值表", () => {
    const plan = planCoreBuild(state(), "CITADEL", NOW);
    expect(plan).toMatchObject({ target: "CITADEL", fromLevel: 10, toLevel: 11 });
    if ("cost" in plan) {
      expect(plan.cost.timber).toBe(citadelUpgradeCost(11).timber);
    }
  });

  it("主堡滿級後不能再升", () => {
    const maxed = state({ citadel: CITADEL.maxLevel });
    expect(planCoreBuild(maxed, "CITADEL", NOW)).toEqual({ reason: "CITADEL_MAXED" });
  });

  it("★ 其他建築等級不得超過主堡", () => {
    const s = state({ citadel: 5, slots: { ...state().slots, B: { building: "BARRACKS", level: 5 } } });
    expect(planCoreBuild(s, "B", NOW)).toEqual({ reason: "ABOVE_CITADEL" });
  });

  it("空格不能升級，滿格不能重蓋", () => {
    expect(planCoreBuild(state(), "C", NOW)).toEqual({ reason: "SLOT_EMPTY" });
    expect(planCoreConstruct(state(), "B", "STABLE", NOW)).toEqual({ reason: "SLOT_OCCUPIED" });
  });

  it("只認得 7 種核心建築（7 選 3）", () => {
    expect(planCoreConstruct(state(), "C", "CASTLE", NOW)).toEqual({ reason: "UNKNOWN_BUILDING" });
    expect(planCoreConstruct(state(), "C", "ARCHIVE", NOW)).toHaveProperty("toLevel", 1);
    expect(CORE_SLOTS).toEqual(["B", "C", "D"]);
  });
});

describe("★ 買不起 vs 永遠存不到", () => {
  it("成本超過儲存上限要回報 EXCEEDS_CAPACITY，而不是 INSUFFICIENT", () => {
    // M1 的賽季模擬就在這裡卡過：主堡 Lv27 之後升級成本高於儲存上限，
    // 玩家會一直等一個永遠不會到的數字
    const plan = planCoreBuild(state({ citadel: 25 }), "CITADEL", NOW);
    expect("cost" in plan).toBe(true);
    if (!("cost" in plan)) return;

    const tiny = 1000;
    expect(exceedsCapacity(plan.cost, tiny)).toBe(true);
    expect(checkBuild(state({ citadel: 25 }), rich, tiny, plan)).toMatchObject({
      ok: false,
      reason: "EXCEEDS_CAPACITY",
    });
  });

  it("存得下但現在不夠 → INSUFFICIENT_RESOURCES", () => {
    const plan = planCoreBuild(state(), "CITADEL", NOW);
    const poor = { grain: 0, timber: 0, stone: 0, iron: 0 };
    expect(checkBuild(state(), poor, 1e9, plan)).toMatchObject({
      ok: false,
      reason: "INSUFFICIENT_RESOURCES",
    });
  });

  it("錢夠又存得下就通過", () => {
    const plan = planCoreBuild(state(), "CITADEL", NOW);
    expect(checkBuild(state(), rich, 1e9, plan).ok).toBe(true);
  });

  it("canAfford 逐項比對，不是比總和", () => {
    expect(canAfford({ grain: 10, timber: 0, stone: 0, iron: 0 }, { grain: 5, timber: 5, stone: 0, iron: 0 })).toBe(false);
  });
});

describe("領土設施佇列", () => {
  it("佇列數 = 1 + ⌊主堡等級 / 10⌋", () => {
    expect(territoryQueues(1)).toBe(1);
    expect(territoryQueues(10)).toBe(2);
    expect(territoryQueues(30)).toBe(4);
  });

  it("全部佔滿時擋下", () => {
    const s = state({
      citadel: 10, // 兩條
      territoryQueue: [{ doneAt: NOW + 1000 }, { doneAt: NOW + 1000 }],
    });
    expect(freeTerritoryQueue(s, NOW)).toBe(-1);
    expect(planFacility(s, "FARM", 0, NOW)).toEqual({ reason: "NO_FREE_QUEUE" });
  });

  it("挑第一條空的", () => {
    const s = state({ citadel: 10, territoryQueue: [{ doneAt: NOW + 1000 }, null] });
    expect(freeTerritoryQueue(s, NOW)).toBe(1);
  });

  it("設施等級上限 = ⌊主堡等級 / 1.6⌋", () => {
    const s = state({ citadel: 10 }); // 上限 6
    expect(planFacility(s, "FARM", 5, NOW)).toHaveProperty("toLevel", 6);
    expect(planFacility(s, "FARM", 6, NOW)).toEqual({ reason: "LEVEL_CAPPED" });
  });
});

describe("拆除", () => {
  it("退還累積投入的 30%，並進入冷卻", () => {
    const plan = planDemolish(state(), "B", NOW);
    expect("refund" in plan).toBe(true);
    if (!("refund" in plan)) return;
    expect(plan.refund.timber).toBeGreaterThan(0);
    expect(plan.cooldownUntil).toBeGreaterThan(NOW);
    expect(DEMOLISH.refundRatio).toBe(0.3);
  });

  it("★ 冷卻中不能再拆 —— 不能在每次被打之前臨時換 build", () => {
    const s = state({ lastDemolishAt: NOW - 1000 });
    expect(planDemolish(s, "B", NOW)).toEqual({ reason: "COOLDOWN" });
  });

  it("冷卻過了就放行", () => {
    const cooldownMs = (DEMOLISH.cooldownSeconds / 4) * 1000;
    const s = state({ lastDemolishAt: NOW - cooldownMs - 1 });
    expect(planDemolish(s, "B", NOW)).toHaveProperty("refund");
  });

  it("空格沒東西可拆", () => {
    expect(planDemolish(state(), "C", NOW)).toEqual({ reason: "SLOT_EMPTY" });
  });
});

// ─────────────────────────────────────────────────────────────

function claimCtx(over: Partial<ClaimContext> = {}): ClaimContext {
  return {
    baseX: 100,
    baseY: 100,
    owned: [],
    territoryCapacity: 40,
    terrainAt: () => "PLAIN",
    isBlocked: () => false,
    ...over,
  };
}

describe("領土佔領", () => {
  it("必須與已有領土或核心據點相鄰", () => {
    const ctx = claimCtx();
    expect(isAdjacentToOwned(ctx, 100, 99)).toBe(true); // 核心正上方
    expect(isAdjacentToOwned(ctx, 100, 97)).toBe(false);
    expect(planClaim(ctx, 100, 97)).toEqual({ reason: "NOT_ADJACENT" });
  });

  it("山脈不能佔，禁建圈不能佔", () => {
    expect(planClaim(claimCtx({ terrainAt: () => "MOUNTAIN" }), 100, 99)).toEqual({
      reason: "IMPASSABLE",
    });
    expect(planClaim(claimCtx({ isBlocked: () => true }), 100, 99)).toEqual({ reason: "BLOCKED" });
  });

  it("核心 2×2 已經是自己的，不能重複佔", () => {
    expect(planClaim(claimCtx(), 100, 100)).toEqual({ reason: "ALREADY_OWNED" });
    expect(coreTiles(100, 100)).toHaveLength(4);
  });

  it("超出領土容量就擋下", () => {
    const owned: OwnedTile[] = [{ x: 100, y: 99, state: "NORMAL" }];
    expect(planClaim(claimCtx({ owned, territoryCapacity: 1 }), 101, 99)).toEqual({
      reason: "AT_CAPACITY",
    });
  });

  it("★ 成本三重遞增：資源、民兵、時間都隨領土數上升", () => {
    const a = planClaim(claimCtx(), 100, 99);
    const owned: OwnedTile[] = Array.from({ length: 30 }, (_, i) => ({
      x: 100,
      y: 99 - i,
      state: "NORMAL" as const,
    }));
    const b = planClaim(claimCtx({ owned }), 101, 99);

    expect("cost" in a && "cost" in b).toBe(true);
    if (!("cost" in a) || !("cost" in b)) return;
    expect(b.cost.grain).toBeGreaterThan(a.cost.grain);
    expect(b.militia).toBeGreaterThan(a.militia);
    expect(b.seconds).toBeGreaterThan(a.seconds);
  });

  it("民兵是 5 + ⌊領土/10⌋，成本按 docs/11 §4", () => {
    expect(claimMilitia(0)).toBe(5);
    expect(claimMilitia(35)).toBe(8);
    expect(claimCost(0)).toEqual({ grain: 200, timber: 150 });
  });

  it("難走的地形立旗比較久", () => {
    const plain = planClaim(claimCtx(), 100, 99);
    const marsh = planClaim(claimCtx({ terrainAt: () => "MARSH" }), 100, 99);
    if (!("seconds" in plain) || !("seconds" in marsh)) throw new Error("planned");
    expect(marsh.seconds).toBeGreaterThan(plain.seconds);
  });
});

describe("★ 連通性與切細頸", () => {
  /** 從核心往上長一條 5 格的細頸 */
  const chain: OwnedTile[] = [
    { x: 100, y: 99, state: "NORMAL" },
    { x: 100, y: 98, state: "NORMAL" },
    { x: 100, y: 97, state: "NORMAL" },
    { x: 100, y: 96, state: "NORMAL" },
    { x: 100, y: 95, state: "NORMAL" },
  ];

  it("整條連著時沒有人被切斷", () => {
    expect(findDisconnected(100, 100, chain)).toEqual([]);
  });

  it("打掉細頸中間那一格，後面整串失效 —— 不用一格一格拔", () => {
    const cut = chain.filter((t) => t.y !== 97);
    const lost = findDisconnected(100, 100, cut);
    expect(lost.map((t) => t.y).sort()).toEqual([95, 96]);
  });

  it("recomputeIsolation 標記新孤立與重新接回的格子", () => {
    const cut = chain.filter((t) => t.y !== 97);
    const first = recomputeIsolation(100, 100, cut, NOW);
    expect(first.newlyIsolated).toHaveLength(2);
    expect(first.expireAt).toBe(NOW + ISOLATION_GRACE_MS);

    // 把細頸接回來
    const repaired = [...first.tiles, { x: 100, y: 97, state: "NORMAL" as const }];
    const second = recomputeIsolation(100, 100, repaired, NOW);
    expect(second.reconnected).toHaveLength(2);
    expect(second.newlyIsolated).toHaveLength(0);
    expect(second.tiles.every((t) => t.state === "NORMAL")).toBe(true);
  });

  it("★ ISOLATED 的格子不能當作繼續擴張的跳板", () => {
    const owned: OwnedTile[] = [{ x: 100, y: 96, state: "ISOLATED" }];
    expect(isAdjacentToOwned(claimCtx({ owned }), 100, 95)).toBe(false);
  });

  it("孤立領土產出減半", () => {
    expect(yieldMultiplierFor("ISOLATED")).toBe(0.5);
    expect(yieldMultiplierFor("NORMAL")).toBe(1);
    expect(yieldMultiplierFor("CONTESTED")).toBe(1);
  });

  it("對角線不算連通（只認 4 鄰）", () => {
    const diagonal: OwnedTile[] = [{ x: 102, y: 102, state: "NORMAL" }];
    expect(findDisconnected(100, 100, diagonal)).toHaveLength(1);
  });
});
