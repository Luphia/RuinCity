import { describe, expect, it } from "vitest";

import { armyPopulation } from "./army";
import { WILDS } from "./balance";
import { extractionMultiplier, tileYieldPerHour } from "./formulas";
import { needsConquest, wildGuardsFor, wildInnateDefense, wildLevelAt } from "./wilds";

describe("wildLevelAt", () => {
  it("決定性：同 (seed,x,y,terrain) 永遠同級", () => {
    expect(wildLevelAt(42, 100, 200, "PLAIN")).toBe(wildLevelAt(42, 100, 200, "PLAIN"));
  });

  it("荒地與山脈恆 0；資源地在 1..5", () => {
    expect(wildLevelAt(42, 10, 10, "WASTE")).toBe(0);
    expect(wildLevelAt(42, 10, 10, "MOUNTAIN")).toBe(0);
    for (let i = 0; i < 200; i++) {
      const l = wildLevelAt(42, i, i * 7, "FOREST");
      expect(l).toBeGreaterThanOrEqual(1);
      expect(l).toBeLessThanOrEqual(WILDS.maxLevel);
    }
  });

  it("分佈偏低階：lv1 是眾數、lv5 稀有（一萬格抽樣）", () => {
    const counts = new Map<number, number>();
    for (let x = 0; x < 100; x++) {
      for (let y = 0; y < 100; y++) {
        const l = wildLevelAt(7, x, y, "PLAIN");
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
    }
    const c = (l: number) => counts.get(l) ?? 0;
    expect(c(1)).toBeGreaterThan(c(2));
    expect(c(2)).toBeGreaterThan(c(3));
    expect(c(5)).toBeLessThan(350); // ≈ 2.3%
    expect(c(1)).toBeGreaterThan(4800); // ≈ 56%
  });

  it("礦脈與沼澤 +1 級：同座標的 LODE 不低於 PLAIN", () => {
    for (let i = 0; i < 100; i++) {
      expect(wildLevelAt(9, i, i, "LODE")).toBeGreaterThanOrEqual(wildLevelAt(9, i, i, "PLAIN"));
    }
    // 而且真的抽得到 5
    let five = 0;
    for (let i = 0; i < 500; i++) if (wildLevelAt(9, i, 3 * i, "LODE") === 5) five++;
    expect(five).toBeGreaterThan(0);
  });
});

describe("wildGuardsFor：等級與距離是兩條獨立的軸", () => {
  it("lv≤1 無守衛（立旗空間）", () => {
    expect(wildGuardsFor(0, 10)).toEqual({});
    expect(wildGuardsFor(1, 40)).toEqual({});
    expect(needsConquest(1)).toBe(false);
    expect(needsConquest(2)).toBe(true);
  });

  it("等級越高越強", () => {
    for (let l = 2; l < WILDS.maxLevel; l++) {
      expect(armyPopulation(wildGuardsFor(l + 1, 10))).toBeGreaterThan(
        armyPopulation(wildGuardsFor(l, 10)),
      );
    }
  });

  it("距離越遠越強", () => {
    expect(armyPopulation(wildGuardsFor(3, 40))).toBeGreaterThan(
      armyPopulation(wildGuardsFor(3, 5)),
    );
  });

  it("數值表對點：lv2 d=5 ≈ 23、lv5 d=40 ≈ 200（docs/11 §22.3）", () => {
    expect(armyPopulation(wildGuardsFor(2, 5))).toBeCloseTo(23, -1);
    expect(armyPopulation(wildGuardsFor(5, 40))).toBeCloseTo(200, -1);
  });

  it("弓手比例隨等級升、封頂 40%", () => {
    const g5 = wildGuardsFor(5, 0);
    const pop = armyPopulation(g5);
    expect((g5.ARCHER ?? 0) / pop).toBeCloseTo(WILDS.archerShareMax, 1);
    const g2 = wildGuardsFor(2, 0);
    expect((g2.ARCHER ?? 0) / armyPopulation(g2)).toBeLessThan(0.2);
  });
});

describe("領地產出：固定值 × 開採倍率（docs/11 §22.4）", () => {
  it("格子是資源：光佔領就有固定產出，等級是固定值階梯不是百分比", () => {
    const lv1 = tileYieldPerHour("PLAIN", 1, null, 0)!;
    const lv3 = tileYieldPerHour("PLAIN", 3, null, 0)!;
    expect(lv1.resource).toBe("grain");
    expect(lv1.perHour).toBeGreaterThan(0);
    expect(lv3.perHour).toBeCloseTo(lv1.perHour * 3, 6);
  });

  it("對口設施滿級恰好 ×5；不對口沒有效果", () => {
    expect(extractionMultiplier(0)).toBe(1);
    expect(extractionMultiplier(20)).toBe(5);
    const bare = tileYieldPerHour("FOREST", 2, null, 0)!;
    const matched = tileYieldPerHour("FOREST", 2, "SAWMILL", 20)!;
    const mismatched = tileYieldPerHour("FOREST", 2, "FARM", 20)!;
    expect(matched.perHour).toBeCloseTo(bare.perHour * 5, 6);
    expect(mismatched.perHour).toBeCloseTo(bare.perHour, 6);
  });

  it("荒地與山脈不產（它們的用途是蓋非產出設施）", () => {
    expect(tileYieldPerHour("WASTE", 3, "FARM", 10)).toBeNull();
    expect(tileYieldPerHour("MOUNTAIN", 1, null, 0)).toBeNull();
  });

  it("固有防禦只長在有守衛的等級", () => {
    expect(wildInnateDefense(1)).toBe(0);
    expect(wildInnateDefense(3)).toBe(90);
  });
});
