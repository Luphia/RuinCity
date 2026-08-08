import { describe, expect, it } from "vitest";

import { MARCH, SEASON_MODIFIERS, type Terrain } from "./balance";
import { distance, marchTime, sampleTerrainFactor, warningWindow } from "./march";

const plain = (): Terrain => "PLAIN";
const at = (x: number, y: number) => ({ x, y });

function minutes(seconds: number) {
  return seconds / 60;
}

describe("行軍時間", () => {
  it("符合 docs/04 §2.3 的實例表", () => {
    /**
     * ★ 距離是 900×900 的（500×500 的舊表 ×1.8），**時間一格沒動** ——
     *   `MARCH_SCALE` 同步 2 → 3.6，所以每一種情境花的真實時間不變。
     *   這正是「地圖放大只改幾何、不改節奏」的可測形式（`11` §22.7）。
     */
    const cases: [string, number, Parameters<typeof marchTime>[0]["army"], number][] = [
      ["打隔壁鄰居（劍士）", 18, { SWORDSMAN: 100 }, 15],
      ["打隔壁鄰居（掠奪騎兵）", 18, { RAIDER: 100 }, 7.5],
      ["區域衝突（劍士）", 72, { SWORDSMAN: 100 }, 60],
      ["區域衝突（帶攻城車）", 72, { SWORDSMAN: 100, RAM: 10 }, 100],
      ["打自家遺跡", 144, { SWORDSMAN: 100 }, 120],
      ["跨陣營遺跡", 360, { SWORDSMAN: 100 }, 300],
    ];

    for (const [label, d, army, expectedMinutes] of cases) {
      const r = marchTime({ from: at(0, 0), to: at(d, 0), army });
      expect(minutes(r.seconds), label).toBeCloseTo(expectedMinutes, 1);
    }
  });

  it("跨陣營攻城遠征在物理上不可能直達", () => {
    // 360 格帶投石機 → 10 小時 → 超過 8 小時上限
    const siege = marchTime({
      from: at(0, 0),
      to: at(360, 0),
      army: { SWORDSMAN: 100, CATAPULT: 20 },
    });
    expect(minutes(siege.seconds)).toBeCloseTo(600, 0);
    expect(siege.exceedsLimit).toBe(true);

    // 跨圖 630 格連純劍士都超過
    const crossMap = marchTime({ from: at(0, 0), to: at(630, 0), army: { SWORDSMAN: 100 } });
    expect(crossMap.exceedsLimit).toBe(true);

    // 但同樣的部隊在 360 格內可以直達 → 前哨營是唯一解
    expect(marchTime({ from: at(0, 0), to: at(360, 0), army: { SWORDSMAN: 100 } }).exceedsLimit)
      .toBe(false);
  });

  it("部隊速度取決於最慢的單位", () => {
    const fast = marchTime({ from: at(0, 0), to: at(40, 0), army: { RAIDER: 10 } });
    const dragged = marchTime({
      from: at(0, 0),
      to: at(40, 0),
      army: { RAIDER: 10, CATAPULT: 1 },
    });
    expect(dragged.seconds).toBeGreaterThan(fast.seconds * 3);
  });

  it("最小行軍時間 180 秒，防止貼臉瞬殺", () => {
    const r = marchTime({ from: at(0, 0), to: at(1, 0), army: { RAIDER: 1 } });
    expect(r.seconds).toBe(MARCH.minSeconds);
  });

  it("冬季行軍變慢，會讓臨界的遠征退出射程", () => {
    const army = { SWORDSMAN: 100 };
    const summer = marchTime({ from: at(0, 0), to: at(540, 0), army });
    const winter = marchTime({
      from: at(0, 0),
      to: at(540, 0),
      army,
      season: SEASON_MODIFIERS.WINTER,
    });

    expect(summer.exceedsLimit).toBe(false); // 7.5 小時
    expect(winter.exceedsLimit).toBe(true); // 8.6 小時
    expect(winter.seconds / summer.seconds).toBeCloseTo(1.15, 2);
  });

  it("純騎兵部隊才吃獸廄加成", () => {
    const bonus = { stableBonus: 0.2 };
    const pureCav = marchTime({
      from: at(0, 0), to: at(72, 0), army: { RAIDER: 10 }, speedBonus: bonus,
    });
    const mixed = marchTime({
      from: at(0, 0), to: at(72, 0), army: { RAIDER: 10, SWORDSMAN: 1 }, speedBonus: bonus,
    });
    const pureCavNoBonus = marchTime({ from: at(0, 0), to: at(72, 0), army: { RAIDER: 10 } });

    expect(pureCav.speed).toBeCloseTo(pureCavNoBonus.speed * 1.2, 5);
    expect(mixed.speed).toBe(72); // 劍士 20 × MARCH_SCALE(3.6)，無加成
  });

  it("空部隊回傳 Infinity 而不是 NaN", () => {
    const r = marchTime({ from: at(0, 0), to: at(10, 0), army: {} });
    expect(r.seconds).toBe(Infinity);
    expect(r.exceedsLimit).toBe(true);
  });
});

describe("地形取樣", () => {
  it("全平原為 1.0", () => {
    expect(sampleTerrainFactor(at(0, 0), at(50, 0), plain)).toBe(1);
  });

  it("山脈以 ×2.5 計，抽象表示繞路", () => {
    const allMountain = sampleTerrainFactor(at(0, 0), at(20, 0), () => "MOUNTAIN");
    expect(allMountain).toBe(2.5);
  });

  it("混合地形取平均", () => {
    // 左半平原(1.0)、右半毒沼(1.8) → 平均 1.4
    const f = sampleTerrainFactor(at(0, 0), at(100, 0), (x) => (x < 50 ? "PLAIN" : "MARSH"));
    expect(f).toBeCloseTo(1.4, 1);
  });

  it("取樣點數有上限，長距離也不會爆炸", () => {
    let calls = 0;
    sampleTerrainFactor(at(0, 0), at(700, 0), () => {
      calls++;
      return "PLAIN";
    });
    expect(calls).toBeLessThanOrEqual(MARCH.terrainSampleCap);
  });
});

describe("來襲預警窗口", () => {
  it("符合 docs/04 §2.4 的表", () => {
    const cases: [number, number, number][] = [
      // [行軍分鐘, 無哨塔分鐘, 有哨塔分鐘]
      [7.5, 3, 5],
      [15, 6, 9],
      [60, 24, 36],
      [300, 30, 45], // 觸及上限
    ];
    for (const [march, plainWindow, tower] of cases) {
      expect(minutes(warningWindow(march * 60))).toBeCloseTo(plainWindow, 1);
      expect(minutes(warningWindow(march * 60, true))).toBeCloseTo(tower, 1);
    }
  });

  it("★ 預警永遠不長於行軍時間 —— 不會在敵人出發前就被看見", () => {
    for (const m of [3, 5, 10, 30, 60, 120, 480]) {
      const seconds = m * 60;
      expect(warningWindow(seconds)).toBeLessThanOrEqual(seconds);
      expect(warningWindow(seconds, true)).toBeLessThanOrEqual(seconds);
    }
  });

  it("最短行軍（180 秒）時預警涵蓋全程，但也只有 3 分鐘可以反應", () => {
    expect(warningWindow(180)).toBe(180);
    // 哨塔的 300 秒下限被 clamp 掉 —— 不能比行軍本身還早
    expect(warningWindow(180, true)).toBe(180);
  });

  it("哨塔永遠給更長的預警 —— 在前線是必需品", () => {
    for (const m of [5, 15, 60, 300]) {
      expect(warningWindow(m * 60, true)).toBeGreaterThan(warningWindow(m * 60));
    }
  });

  it("遠方來的敵人看得早，隔壁鄰居幾乎是瞬間的", () => {
    const neighbour = warningWindow(15 * 60); // 6 分
    const distant = warningWindow(300 * 60); // 30 分
    expect(distant / neighbour).toBeGreaterThan(4);
  });
});

describe("distance", () => {
  it("歐幾里得距離", () => {
    expect(distance(at(0, 0), at(3, 4))).toBe(5);
    expect(distance(at(10, 10), at(10, 10))).toBe(0);
  });
});
