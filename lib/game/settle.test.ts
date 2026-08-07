import { describe, expect, it } from "vitest";

import { SEASON_MODIFIERS, STORAGE, type Season } from "./balance";
import { SEASON_DURATION_MS, realTimeOfGameMonth } from "./calendar";
import {
  SETTLE_RESOURCES,
  availablePopulation,
  hoursUntilOverflow,
  seasonAt,
  seasonBoundaries,
  settlePlayer,
  zeroAmounts,
  type PlayerEconomy,
  type ScheduledEvent,
  type SettleContext,
} from "./settle";

const T0 = Date.UTC(2026, 7, 10, 0, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const modifiersOf = (s: Season) => ({
  production: SEASON_MODIFIERS[s].production,
  upkeep: SEASON_MODIFIERS[s].upkeep,
});

function economy(over: Partial<PlayerEconomy> = {}): PlayerEconomy {
  return {
    resources: { grain: 0, timber: 0, stone: 0, iron: 0 },
    baseRates: { grain: 100, timber: 100, stone: 100, iron: 100 },
    baseUpkeep: zeroAmounts(),
    capacity: 100_000,
    population: { amount: 0, rate: 10, cap: 1000, used: 0 },
    settledAt: T0,
    ...over,
  };
}

/** 預設的 apply：把 payload 裡的 rate 加到 baseRates 上 */
const ctx = (apply?: SettleContext["apply"]): SettleContext => ({
  seasonStartedAt: T0,
  modifiersOf,
  apply:
    apply ??
    ((e, event) => {
      const p = event.payload as { resource: keyof typeof e.baseRates; delta: number } | undefined;
      if (!p) return e;
      return { ...e, baseRates: { ...e.baseRates, [p.resource]: e.baseRates[p.resource] + p.delta } };
    }),
});

const evt = (over: Partial<ScheduledEvent> = {}): ScheduledEvent => ({
  id: 1,
  type: "BUILD_DONE",
  resolveAt: T0 + HOUR,
  seq: 0,
  ...over,
});

describe("季節邊界", () => {
  it("12 個遊戲月只有三個換季點（月 4 / 7 / 10）", () => {
    const bounds = seasonBoundaries(T0);
    expect(bounds).toHaveLength(3);
    expect(bounds[0]).toBe(realTimeOfGameMonth(T0, 4));
    expect(bounds[1]).toBe(realTimeOfGameMonth(T0, 7));
    expect(bounds[2]).toBe(realTimeOfGameMonth(T0, 10));
  });

  it("seasonAt 對得上曆法", () => {
    expect(seasonAt(T0, T0)).toBe("SPRING");
    expect(seasonAt(T0, T0 + 4 * DAY)).toBe("SUMMER");
    expect(seasonAt(T0, T0 + 7 * DAY)).toBe("AUTUMN");
    expect(seasonAt(T0, T0 + 11 * DAY)).toBe("WINTER");
    // 賽季結束後不會溢位
    expect(seasonAt(T0, T0 + 99 * DAY)).toBe("WINTER");
  });
});

describe("基本累積", () => {
  it("速率固定時就是 amount + rate × 時數", () => {
    const r = settlePlayer(economy(), [], T0 + 5 * HOUR, ctx());
    // 春季產出 ×1.1
    expect(r.economy.resources.grain).toBeCloseTo(100 * 1.1 * 5, 6);
    expect(r.economy.settledAt).toBe(T0 + 5 * HOUR);
    expect(r.segments).toBe(1);
  });

  it("★ 冪等：結算兩次跟結算一次一樣", () => {
    const once = settlePlayer(economy(), [], T0 + 5 * HOUR, ctx());
    const twice = settlePlayer(once.economy, [], T0 + 5 * HOUR, ctx());
    expect(twice.economy).toEqual(once.economy);
    expect(twice.resolved).toEqual([]);
    expect(twice.segments).toBe(0);
  });

  it("分兩段結算與一次結算到底，結果相同", () => {
    const whole = settlePlayer(economy(), [], T0 + 6 * HOUR, ctx());
    const first = settlePlayer(economy(), [], T0 + 2 * HOUR, ctx());
    const second = settlePlayer(first.economy, [], T0 + 6 * HOUR, ctx());
    for (const r of SETTLE_RESOURCES) {
      expect(second.economy.resources[r]).toBeCloseTo(whole.economy.resources[r], 6);
    }
  });

  it("時間倒退時什麼都不做", () => {
    const r = settlePlayer(economy(), [], T0 - HOUR, ctx());
    expect(r.economy.resources.grain).toBe(0);
    expect(r.segments).toBe(0);
  });
});

describe("★ 跨季結算", () => {
  it("秋天離線、冬天回來，不能整段都用秋季係數算", () => {
    // 秋季最後一小時 → 冬季第一小時
    const winterStart = realTimeOfGameMonth(T0, 10);
    const from = winterStart - HOUR;
    const to = winterStart + HOUR;

    const r = settlePlayer(economy({ settledAt: from }), [], to, ctx());

    const autumn = 100 * SEASON_MODIFIERS.AUTUMN.production;
    const winter = 100 * SEASON_MODIFIERS.WINTER.production;
    expect(r.economy.resources.grain).toBeCloseTo(autumn + winter, 6);
    expect(r.segments).toBe(2);

    // 如果整段用秋季算，會多拿到這麼多 —— 這正是要防的漏洞
    const naive = autumn * 2;
    expect(r.economy.resources.grain).toBeLessThan(naive);
  });

  it("離線整個賽季，四個季節都各算各的", () => {
    const r = settlePlayer(economy(), [], T0 + SEASON_DURATION_MS, ctx());
    // 三個換季點 → 四段
    expect(r.segments).toBe(4);

    const perSeasonHours = SEASON_DURATION_MS / 4 / HOUR;
    const expected =
      100 *
      perSeasonHours *
      (SEASON_MODIFIERS.SPRING.production +
        SEASON_MODIFIERS.SUMMER.production +
        SEASON_MODIFIERS.AUTUMN.production +
        SEASON_MODIFIERS.WINTER.production);
    expect(r.economy.resources.grain).toBeCloseTo(expected, 3);
  });

  it("糧耗也跟著季節走（冬季 ×1.55）", () => {
    const winterStart = realTimeOfGameMonth(T0, 10);
    const e = economy({
      settledAt: winterStart,
      baseRates: zeroAmounts(),
      baseUpkeep: { grain: 10, timber: 0, stone: 0, iron: 0 },
      resources: { grain: 1000, timber: 0, stone: 0, iron: 0 },
    });
    const r = settlePlayer(e, [], winterStart + 10 * HOUR, ctx());
    expect(r.economy.resources.grain).toBeCloseTo(
      1000 - 10 * SEASON_MODIFIERS.WINTER.upkeep * 10,
      6,
    );
  });
});

describe("★ 事件會改變速率，所以必須在事件點切段", () => {
  it("蓋好農田之後才用新的速率", () => {
    const e = economy();
    const event = evt({
      resolveAt: T0 + 2 * HOUR,
      payload: { resource: "grain", delta: 900 },
    });
    const r = settlePlayer(e, [event], T0 + 4 * HOUR, ctx());

    const spring = SEASON_MODIFIERS.SPRING.production;
    // 前兩小時 100/h，後兩小時 1000/h
    expect(r.economy.resources.grain).toBeCloseTo((100 * 2 + 1000 * 2) * spring, 6);
    expect(r.resolved).toHaveLength(1);
    expect(r.segments).toBe(2);
  });

  it("尚未到期的事件不會被套用", () => {
    const future = evt({ resolveAt: T0 + 10 * HOUR, payload: { resource: "grain", delta: 900 } });
    const r = settlePlayer(economy(), [future], T0 + HOUR, ctx());
    expect(r.resolved).toHaveLength(0);
    expect(r.economy.baseRates.grain).toBe(100);
  });

  it("同一時間點的事件依 (seq, id) 依序套用", () => {
    const order: number[] = [];
    const c = ctx((e, event) => {
      order.push(event.id);
      return e;
    });
    const at = T0 + HOUR;
    settlePlayer(
      economy(),
      [
        evt({ id: 3, resolveAt: at, seq: 1 }),
        evt({ id: 1, resolveAt: at, seq: 2 }),
        evt({ id: 2, resolveAt: at, seq: 1 }),
      ],
      T0 + 2 * HOUR,
      c,
    );
    // seq 1 的兩個先來（id 2 < 3），再來 seq 2
    expect(order).toEqual([2, 3, 1]);
  });

  it("事件與換季點在同一條時間軸上排序", () => {
    const winterStart = realTimeOfGameMonth(T0, 10);
    const e = economy({ settledAt: winterStart - 2 * HOUR });
    const event = evt({
      resolveAt: winterStart + HOUR,
      payload: { resource: "grain", delta: 900 },
    });
    const r = settlePlayer(e, [event], winterStart + 2 * HOUR, ctx());
    // 秋 2h（100） + 冬 1h（100） + 冬 1h（1000）
    const expected =
      100 * 2 * SEASON_MODIFIERS.AUTUMN.production +
      100 * 1 * SEASON_MODIFIERS.WINTER.production +
      1000 * 1 * SEASON_MODIFIERS.WINTER.production;
    expect(r.economy.resources.grain).toBeCloseTo(expected, 6);
    expect(r.segments).toBe(3);
  });
});

describe("儲存上限與溢出", () => {
  it("超過上限的部分直接消失，不扣既有資源（docs/03 §2.3）", () => {
    const e = economy({
      capacity: 500,
      resources: { grain: 400, timber: 0, stone: 0, iron: 0 },
    });
    const r = settlePlayer(e, [], T0 + 10 * HOUR, ctx());
    expect(r.economy.resources.grain).toBe(500);
    expect(r.overflow.grain).toBeGreaterThan(0);
    // 沒有懲罰性溢出 —— 既有的 400 一分都沒少
    expect(r.economy.resources.grain).toBeGreaterThanOrEqual(400);
  });

  it("負收支會吃到 0 為止，但不會變成負數", () => {
    const e = economy({
      baseRates: zeroAmounts(),
      baseUpkeep: { grain: 100, timber: 0, stone: 0, iron: 0 },
      resources: { grain: 50, timber: 0, stone: 0, iron: 0 },
    });
    const r = settlePlayer(e, [], T0 + 10 * HOUR, ctx());
    expect(r.economy.resources.grain).toBe(0);
  });

  it("hoursUntilOverflow 給得出可規劃的數字", () => {
    const e = economy({ capacity: 1000, resources: { grain: 500, timber: 0, stone: 0, iron: 0 } });
    const h = hoursUntilOverflow(e, { production: 1, upkeep: 1 });
    expect(h.grain).toBeCloseTo(5, 6);
    // 速率為零 → 永遠不會溢出
    const idle = hoursUntilOverflow({ ...e, baseRates: zeroAmounts() }, { production: 1, upkeep: 1 });
    expect(idle.grain).toBe(Infinity);
  });

  it("基礎上限就是 docs/03 的 2,000", () => {
    expect(STORAGE.base).toBe(2000);
  });
});

describe("人口", () => {
  it("依速率累積，上限扣掉已被部隊佔用的部分", () => {
    const e = economy({ population: { amount: 0, rate: 10, cap: 100, used: 40 } });
    const r = settlePlayer(e, [], T0 + 100 * HOUR, ctx());
    // 上限 100 − 已用 40 = 60
    expect(r.economy.population.amount).toBe(60);
  });

  it("人口不吃季節係數（docs/11：成長率不套用 TIME_SCALE 以外的修正）", () => {
    const winterStart = realTimeOfGameMonth(T0, 10);
    const e = economy({
      settledAt: winterStart,
      population: { amount: 0, rate: 10, cap: 10_000, used: 0 },
    });
    const r = settlePlayer(e, [], winterStart + 10 * HOUR, ctx());
    expect(r.economy.population.amount).toBeCloseTo(100, 6);
  });

  it("availablePopulation 不會回傳負數", () => {
    expect(availablePopulation({ amount: 50, rate: 0, cap: 100, used: 120 })).toBe(0);
    expect(availablePopulation({ amount: 50, rate: 0, cap: 100, used: 40 })).toBe(50);
  });
});
