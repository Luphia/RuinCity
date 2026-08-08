import { describe, expect, it } from "vitest";

import { RESOURCE_LABEL } from "./balance";
import {
  RESOURCE_ICON_SIZE,
  RESOURCE_KINDS,
  RESOURCE_NAME,
  resourceIconGrid,
  resourceIconSvg,
} from "./resource-icon";

describe("資源圖示", () => {
  it("四種都畫得出 12×12", () => {
    for (const k of RESOURCE_KINDS) {
      const g = resourceIconGrid(k);
      expect(g.length).toBe(RESOURCE_ICON_SIZE * RESOURCE_ICON_SIZE);
      expect(g.some((v) => v !== 0), `${k} 是空的`).toBe(true);
    }
  });

  it("★ 四個輪廓要互不相同 —— 顏色一樣的兩種資源只剩形狀可以分", () => {
    const shapes = RESOURCE_KINDS.map((k) =>
      [...resourceIconGrid(k)].map((v) => (v === 0 ? "." : "#")).join(""),
    );
    expect(new Set(shapes).size).toBe(RESOURCE_KINDS.length);
  });

  it("★ 名字只有一份 —— 規格在 balance 那張表", () => {
    for (const k of RESOURCE_KINDS) expect(RESOURCE_NAME[k]).toBe(RESOURCE_LABEL[k]);
  });

  it("SVG 帶著 aria-label，而且是決定性的", () => {
    const a = resourceIconSvg("grain");
    expect(a).toBe(resourceIconSvg("grain"));
    expect(a).toContain(`aria-label="${RESOURCE_NAME.grain}"`);
    expect(a).toContain("shape-rendering=\"crispEdges\"");
  });

  it("放大只改尺寸，不改格數", () => {
    const one = resourceIconSvg("iron", 1).match(/<rect/g)?.length ?? 0;
    const four = resourceIconSvg("iron", 4).match(/<rect/g)?.length ?? 0;
    expect(four).toBe(one);
    expect(resourceIconSvg("iron", 4)).toContain('width="48"');
  });
});
