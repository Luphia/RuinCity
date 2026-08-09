import { describe, expect, it } from "vitest";

import { CITADEL } from "./balance";
import { keepIconShapes, keepTier, KEEP_TIER_LABEL, type KeepTier } from "./keep-icon";

const TIERS = [1, 2, 3] as const satisfies readonly KeepTier[];

const pointsOf = (shape: ReturnType<typeof keepIconShapes>[number]) =>
  shape.kind === "rect"
    ? [shape.x, shape.y, shape.x + shape.w, shape.y + shape.h]
    : [...shape.points];

describe("主城圖示", () => {
  it("★ 三段都在 2×2 的格子裡（0..1）—— 溢出去會蓋到鄰格", () => {
    for (const tier of TIERS) {
      for (const shape of keepIconShapes(tier)) {
        for (const v of pointsOf(shape)) {
          expect(v, `第 ${tier} 段溢出 2×2：${v}`).toBeGreaterThanOrEqual(0);
          expect(v, `第 ${tier} 段溢出 2×2：${v}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("三段都畫得出東西，而且多邊形至少三個點", () => {
    for (const tier of TIERS) {
      const shapes = keepIconShapes(tier);
      expect(shapes.length).toBeGreaterThanOrEqual(10);
      for (const s of shapes) {
        if (s.kind === "poly") {
          expect(s.points.length % 2).toBe(0);
          expect(s.points.length).toBeGreaterThanOrEqual(6);
        } else {
          // 夾回 0..1 之後不該留下寬或高為負的殘骸
          expect(s.w).toBeGreaterThanOrEqual(0);
          expect(s.h).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("★ 三段的輪廓互不相同 —— 只差色階等於沒有分段", () => {
    const sigs = TIERS.map((t) => JSON.stringify(keepIconShapes(t)));
    expect(new Set(sigs).size).toBe(TIERS.length);
  });

  it("★ 每一段都有一面聯盟色的旗 —— 沒有旗就看不出是誰的城", () => {
    for (const tier of TIERS) {
      expect(keepIconShapes(tier).some((s) => s.tone === "banner")).toBe(true);
    }
  });

  it("★ 第 3 段的天際線最高（尖塔）—— 遠遠就要看得出哪座不好打", () => {
    const top = (tier: KeepTier) =>
      Math.min(...keepIconShapes(tier).flatMap((s) => pointsOf(s).filter((_, i) => i % 2 === 1)));
    // y 向下，所以「最高」是最小的 y
    expect(top(3)).toBeLessThanOrEqual(top(2));
    expect(top(2)).toBeLessThanOrEqual(top(1));
  });

  it("城牆等級分三段，界線是天花板的三等分", () => {
    const max = CITADEL.maxLevel;
    expect(keepTier(0)).toBe(1);
    expect(keepTier(Math.floor(max / 3) - 1)).toBe(1);
    expect(keepTier(Math.ceil(max / 3))).toBe(2);
    expect(keepTier(Math.ceil((max * 2) / 3))).toBe(3);
    expect(keepTier(max)).toBe(3);
  });

  it("★ 等級超出範圍、或根本沒有城牆，都要有一段可以畫", () => {
    expect(keepTier(-5)).toBe(1);
    expect(keepTier(999)).toBe(3);
    expect(keepTier(Number.NaN)).toBe(1);
    for (const tier of TIERS) expect(KEEP_TIER_LABEL[tier].length).toBeGreaterThan(0);
  });

  it("★ 等級單調不遞減 —— 升了城牆不該讓城看起來變弱", () => {
    let last: KeepTier = 1;
    for (let level = 0; level <= CITADEL.maxLevel; level++) {
      const tier = keepTier(level);
      expect(tier).toBeGreaterThanOrEqual(last);
      last = tier;
    }
    expect(last).toBe(3);
  });
});
