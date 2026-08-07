import { describe, expect, it } from "vitest";

import {
  battleOver,
  createBattlefield,
  DEFAULT_DURATION,
  isWallCell,
  squadCountFor,
  stepBattlefield,
  tally,
  type BattlefieldState,
} from "./battlefield";
import { CAMPS, CITADEL, GATE, GRID } from "./citadel";

const INPUT = {
  seed: 4217,
  attacker: {
    army: { SWORDSMAN: 400, ARCHER: 120, RAIDER: 60, RAM: 8 },
    losses: { SWORDSMAN: 150, ARCHER: 30, RAIDER: 20, RAM: 8 },
  },
  defender: {
    army: { MILITIA: 300, ARCHER: 100, LANCER: 40 },
    losses: { MILITIA: 300, ARCHER: 60, LANCER: 10 },
  },
  hasBase: true,
};

function runToEnd(state: BattlefieldState): BattlefieldState {
  let s = state;
  while (!battleOver(s)) s = stepBattlefield(s);
  return s;
}

describe("★ 決定性：同一份戰報，兩個人看到同一場戲", () => {
  it("同 seed → 每一幀都相同", () => {
    let a = createBattlefield(INPUT);
    let b = createBattlefield(INPUT);
    for (let i = 0; i < 60; i++) {
      a = stepBattlefield(a);
      b = stepBattlefield(b);
    }
    expect(a).toEqual(b);
  });

  it("不同 seed → 不同的開場", () => {
    const a = createBattlefield(INPUT);
    const b = createBattlefield({ ...INPUT, seed: 999 });
    expect(a.squads.map((s) => [s.x, s.y])).not.toEqual(b.squads.map((s) => [s.x, s.y]));
  });

  it("結束之後 step 是恆等 —— 不會多演", () => {
    const end = runToEnd(createBattlefield(INPUT));
    expect(stepBattlefield(end)).toBe(end);
  });
});

describe("★ 收斂：重播的結局 = 戰報的數字", () => {
  it("死亡士兵數與戰報損失的誤差在一個小隊以內", () => {
    const end = runToEnd(createBattlefield(INPUT));
    const scripted = (side: "attacker" | "defender") =>
      Object.values(INPUT[side].losses).reduce((s, n) => s + (n ?? 0), 0);

    for (const [side, key] of [
      ["ATTACKER", "attacker"],
      ["DEFENDER", "defender"],
    ] as const) {
      const t = tally(end, side);
      /**
       * 粒度：每一種兵的死亡以「隊」為單位取整，
       * 誤差上限 = Σ（該兵種的半個小隊）。這是顯示壓縮的代價 ——
       * 精確的帳目在戰報的數字裡，不在畫面上。
       */
      const grain = Object.values(INPUT[key].army).reduce(
        (sum, n) => sum + Math.ceil((n ?? 0) / squadCountFor(n ?? 0) / 2) + 1,
        0,
      );
      expect(Math.abs(t.dead - scripted(key)), `${side} 的陣亡對不上戰報`).toBeLessThanOrEqual(
        grain,
      );
    }
  });

  it("全滅就是全滅：losses = army 的那一側最後一個不剩", () => {
    const end = runToEnd(
      createBattlefield({
        ...INPUT,
        defender: { army: { MILITIA: 200 }, losses: { MILITIA: 200 } },
      }),
    );
    expect(tally(end, "DEFENDER").alive).toBe(0);
  });

  it("零損失就一個都不死", () => {
    const end = runToEnd(
      createBattlefield({
        ...INPUT,
        attacker: { army: { RAIDER: 50 }, losses: {} },
      }),
    );
    expect(tally(end, "ATTACKER").dead).toBe(0);
  });

  it("帳目守恆：alive + dead = 開場總數，每一 tick 都成立", () => {
    let s = createBattlefield(INPUT);
    const total = (side: "ATTACKER" | "DEFENDER") => {
      const t = tally(s, side);
      return t.alive + t.dead;
    };
    const a0 = total("ATTACKER");
    const d0 = total("DEFENDER");
    for (let i = 0; i < DEFAULT_DURATION; i++) {
      s = stepBattlefield(s);
      expect(total("ATTACKER")).toBe(a0);
      expect(total("DEFENDER")).toBe(d0);
    }
  });
});

describe("自主行動", () => {
  it("士兵會動：沒有任何一隊從頭站到尾", () => {
    const start = createBattlefield(INPUT);
    const end = runToEnd(start);
    for (const s0 of start.squads) {
      const s1 = end.squads.find((s) => s.id === s0.id)!;
      if (s1.dead) continue;
      const moved = Math.hypot(s1.x - s0.x, s1.y - s0.y);
      expect(moved, `隊 ${s0.id}（${s0.unit}）整場沒動`).toBeGreaterThan(0.5);
    }
  });

  it("會交戰：中段有隊伍進入 fighting", () => {
    let s = createBattlefield(INPUT);
    let sawFighting = false;
    for (let i = 0; i < DEFAULT_DURATION; i++) {
      s = stepBattlefield(s);
      if (s.squads.some((x) => x.fighting && !x.dead)) sawFighting = true;
    }
    expect(sawFighting).toBe(true);
  });

  it("★ 沒有敵人也會活著：純守軍（idle 模式）遊走而且無人陣亡", () => {
    let s = createBattlefield({
      seed: 7,
      attacker: { army: {}, losses: {} },
      defender: { army: { MILITIA: 80, ARCHER: 30 }, losses: {} },
      hasBase: true,
    });
    const start = s;
    for (let i = 0; i < 60; i++) s = stepBattlefield(s);
    expect(tally(s, "DEFENDER").dead).toBe(0);
    const moved = s.squads.some((x) => {
      const o = start.squads.find((y) => y.id === x.id)!;
      return Math.hypot(x.x - o.x, x.y - o.y) > 0.5;
    });
    expect(moved, "守軍應該在營區附近遊走").toBe(true);
  });
});

describe("★ 地形：城牆是實體", () => {
  it("牆格判定：外圈是牆、內部不是、門不是", () => {
    expect(isWallCell(CITADEL.x, CITADEL.y)).toBe(true);
    expect(isWallCell(CITADEL.x + 4, CITADEL.y + 4)).toBe(false);
    expect(isWallCell(GATE.x, GATE.y)).toBe(false);
    expect(isWallCell(GATE.x - 1, GATE.y)).toBe(true);
    expect(isWallCell(0, 0)).toBe(false);
  });

  it("沒有任何一隊站在牆裡，每一 tick 都成立", () => {
    let s = createBattlefield(INPUT);
    for (let i = 0; i < DEFAULT_DURATION; i++) {
      s = stepBattlefield(s);
      for (const q of s.squads) {
        if (q.dead) continue;
        expect(isWallCell(Math.floor(q.x), Math.floor(q.y)), `隊 ${q.id} 在牆裡`).toBe(false);
      }
    }
  });

  it("沒有任何一隊走出 50×50", () => {
    const end = runToEnd(createBattlefield(INPUT));
    for (const q of end.squads) {
      expect(q.x).toBeGreaterThanOrEqual(0);
      expect(q.y).toBeGreaterThanOrEqual(0);
      expect(q.x).toBeLessThanOrEqual(GRID);
      expect(q.y).toBeLessThanOrEqual(GRID);
    }
  });
});

describe("開場位置", () => {
  it("守軍從自己的營區出發", () => {
    const s = createBattlefield(INPUT);
    for (const q of s.squads) {
      if (q.side !== "DEFENDER") continue;
      const camp = CAMPS[q.group];
      expect(q.x).toBeGreaterThanOrEqual(camp.x);
      expect(q.x).toBeLessThanOrEqual(camp.x + camp.w);
      expect(q.y).toBeGreaterThanOrEqual(camp.y);
      expect(q.y).toBeLessThanOrEqual(camp.y + camp.h);
    }
  });

  it("攻方從地圖邊緣進場，不會憑空出現在城裡", () => {
    const s = createBattlefield(INPUT);
    for (const q of s.squads) {
      if (q.side !== "ATTACKER") continue;
      const nearEdge = q.x < 5 || q.y < 5 || q.x > GRID - 5 || q.y > GRID - 5;
      expect(nearEdge, `隊 ${q.id} 沒有從邊緣進場`).toBe(true);
    }
  });
});

describe("squadCountFor", () => {
  it("對數壓縮、單調不遞減、有上限", () => {
    expect(squadCountFor(0)).toBe(0);
    expect(squadCountFor(1)).toBeGreaterThan(0);
    let prev = 0;
    for (const n of [1, 10, 100, 1000, 10000]) {
      const c = squadCountFor(n);
      expect(c).toBeGreaterThanOrEqual(prev);
      expect(c).toBeLessThanOrEqual(6);
      prev = c;
    }
  });
});
