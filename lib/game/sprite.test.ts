import { describe, expect, it } from "vitest";

import { CORE_BUILDINGS } from "./balance";
import {
  levelForTier,
  renderSlot,
  slotLabel,
  slotSvg,
  SPRITE_PALETTE,
  SPRITE_SIZE,
  tier,
  type SlotArt,
} from "./sprite";

const art = (over: Partial<SlotArt> = {}): SlotArt => ({
  building: "CITADEL",
  level: 1,
  building_: false,
  frame: 0,
  ...over,
});

const filled = (g: Uint8Array) => g.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);
const key = (g: Uint8Array) => g.join(",");

describe("像素規範", () => {
  it("32×32（`docs/09` §2 的基準 tile）", () => {
    expect(renderSlot(art())).toHaveLength(SPRITE_SIZE * SPRITE_SIZE);
  });

  it("只用調色盤裡的索引", () => {
    for (const b of [...CORE_BUILDINGS, "CITADEL", null] as const) {
      const g = renderSlot(art({ building: b, level: 20 }));
      for (const v of g) expect(v).toBeLessThan(SPRITE_PALETTE.length);
    }
  });

  it("★ 沒有發明調色盤外的顏色 —— 那份 24 色是視覺一致性的來源", () => {
    for (const c of SPRITE_PALETTE.slice(1)) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("等級分段", () => {
  it("0 級是空的，滿級是第 4 段", () => {
    expect(tier(0)).toBe(0);
    expect(tier(1)).toBe(1);
    expect(tier(30)).toBe(4);
  });

  /**
   * ★ 取樣點要**依每種建築自己的上限**換算，不能寫死等級。
   *   主堡上限 33、核心建築 30 —— 寫死 [1,8,15,24,30] 的話，
   *   主堡的 15 與 24 會落在同一段，測試就會誤報「看不出差異」。
   */
  it("★ 四段的外觀都不一樣 —— 否則 Lv1 與滿級是同一張圖", () => {
    for (const b of [...CORE_BUILDINGS, "CITADEL"] as const) {
      const seen = new Set<string>();
      for (const t of [1, 2, 3, 4] as const) {
        seen.add(key(renderSlot(art({ building: b, level: levelForTier(b, t) }))));
      }
      expect(seen.size, `${b} 的等級看不出差異`).toBe(4);
    }
  });
});

describe("每一種建築都畫得出來", () => {
  it("八種 + 空地都有內容，而且彼此不同", () => {
    const seen = new Map<string, string>();
    for (const b of [...CORE_BUILDINGS, "CITADEL", null] as const) {
      const g = renderSlot(art({ building: b, level: 20 }));
      expect(filled(g), `${b} 是空白的`).toBeGreaterThan(200);
      const k = key(g);
      expect(seen.has(k), `${b} 與 ${seen.get(k)} 長得一模一樣`).toBe(false);
      seen.set(k, String(b));
    }
  });

  it("空地也要有東西 —— 玩家要看得出「這裡可以蓋」", () => {
    expect(filled(renderSlot(art({ building: null })))).toBeGreaterThan(200);
  });
});

describe("狀態疊加", () => {
  it("★ 建造中要看得出來", () => {
    const idle = renderSlot(art({ level: 10 }));
    const busy = renderSlot(art({ level: 10, building_: true }));
    expect(key(idle)).not.toBe(key(busy));
    expect(filled(busy)).toBeGreaterThan(filled(idle));
  });

  it("閒置動畫兩幀不同（`docs/09` §2：2 幀、0.8s/幀）", () => {
    // 主堡要 t≥2 才有旗
    const a = renderSlot(art({ level: 20, frame: 0 }));
    const b = renderSlot(art({ level: 20, frame: 1 }));
    expect(key(a)).not.toBe(key(b));
  });

  it("沒有動畫部件的建築，兩幀相同 —— 不要為了動而動", () => {
    const a = renderSlot(art({ building: "DEPOT", level: 20, frame: 0 }));
    const b = renderSlot(art({ building: "DEPOT", level: 20, frame: 1 }));
    expect(key(a)).toBe(key(b));
  });
});

describe("決定性", () => {
  it("同樣的輸入永遠是同一張圖", () => {
    const a = renderSlot(art({ building: "WORKSHOP", level: 17, frame: 1 }));
    const b = renderSlot(art({ building: "WORKSHOP", level: 17, frame: 1 }));
    expect(key(a)).toBe(key(b));
  });
});

describe("slotSvg", () => {
  it("是合法的 SVG，且用 crispEdges（縮放不糊）", () => {
    const svg = slotSvg(art({ level: 12 }), 4);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('viewBox="0 0 128 128"');
  });

  it("★ 同一列連續同色合併成一個 rect —— 32×32 不該產出上千個節點", () => {
    const svg = slotSvg(art({ level: 30 }));
    const rects = svg.match(/<rect/g)?.length ?? 0;
    expect(rects).toBeGreaterThan(20);
    expect(rects).toBeLessThan(400);
  });

  it("不含透明格（0 不畫）", () => {
    expect(slotSvg(art())).not.toContain("transparent");
  });
});

describe("slotLabel", () => {
  it("主堡不在 CORE_BUILDING 裡，要另外處理", () => {
    expect(slotLabel("CITADEL")).toBe("主堡");
    expect(slotLabel("BARRACKS")).toBe("兵營");
    expect(slotLabel(null)).toBe("空地");
  });
});
