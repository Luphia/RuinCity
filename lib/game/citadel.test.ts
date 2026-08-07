import { describe, expect, it } from "vitest";

import { UNIT, UNITS } from "./balance";
import {
  CAMPS,
  citadelSceneSvg,
  garrisonGroups,
  groupOf,
  markCount,
  PLOTS,
  renderCitadelScene,
  SCENE_SIZE,
  TROOP_GROUPS,
  WALL,
  type SceneSlot,
} from "./citadel";

const slots = (over: Partial<Record<"A" | "B" | "C" | "D", Partial<SceneSlot>>> = {}) =>
  (["A", "B", "C", "D"] as const).map((slot) => ({
    slot,
    building: slot === "A" ? ("CITADEL" as const) : null,
    level: slot === "A" ? 1 : 0,
    busy: false,
    ...over[slot],
  }));

/**
 * ★ 不能用「有顏色的格子數」當指標 —— 地面鋪滿整張畫布，那個數字恆等於
 *   160×160。要比的是**內容**，所以逐格比。
 */
const differs = (a: Uint8Array, b: Uint8Array) => !Buffer.from(a).equals(Buffer.from(b));
const nonGround = (g: Uint8Array) => g.reduce((n, v) => n + (v !== 12 && v !== 13 ? 1 : 0), 0);

describe("版面", () => {
  it("四塊地都在城牆裡面", () => {
    for (const p of PLOTS) {
      expect(p.x).toBeGreaterThan(WALL.x);
      expect(p.y).toBeGreaterThan(WALL.y);
      expect(p.x + p.w).toBeLessThan(WALL.x + WALL.w);
      expect(p.y + p.h).toBeLessThan(WALL.y + WALL.h);
    }
  });

  it("★ 四塊地彼此不重疊 —— 重疊代表點擊區會互相搶", () => {
    for (let i = 0; i < PLOTS.length; i++) {
      for (let j = i + 1; j < PLOTS.length; j++) {
        const a = PLOTS[i]!;
        const b = PLOTS[j]!;
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.slot} 與 ${b.slot} 重疊`).toBe(false);
      }
    }
  });

  it("★ 四支部隊都在城牆**外面**", () => {
    for (const g of TROOP_GROUPS) {
      const box = CAMPS[g];
      expect(box.y, `${g} 應該在南牆下方`).toBeGreaterThanOrEqual(WALL.y + WALL.h);
      expect(box.x + box.w).toBeLessThanOrEqual(SCENE_SIZE);
    }
  });

  it("營地彼此不重疊", () => {
    const boxes = TROOP_GROUPS.map((g) => CAMPS[g]);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        expect(a.x < b.x + b.w && b.x < a.x + a.w).toBe(false);
      }
    }
  });
});

describe("★ 兵種分組：畫面上的四支部隊", () => {
  it("每一種兵都恰好屬於一支", () => {
    for (const u of UNITS) expect(TROOP_GROUPS).toContain(groupOf(u));
  });

  it("弓手單獨一支 —— 它在戰鬥模型裡是 INFANTRY，在畫面上不是", () => {
    expect(UNIT.ARCHER.attackClass).toBe("INFANTRY");
    expect(groupOf("ARCHER")).toBe("ARCHER");
    expect(groupOf("SWORDSMAN")).toBe("INFANTRY");
  });

  it("騎兵與器械照 attackClass 走", () => {
    expect(groupOf("RAIDER")).toBe("CAVALRY");
    expect(groupOf("LANCER")).toBe("CAVALRY");
    expect(groupOf("RUIN_WATCHER")).toBe("CAVALRY");
    expect(groupOf("RAM")).toBe("SIEGE");
    expect(groupOf("CATAPULT")).toBe("SIEGE");
  });

  it("偵查兵併進步兵，但不會消失", () => {
    expect(groupOf("SCOUT")).toBe("INFANTRY");
    const g = garrisonGroups({ SCOUT: 7 });
    const infantry = g.find((x) => x.group === "INFANTRY")!;
    expect(infantry.total).toBe(7);
    expect(infantry.units.map((u) => u.unit)).toContain("SCOUT");
  });

  it("★ 分組不會漏兵：各組總和 = 駐軍總和", () => {
    const army = { MILITIA: 120, ARCHER: 45, RAIDER: 30, CATAPULT: 4, SCOUT: 2 };
    const sum = garrisonGroups(army).reduce((s, g) => s + g.total, 0);
    expect(sum).toBe(201);
  });

  it("沒有的兵種不會列進去", () => {
    const g = garrisonGroups({ MILITIA: 5 });
    expect(g.find((x) => x.group === "CAVALRY")!.units).toEqual([]);
    expect(g.find((x) => x.group === "CAVALRY")!.total).toBe(0);
  });
});

describe("markCount：畫幾個小人", () => {
  it("沒有兵就不畫", () => {
    expect(markCount(0)).toBe(0);
  });

  it("★ 用對數 —— 一萬名步兵畫不下，玩家要看的是「多不多」", () => {
    expect(markCount(1)).toBeGreaterThan(0);
    expect(markCount(10)).toBeGreaterThan(markCount(1));
    expect(markCount(1000)).toBeGreaterThan(markCount(10));
    expect(markCount(100000)).toBeLessThanOrEqual(9);
  });

  it("單調不遞減", () => {
    let prev = 0;
    for (const n of [1, 5, 20, 100, 500, 2000, 10000]) {
      const m = markCount(n);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });
});

describe("繪製", () => {
  it("畫得出東西，而且沒有畫到界外", () => {
    const g = renderCitadelScene({ slots: slots(), garrison: {}, frame: 0 });
    expect(g).toHaveLength(SCENE_SIZE * SCENE_SIZE);
    // 扣掉地面之後仍有大量內容 = 城牆與建築真的畫出來了
    expect(nonGround(g)).toBeGreaterThan(1500);
  });

  it("★ 等級不同，圖就要不同 —— 否則點擊升級沒有回饋", () => {
    const lo = renderCitadelScene({
      slots: slots({ A: { level: 1 } }),
      garrison: {},
      frame: 0,
    });
    const hi = renderCitadelScene({
      slots: slots({ A: { level: 30 } }),
      garrison: {},
      frame: 0,
    });
    expect(differs(lo, hi)).toBe(true);
  });

  it("★ 蓋了城牆之後，牆要變厚 —— RAMPART 是唯一改變輪廓的建築", () => {
    const none = renderCitadelScene({ slots: slots(), garrison: {}, frame: 0 });
    const walled = renderCitadelScene({
      slots: slots({ B: { building: "RAMPART", level: 20 } }),
      garrison: {},
      frame: 0,
    });
    expect(differs(none, walled)).toBe(true);
  });

  it("有兵與沒兵的畫面不一樣", () => {
    const empty = renderCitadelScene({ slots: slots(), garrison: {}, frame: 0 });
    const manned = renderCitadelScene({
      slots: slots(),
      garrison: { MILITIA: 200, RAIDER: 30, ARCHER: 50, CATAPULT: 3 },
      frame: 0,
    });
    expect(differs(empty, manned)).toBe(true);
    // 兵越多，牆外畫的東西越多
    expect(nonGround(manned)).toBeGreaterThan(nonGround(empty));
  });

  it("兩幀會動（主堡有旗的時候）", () => {
    const s = slots({ A: { level: 20 } });
    const a = renderCitadelScene({ slots: s, garrison: {}, frame: 0 });
    const b = renderCitadelScene({ slots: s, garrison: {}, frame: 1 });
    expect(differs(a, b)).toBe(true);
  });

  it("施工中會疊鷹架", () => {
    const calm = renderCitadelScene({ slots: slots(), garrison: {}, frame: 0 });
    const busy = renderCitadelScene({
      slots: slots({ A: { busy: true } }),
      garrison: {},
      frame: 0,
    });
    expect(differs(calm, busy)).toBe(true);
  });

  it("SVG 是合法的、而且只用調色盤裡的顏色", () => {
    const svg = citadelSceneSvg({ slots: slots(), garrison: { MILITIA: 10 }, frame: 0 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    const fills = new Set([...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]!));
    for (const f of fills) expect(f).toMatch(/^#[0-9a-f]{6}$/);
  });
});
