import { describe, expect, it } from "vitest";

import { UNIT } from "./balance";
import type { CoreSlot, SlotState } from "./build";
import { zeroAmounts, type Amounts } from "./settle";
import {
  checkTrain,
  freeTrainQueues,
  garrisonPopulation,
  maxAffordable,
  mergeUnits,
  planTrain,
  producerOf,
  producersOf,
  queueFree,
  unlockState,
  unlockedUnits,
  type TrainState,
} from "./train";

const T0 = Date.UTC(2026, 7, 10);
const HOUR = 3_600_000;

const empty: Record<CoreSlot, SlotState> = {
  B: { building: null, level: 0 },
  C: { building: null, level: 0 },
  D: { building: null, level: 0 },
};

const withSlots = (over: Partial<Record<CoreSlot, SlotState>>) => ({ ...empty, ...over });

function state(over: Partial<TrainState> = {}): TrainState {
  return { slots: empty, queues: {}, militiaQueue: null, ...over };
}

const rich = (n = 1_000_000): Amounts => ({ grain: n, timber: n, stone: n, iron: n });

describe("★ 一座生產建築 = 一條招募佇列", () => {
  it("兵營解鎖步／弓兵，獸廄解鎖騎兵，工坊解鎖攻城", () => {
    expect(producerOf("SPEARMAN")).toBe("BARRACKS");
    expect(producerOf("RAIDER")).toBe("STABLE");
    expect(producerOf("RAM")).toBe("WORKSHOP");
  });

  it("民兵不需要任何建築 —— 否則沒蓋兵營的人一個兵都招不了", () => {
    expect(producerOf("MILITIA")).toBeNull();
    expect(unlockState("MILITIA", empty).ok).toBe(true);
  });

  it("沒有兵營就招不了長矛兵", () => {
    const r = unlockState("SPEARMAN", empty);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("NO_PRODUCER");
  });

  it("★「等級不夠」與「沒有這座建築」要分開講", () => {
    const low = unlockState("SWORDSMAN", withSlots({ B: { building: "BARRACKS", level: 2 } }));
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.reason).toBe("PRODUCER_LEVEL");

    const ok = unlockState("SWORDSMAN", withSlots({ B: { building: "BARRACKS", level: 5 } }));
    expect(ok.ok).toBe(true);
  });

  it("三座生產建築就有三條佇列，加上民兵共四條", () => {
    const s = state({
      slots: withSlots({
        B: { building: "BARRACKS", level: 3 },
        C: { building: "STABLE", level: 3 },
        D: { building: "WORKSHOP", level: 1 },
      }),
    });
    expect(producersOf(s.slots)).toHaveLength(3);
    expect(freeTrainQueues(s, T0)).toBe(4);
  });

  it("倉庫與城牆不是生產建築", () => {
    const s = state({
      slots: withSlots({
        B: { building: "DEPOT", level: 5 },
        C: { building: "RAMPART", level: 5 },
      }),
    });
    expect(producersOf(s.slots)).toHaveLength(0);
    expect(freeTrainQueues(s, T0)).toBe(1); // 只剩民兵
  });

  it("★ 各條佇列互不影響 —— 兵營忙著不擋獸廄", () => {
    const s = state({
      slots: withSlots({
        B: { building: "BARRACKS", level: 5 },
        C: { building: "STABLE", level: 5 },
      }),
      queues: { BARRACKS: { doneAt: T0 + HOUR } },
    });
    expect(queueFree(s, "BARRACKS", T0)).toBe(false);
    expect(queueFree(s, "STABLE", T0)).toBe(true);
    expect(freeTrainQueues(s, T0)).toBe(2); // 民兵 + 獸廄
  });
});

describe("planTrain", () => {
  const barracks = state({ slots: withSlots({ B: { building: "BARRACKS", level: 5 } }) });

  it("成本與人口都是**每人 × 數量**", () => {
    const plan = planTrain(barracks, "SPEARMAN", 10, T0);
    expect("reason" in plan).toBe(false);
    if ("reason" in plan) return;
    expect(plan.cost.grain).toBe(UNIT.SPEARMAN.cost.grain * 10);
    expect(plan.population).toBe(UNIT.SPEARMAN.population * 10);
  });

  it("★ 時間也是每人 × 數量 —— 否則一次下大單就是沒有代價的最佳解", () => {
    const one = planTrain(barracks, "SPEARMAN", 1, T0);
    const hundred = planTrain(barracks, "SPEARMAN", 100, T0);
    if ("reason" in one || "reason" in hundred) throw new Error("planTrain failed");
    expect(hundred.seconds).toBeCloseTo(one.seconds * 100, 6);
  });

  it("兵營等級提高招募速度（+5%/等級）", () => {
    const lv1 = planTrain(
      state({ slots: withSlots({ B: { building: "BARRACKS", level: 1 } }) }),
      "SPEARMAN",
      10,
      T0,
    );
    const lv10 = planTrain(
      state({ slots: withSlots({ B: { building: "BARRACKS", level: 10 } }) }),
      "SPEARMAN",
      10,
      T0,
    );
    if ("reason" in lv1 || "reason" in lv10) throw new Error("planTrain failed");
    expect(lv10.seconds).toBeLessThan(lv1.seconds);
  });

  it("佇列忙碌時擋下來", () => {
    const busy = state({
      slots: withSlots({ B: { building: "BARRACKS", level: 5 } }),
      queues: { BARRACKS: { doneAt: T0 + HOUR } },
    });
    expect(planTrain(busy, "SPEARMAN", 1, T0)).toEqual({ reason: "QUEUE_BUSY" });
    // 到期之後就放行
    expect("reason" in planTrain(busy, "SPEARMAN", 1, T0 + 2 * HOUR)).toBe(false);
  });

  it("數量必須是正整數", () => {
    expect(planTrain(barracks, "SPEARMAN", 0, T0)).toEqual({ reason: "NON_POSITIVE" });
    expect(planTrain(barracks, "SPEARMAN", -5, T0)).toEqual({ reason: "NON_POSITIVE" });
    expect(planTrain(barracks, "SPEARMAN", NaN, T0)).toEqual({ reason: "NON_POSITIVE" });
  });

  it("不認得的兵種", () => {
    expect(planTrain(barracks, "🐟", 1, T0)).toEqual({ reason: "UNKNOWN_UNIT" });
  });

  it("季節影響招募速度", () => {
    const normal = planTrain(barracks, "SPEARMAN", 10, T0);
    const fast = planTrain(barracks, "SPEARMAN", 10, T0, { trainingModifier: 1.3 });
    if ("reason" in normal || "reason" in fast) throw new Error("planTrain failed");
    expect(fast.seconds).toBeLessThan(normal.seconds);
  });
});

describe("checkTrain", () => {
  const barracks = state({ slots: withSlots({ B: { building: "BARRACKS", level: 5 } }) });
  const plan = () => {
    const p = planTrain(barracks, "SPEARMAN", 10, T0);
    if ("reason" in p) throw new Error("planTrain failed");
    return p;
  };

  it("資源夠、人口夠就過", () => {
    expect(checkTrain(plan(), rich(), 1_000_000, 1000)).toEqual({ ok: true });
  });

  it("資源不夠", () => {
    expect(checkTrain(plan(), zeroAmounts(), 1_000_000, 1000)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_RESOURCES",
    });
  });

  it("人口不夠", () => {
    expect(checkTrain(plan(), rich(), 1_000_000, 0)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_POPULATION",
    });
  });

  it("★ 一次下的單超過倉庫容量 = 永遠湊不齊，跟「現在不夠」是兩回事", () => {
    expect(checkTrain(plan(), rich(), 10, 1000)).toEqual({
      ok: false,
      reason: "EXCEEDS_CAPACITY",
    });
  });
});

describe("maxAffordable：UI 與執政官算出來的必須一樣", () => {
  it("被最緊的那一項限制住", () => {
    const spec = UNIT.SPEARMAN;
    // 糧食只夠 5 個
    const resources: Amounts = { ...rich(), grain: spec.cost.grain * 5 };
    expect(maxAffordable("SPEARMAN", resources, 1_000_000, 1000)).toBe(5);
  });

  it("人口也是一道閘門", () => {
    expect(maxAffordable("SPEARMAN", rich(), 1_000_000, 3)).toBe(3);
  });

  it("倉庫上限也是 —— 湊不到的量不該被算進來", () => {
    const cap = UNIT.SPEARMAN.cost.grain * 7;
    expect(maxAffordable("SPEARMAN", rich(), cap, 1000)).toBeLessThanOrEqual(7);
  });

  it("什麼都沒有就是 0，不會是負數", () => {
    expect(maxAffordable("SPEARMAN", zeroAmounts(), 0, 0)).toBe(0);
  });

  it("騎兵吃兩點人口", () => {
    expect(UNIT.RAIDER.population).toBe(2);
    expect(maxAffordable("RAIDER", rich(), 1_000_000, 5)).toBe(2);
  });
});

describe("駐軍", () => {
  it("同兵種累加", () => {
    const g = mergeUnits(mergeUnits({}, "SPEARMAN", 10), "SPEARMAN", 5);
    expect(g.SPEARMAN).toBe(15);
  });

  it("不同兵種各自記", () => {
    const g = mergeUnits(mergeUnits({}, "SPEARMAN", 10), "RAIDER", 3);
    expect(g).toEqual({ SPEARMAN: 10, RAIDER: 3 });
  });

  it("駐軍佔的人口照兵種算", () => {
    expect(garrisonPopulation({ SPEARMAN: 10, RAIDER: 3 })).toBe(
      10 * UNIT.SPEARMAN.population + 3 * UNIT.RAIDER.population,
    );
  });
});

describe("unlockedUnits：UI 只列招得動的", () => {
  it("什麼都沒蓋就只有民兵", () => {
    expect(unlockedUnits(empty)).toEqual(["MILITIA"]);
  });

  it("兵營 Lv7 解鎖長矛兵、斥候、劍士、弓兵", () => {
    const list = unlockedUnits(withSlots({ B: { building: "BARRACKS", level: 7 } }));
    expect(list).toContain("SPEARMAN");
    expect(list).toContain("SCOUT");
    expect(list).toContain("SWORDSMAN");
    expect(list).toContain("ARCHER");
    expect(list).not.toContain("RAIDER");
  });

  it("★ 遺跡單位不走招募路徑 —— 它們由檔案館解鎖（docs/17）", () => {
    const list = unlockedUnits(
      withSlots({
        B: { building: "ARCHIVE", level: 20 },
      }),
    );
    expect(list).not.toContain("WASTE_GUARD");
    expect(list).not.toContain("RUIN_WATCHER");
  });
});
