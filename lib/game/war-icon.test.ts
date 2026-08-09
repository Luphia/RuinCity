import { describe, expect, it } from "vitest";

import {
  warClashPoint,
  warIconFrame,
  warIconShapes,
  WAR_ICON_PERIOD_MS,
} from "./war-icon";

/** 掃過一整個週期。60fps 下一個週期約 48 幀，這裡取樣密一倍 */
const FRAMES = Array.from({ length: 100 }, (_, i) => (i * WAR_ICON_PERIOD_MS) / 100);

describe("交戰中的兩把刀", () => {
  it("★ 整個週期都待在 1×1 的格子裡 —— 溢出去會分不清打的是哪一格", () => {
    for (const t of FRAMES) {
      for (const shape of warIconShapes(t)) {
        for (const v of shape.points) {
          expect(v, `t=${t.toFixed(0)}ms 溢出格子：${v}`).toBeGreaterThanOrEqual(0);
          expect(v, `t=${t.toFixed(0)}ms 溢出格子：${v}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("每一幀都畫得出兩把刀（含暗色剪影）", () => {
    for (const t of FRAMES) {
      const shapes = warIconShapes(t);
      expect(shapes.filter((s) => s.tone === "blade").length).toBe(4); // 兩把 × 刃身＋刀尖
      expect(shapes.some((s) => s.tone === "shadow")).toBe(true);
      expect(shapes.some((s) => s.tone === "grip")).toBe(true);
      for (const s of shapes) expect(s.points.length).toBeGreaterThanOrEqual(6);
    }
  });

  it("★ 動畫會循環：週期的頭尾接得上，而且負的 elapsed 也不會炸", () => {
    expect(warIconFrame(0).angle).toBeCloseTo(warIconFrame(WAR_ICON_PERIOD_MS).angle, 6);
    expect(warIconFrame(-WAR_ICON_PERIOD_MS * 1.5).angle).toBeCloseTo(
      warIconFrame(WAR_ICON_PERIOD_MS * 0.5).angle,
      6,
    );
  });

  it("★ 真的在動 —— 相鄰兩幀的姿勢不一樣", () => {
    const angles = FRAMES.map((t) => warIconFrame(t).angle);
    expect(new Set(angles.map((a) => a.toFixed(4))).size).toBeGreaterThan(20);
  });

  it("★ 舉刀慢、劈下快 —— 等速的來回讀起來是鐘擺，不是打鬥", () => {
    const raise = warIconFrame(WAR_ICON_PERIOD_MS * 0.2);
    const strike = warIconFrame(WAR_ICON_PERIOD_MS * 0.54);
    const rest = warIconFrame(0);
    // 舉刀 = 角度變小（兩把刀分開）；劈下 = 角度變大（交得最深）
    expect(raise.angle).toBeLessThan(rest.angle);
    expect(strike.angle).toBeGreaterThan(rest.angle);

    // 而且劈下的那一段角速度要明顯快過舉刀
    const speed = (a: number, b: number) =>
      Math.abs(warIconFrame(WAR_ICON_PERIOD_MS * b).angle - warIconFrame(WAR_ICON_PERIOD_MS * a).angle) /
      (b - a);
    expect(speed(0.42, 0.55)).toBeGreaterThan(2 * speed(0, 0.42));
  });

  it("★ 火花只在劈中那一瞬間，而且畫在兩把刀交會的那一點", () => {
    expect(warIconFrame(WAR_ICON_PERIOD_MS * 0.2).spark).toBe(0);
    expect(warIconFrame(WAR_ICON_PERIOD_MS * 0.5).spark).toBe(0);
    expect(warIconFrame(WAR_ICON_PERIOD_MS * 0.56).spark).toBeGreaterThan(0.8);
    expect(warIconFrame(WAR_ICON_PERIOD_MS * 0.95).spark).toBe(0);

    // 舉刀的那半個週期沒有火花，所以只驗劈中的姿勢
    const strike = warIconFrame(WAR_ICON_PERIOD_MS * 0.56);
    const clash = warClashPoint(strike.angle);
    expect(clash.x).toBeCloseTo(0.5, 6);
    expect(clash.y).toBeGreaterThan(0);
    expect(clash.y).toBeLessThan(1);

    const sparks = warIconShapes(WAR_ICON_PERIOD_MS * 0.56).filter(
      (s) => s.tone === "spark" || s.tone === "sparkCore",
    );
    expect(sparks.length).toBeGreaterThan(0);
  });

  it("交得愈深，交會點愈低 —— 火花跟著刀走，不是釘在格子中央", () => {
    const shallow = warClashPoint(warIconFrame(WAR_ICON_PERIOD_MS * 0.2).angle);
    const deep = warClashPoint(warIconFrame(WAR_ICON_PERIOD_MS * 0.54).angle);
    expect(deep.y).toBeGreaterThan(shallow.y);
  });
});
