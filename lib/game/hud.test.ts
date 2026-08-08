import { describe, expect, it } from "vitest";

import { extrapolate, nearestCompletion } from "./hud";

describe("nearestCompletion", () => {
  it("挑最接近的未來，忽略 null 與已過期", () => {
    const now = 1000;
    expect(
      nearestCompletion(
        [
          { label: "閒置", doneAt: null },
          { label: "過期", doneAt: 900 },
          { label: "近", doneAt: 2000 },
          { label: "遠", doneAt: 5000 },
        ],
        now,
      ),
    ).toEqual({ label: "近", doneAt: 2000 });
  });

  it("全部閒置 → null", () => {
    expect(nearestCompletion([{ label: "a", doneAt: null }], 0)).toBeNull();
  });
});

describe("extrapolate", () => {
  it("以速率外推，封頂在上限", () => {
    expect(extrapolate(100, 60, 30 * 60_000, 1000)).toBe(130);
    expect(extrapolate(990, 60, 60 * 60_000, 1000)).toBe(1000);
  });

  it("負速率外推但不穿零 —— 餓不餓死由伺服器說", () => {
    expect(extrapolate(10, -60, 60 * 60_000, 1000)).toBe(0);
  });
});
