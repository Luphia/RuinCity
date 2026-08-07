import { describe, expect, it } from "vitest";

import { SEASON_MODIFIERS, SEASONS } from "./balance/time";
import {
  SEASON_DURATION_MS,
  formatGameDate,
  isSeasonExpired,
  nextSeasonChangeAt,
  realTimeOfGameMonth,
  seasonModifiersAt,
  seasonOfMonth,
  toGameDate,
} from "./calendar";

const T0 = Date.UTC(2026, 7, 10, 0, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("toGameDate", () => {
  it("賽季第一刻是 1 月 1 日", () => {
    const d = toGameDate(T0, T0);
    expect(d).toMatchObject({ year: 41, month: 1, day: 1, season: "SPRING" });
  });

  it("每過一個真實日就前進一個遊戲月", () => {
    for (let m = 1; m <= 12; m++) {
      expect(toGameDate(T0, T0 + (m - 1) * DAY).month).toBe(m);
    }
  });

  it("一個遊戲日 = 48 真實分鐘", () => {
    expect(toGameDate(T0, T0 + 47 * 60 * 1000).day).toBe(1);
    expect(toGameDate(T0, T0 + 48 * 60 * 1000).day).toBe(2);
    expect(toGameDate(T0, T0 + 29 * 48 * 60 * 1000).day).toBe(30);
  });

  it("賽季結束後停在 12 月 30 日，不會溢位到第 13 月", () => {
    const d = toGameDate(T0, T0 + 20 * DAY);
    expect(d.month).toBe(12);
    expect(d.day).toBe(30);
    // elapsedMonths 不 clamp，讓 isSeasonExpired 可以判斷
    expect(d.elapsedMonths).toBeGreaterThan(12);
  });

  it("now 早於 startedAt 時視為第一刻", () => {
    expect(toGameDate(T0, T0 - 5 * DAY)).toMatchObject({ month: 1, day: 1 });
  });

  it("day 永遠落在 1–30", () => {
    for (let h = 0; h < 12 * 24; h++) {
      const d = toGameDate(T0, T0 + h * HOUR);
      expect(d.day).toBeGreaterThanOrEqual(1);
      expect(d.day).toBeLessThanOrEqual(30);
    }
  });
});

describe("seasonOfMonth", () => {
  it("四季各覆蓋 3 個遊戲月", () => {
    expect([1, 2, 3].map(seasonOfMonth)).toEqual(["SPRING", "SPRING", "SPRING"]);
    expect([4, 5, 6].map(seasonOfMonth)).toEqual(["SUMMER", "SUMMER", "SUMMER"]);
    expect([7, 8, 9].map(seasonOfMonth)).toEqual(["AUTUMN", "AUTUMN", "AUTUMN"]);
    expect([10, 11, 12].map(seasonOfMonth)).toEqual(["WINTER", "WINTER", "WINTER"]);
  });

  it("超出範圍的月份被 clamp", () => {
    expect(seasonOfMonth(0)).toBe("SPRING");
    expect(seasonOfMonth(99)).toBe("WINTER");
  });

  it("SEASON_MODIFIERS 完整覆蓋 1–12 且不重疊", () => {
    const covered = new Set<number>();
    for (const s of SEASONS) {
      const [from, to] = SEASON_MODIFIERS[s].months;
      for (let m = from; m <= to; m++) {
        expect(covered.has(m)).toBe(false);
        covered.add(m);
      }
    }
    expect(covered.size).toBe(12);
  });
});

describe("season modifiers", () => {
  it("遺跡解封當下（D3）已進入夏季", () => {
    expect(toGameDate(T0, T0 + 3 * DAY).season).toBe("SUMMER");
  });

  it("秋季是遠征窗口：區域容量最高、產出最高", () => {
    const autumn = SEASON_MODIFIERS.AUTUMN;
    for (const s of SEASONS) {
      expect(autumn.regionCapacity).toBeGreaterThanOrEqual(SEASON_MODIFIERS[s].regionCapacity);
      expect(autumn.production).toBeGreaterThanOrEqual(SEASON_MODIFIERS[s].production);
    }
  });

  it("冬季糧食收支必然惡化，但區域容量只小幅下修", () => {
    const w = SEASON_MODIFIERS.WINTER;
    // 產出腰斬、糧耗暴漲 → 養不起不打仗的軍隊
    expect(w.production).toBeLessThan(0.6);
    expect(w.upkeep).toBeGreaterThan(1.3);
    // 但你仍然打得動 —— 用兵高峰在秋冬，容量不能壓太緊
    expect(w.regionCapacity).toBeGreaterThanOrEqual(0.85);
  });

  it("春季地窖加倍，其餘季節不加", () => {
    expect(SEASON_MODIFIERS.SPRING.vault).toBe(2);
    for (const s of ["SUMMER", "AUTUMN", "WINTER"] as const) {
      expect(SEASON_MODIFIERS[s].vault).toBe(1);
    }
  });

  it("seasonModifiersAt 對應到正確的季節", () => {
    expect(seasonModifiersAt(T0, T0 + 1 * DAY)).toBe(SEASON_MODIFIERS.SPRING);
    expect(seasonModifiersAt(T0, T0 + 4 * DAY)).toBe(SEASON_MODIFIERS.SUMMER);
    expect(seasonModifiersAt(T0, T0 + 7 * DAY)).toBe(SEASON_MODIFIERS.AUTUMN);
    expect(seasonModifiersAt(T0, T0 + 10 * DAY)).toBe(SEASON_MODIFIERS.WINTER);
  });
});

describe("時間點換算", () => {
  it("realTimeOfGameMonth 與 toGameDate 互為反函式", () => {
    for (let m = 1; m <= 12; m++) {
      expect(toGameDate(T0, realTimeOfGameMonth(T0, m)).month).toBe(m);
    }
  });

  it("nextSeasonChangeAt 回傳下一季的第一刻", () => {
    expect(nextSeasonChangeAt(T0, T0 + 1 * DAY)).toBe(realTimeOfGameMonth(T0, 4));
    expect(nextSeasonChangeAt(T0, T0 + 5 * DAY)).toBe(realTimeOfGameMonth(T0, 7));
    expect(nextSeasonChangeAt(T0, T0 + 8 * DAY)).toBe(realTimeOfGameMonth(T0, 10));
    // 冬季 → 賽季結束
    expect(nextSeasonChangeAt(T0, T0 + 11 * DAY)).toBe(T0 + SEASON_DURATION_MS);
  });

  it("賽季長度為 12 真實日", () => {
    expect(SEASON_DURATION_MS).toBe(12 * DAY);
    expect(isSeasonExpired(T0, T0 + 12 * DAY - 1)).toBe(false);
    expect(isSeasonExpired(T0, T0 + 12 * DAY)).toBe(true);
  });
});

describe("formatGameDate", () => {
  it("輸出廢曆格式", () => {
    expect(formatGameDate(toGameDate(T0, T0))).toBe("廢曆 41 年 · 1 月 1 日");
    expect(formatGameDate(toGameDate(T0, T0 + 2 * DAY + 48 * 60 * 1000)))
      .toBe("廢曆 41 年 · 3 月 2 日");
  });
});
