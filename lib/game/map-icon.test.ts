import { describe, expect, it } from "vitest";

import { TILE_RESOURCE } from "./balance";
import { iconScaleFor, tileIconShapes, type TileResource } from "./map-icon";

const KINDS = ["grain", "timber", "stone", "iron"] as const satisfies readonly TileResource[];

describe("地圖上的資源地貌圖示", () => {
  it("四種都畫得出東西", () => {
    // 山洞只有三塊（岩體、受光面、洞口）—— 少於三塊就讀不出立體
    for (const k of KINDS) expect(tileIconShapes(k).length).toBeGreaterThanOrEqual(3);
  });

  it("★ 每一個形狀都在格子裡（0..1）—— 溢出去會蓋到鄰格", () => {
    for (const k of KINDS) {
      for (const s of tileIconShapes(k)) {
        const coords =
          s.kind === "rect" ? [s.x, s.y, s.x + s.w, s.y + s.h] : [...s.points];
        for (const v of coords) {
          expect(v, `${k} 的形狀超出格子：${v}`).toBeGreaterThanOrEqual(0);
          expect(v, `${k} 的形狀超出格子：${v}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("多邊形至少要有三個點", () => {
    for (const k of KINDS) {
      for (const s of tileIconShapes(k)) {
        if (s.kind === "poly") expect(s.points.length).toBeGreaterThanOrEqual(6);
        if (s.kind === "poly") expect(s.points.length % 2).toBe(0);
      }
    }
  });

  it("★ 等級愈高佔格子比例愈大，而且單調遞增", () => {
    const sizes = [1, 2, 3, 4, 5].map(iconScaleFor);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
    }
    expect(sizes[0]).toBeCloseTo(0.38, 5);
    expect(sizes[4]).toBeCloseTo(0.92, 5);
  });

  it("等級超出範圍時夾住，不會畫出比格子還大的圖示", () => {
    expect(iconScaleFor(0)).toBe(iconScaleFor(1));
    expect(iconScaleFor(99)).toBe(iconScaleFor(5));
    expect(iconScaleFor(99)).toBeLessThan(1);
  });

  it("★ 四種輪廓互不相同 —— 顏色一樣的兩種只剩形狀可以分", () => {
    const sigs = KINDS.map((k) => JSON.stringify(tileIconShapes(k).map((s) => s.kind + JSON.stringify(s))));
    expect(new Set(sigs).size).toBe(KINDS.length);
  });

  it("★ 每一種產出資源的地形都畫得出圖示 —— 新增地形時這裡會先壞掉", () => {
    for (const entry of Object.values(TILE_RESOURCE)) {
      if (!entry) continue;
      expect(() => tileIconShapes(entry.resource)).not.toThrow();
      expect(tileIconShapes(entry.resource).length).toBeGreaterThan(0);
    }
  });
});
