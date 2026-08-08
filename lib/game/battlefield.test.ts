import { describe, expect, it } from "vitest";

import {
  ATTACK_INTERVAL,
  battleOver,
  BEATS,
  counters,
  createBattlefield,
  damageOf,
  DEFAULT_DURATION,
  isWallCell,
  RAGE_MAX,
  RAGE_PER_HIT,
  squadCountFor,
  statsOf,
  stepBattlefield,
  tally,
  threatOf,
  type BattlefieldState,
  type Squad,
} from "./battlefield";
import { CAMPS, CITADEL, GATE, GRID, groupOf, type TroopGroup } from "./citadel";

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

// ─────────────────────────────────────────────────────────────
// v2：微觀戰鬥（相剋、怒氣、攻速、威脅度、配額）
// ─────────────────────────────────────────────────────────────

/** 手工組一隊 —— damageOf/stepBattlefield 只吃資料，不管它怎麼來 */
function mkSquad(
  o: Partial<Squad> & Pick<Squad, "id" | "side" | "unit">,
  group?: TroopGroup,
): Squad {
  const g = group ?? o.group ?? groupOf(o.unit);
  const hp = statsOf(o.unit, "INFANTRY").hp;
  return {
    soldiers: 100,
    x: 10,
    y: 10,
    hp,
    maxHp: hp,
    rage: 0,
    cooldown: 0,
    dead: false,
    fighting: false,
    targetId: null,
    skillBurst: false,
    ...o,
    group: g,
  };
}

/** duration 拉長，讓「傷重不治」的尾聲不會混進測試窗口 */
function mkState(
  squads: Squad[],
  budgets: Record<string, number> = {},
  duration = 400,
): BattlefieldState {
  return { tick: 0, duration, hasBase: false, squads, budgets };
}

describe("★ 相剋：步剋騎、騎剋弓與器械、弓剋步，各 ±20%", () => {
  it("相剋表就是規格", () => {
    expect(BEATS.INFANTRY).toEqual(["CAVALRY"]);
    expect(BEATS.CAVALRY).toEqual(["ARCHER", "SIEGE"]);
    expect(BEATS.ARCHER).toEqual(["INFANTRY"]);
    expect(BEATS.SIEGE).toEqual([]);
    for (const g of ["INFANTRY", "CAVALRY", "ARCHER", "SIEGE"] as const) {
      expect(counters(g, g), `${g} 不該剋自己`).toBe(false);
    }
  });

  it("剋到 → 攻擊 +20%：同一對兵，只把守方換成被剋的兵種，傷害變高", () => {
    const atk = mkSquad({ id: 1, side: "ATTACKER", unit: "MILITIA" }, "INFANTRY");
    // 同一個 unit（同防禦值），只有 group 不同 → 差異只來自相剋
    const countered = mkSquad({ id: 2, side: "DEFENDER", unit: "MILITIA" }, "CAVALRY");
    const neutral = mkSquad({ id: 3, side: "DEFENDER", unit: "MILITIA" }, "INFANTRY");
    expect(damageOf(atk, countered, false)).toBeGreaterThan(damageOf(atk, neutral, false));
  });

  it("被剋 → 防禦視同 −20%：守方剋攻方時，同一擊的傷害變低", () => {
    const atk = mkSquad({ id: 1, side: "ATTACKER", unit: "RAIDER" }, "CAVALRY");
    // SPEARMAN 的防禦值相同，group 決定它是否剋騎兵（INFANTRY 剋 CAVALRY）
    const counteringDef = mkSquad({ id: 2, side: "DEFENDER", unit: "SPEARMAN" }, "INFANTRY");
    const neutralDef = mkSquad({ id: 3, side: "DEFENDER", unit: "SPEARMAN" }, "CAVALRY");
    expect(damageOf(atk, counteringDef, false)).toBeLessThan(damageOf(atk, neutralDef, false));
  });

  it("防禦是方向性的：對騎防禦用 defCavalry，對步防禦用 defInfantry", () => {
    expect(statsOf("SPEARMAN", "CAVALRY").defense).toBe(55);
    expect(statsOf("SPEARMAN", "INFANTRY").defense).toBe(20);
  });

  it("技能 = 3 倍傷害", () => {
    const a = mkSquad({ id: 1, side: "ATTACKER", unit: "SWORDSMAN" });
    const d = mkSquad({ id: 2, side: "DEFENDER", unit: "MILITIA" });
    expect(damageOf(a, d, true)).toBe(damageOf(a, d, false) * 3);
  });
});

describe("★ 目標選擇：射程內打威脅最高的，射程外朝最近的走", () => {
  it("威脅度 = 對方一擊能打掉我多少（含相剋）", () => {
    const me = mkSquad({ id: 1, side: "DEFENDER", unit: "ARCHER" });
    const militia = mkSquad({ id: 2, side: "ATTACKER", unit: "MILITIA" });
    const lancer = mkSquad({ id: 3, side: "ATTACKER", unit: "LANCER" });
    expect(threatOf(lancer, me)).toBeGreaterThan(threatOf(militia, me));
  });

  it("射程內不打最近的，打威脅最高的", () => {
    // 弓手射程 7：民兵貼臉（距離 1）、重騎在 5 格外 —— 威脅是重騎
    const state = mkState([
      mkSquad({ id: 1, side: "DEFENDER", unit: "ARCHER", x: 25, y: 25, hp: 1e6, maxHp: 1e6 }),
      mkSquad({ id: 2, side: "ATTACKER", unit: "MILITIA", x: 26, y: 25, hp: 1e6, maxHp: 1e6 }),
      mkSquad({ id: 3, side: "ATTACKER", unit: "LANCER", x: 30, y: 25, hp: 1e6, maxHp: 1e6 }),
    ]);
    const next = stepBattlefield(state);
    const archer = next.squads.find((s) => s.id === 1)!;
    expect(archer.fighting).toBe(true);
    expect(archer.targetId).toBe(3);
  });

  it("射程外 → 朝最近的敵人縮短距離", () => {
    const state = mkState([
      mkSquad({ id: 1, side: "ATTACKER", unit: "SWORDSMAN", x: 5, y: 25 }),
      mkSquad({ id: 2, side: "DEFENDER", unit: "MILITIA", x: 45, y: 25 }),
    ]);
    const next = stepBattlefield(state);
    const sword = next.squads.find((s) => s.id === 1)!;
    expect(sword.x).toBeGreaterThan(5);
    expect(sword.fighting).toBe(false);
  });
});

describe("★ 攻速與怒氣", () => {
  /** 兩隊民兵貼臉互毆，血量灌到打不死 —— 只看節奏與怒氣 */
  function duel(): BattlefieldState {
    return mkState([
      mkSquad({ id: 1, side: "ATTACKER", unit: "MILITIA", x: 10, y: 10, hp: 1e6, maxHp: 1e6 }),
      mkSquad({ id: 2, side: "DEFENDER", unit: "MILITIA", x: 11, y: 10, hp: 1e6, maxHp: 1e6 }),
    ]);
  }

  it("出手節奏 = ATTACK_INTERVAL：步兵每 3 tick 掉一次血", () => {
    let s = duel();
    const hitTicks: number[] = [];
    let prevHp = 1e6;
    for (let t = 1; t <= 12; t++) {
      s = stepBattlefield(s);
      const hp = s.squads.find((q) => q.id === 2)!.hp;
      if (hp < prevHp) hitTicks.push(t);
      prevHp = hp;
    }
    expect(hitTicks).toEqual([1, 4, 7, 10]);
    expect(hitTicks[1]! - hitTicks[0]!).toBe(ATTACK_INTERVAL.INFANTRY);
  });

  it("怒氣：出手 +20、挨打 +15，滿 100 放技能（3 倍傷害）並清空", () => {
    let s = duel();
    let burstTick = 0;
    let normalDelta = 0;
    let burstDelta = 0;
    let rageAfterBurst = -1;
    let prevHp = 1e6;
    for (let t = 1; t <= 15 && burstTick === 0; t++) {
      s = stepBattlefield(s);
      const me = s.squads.find((q) => q.id === 1)!;
      const foe = s.squads.find((q) => q.id === 2)!;
      const delta = prevHp - foe.hp;
      prevHp = foe.hp;
      if (me.skillBurst) {
        burstTick = t;
        burstDelta = delta;
        rageAfterBurst = me.rage;
      } else if (delta > 0) {
        normalDelta = delta;
      }
    }
    expect(burstTick, "15 tick 內應該打出一次技能").toBeGreaterThan(0);
    expect(burstDelta).toBe(normalDelta * 3);
    // 技能清空怒氣；之後最多只剩同一 tick 挨打的那一份
    expect(rageAfterBurst).toBeLessThanOrEqual(RAGE_PER_HIT);
    expect(rageAfterBurst).toBeLessThan(RAGE_MAX);
  });
});

describe("★ 死亡配額：戰鬥決定誰死，戰報決定死幾個", () => {
  it("有配額 → 血條見底就陣亡，配額 −1", () => {
    const s = mkState(
      [
        mkSquad({ id: 1, side: "ATTACKER", unit: "SWORDSMAN", x: 10, y: 10 }),
        mkSquad({ id: 2, side: "DEFENDER", unit: "MILITIA", x: 11, y: 10, hp: 5 }),
      ],
      { "DEFENDER:MILITIA": 1 },
    );
    const next = stepBattlefield(s);
    const militia = next.squads.find((q) => q.id === 2)!;
    expect(militia.dead).toBe(true);
    expect(next.budgets["DEFENDER:MILITIA"]).toBe(0);
  });

  it("配額用完 → 血條見底以殘血再戰，永遠不會死", () => {
    let s = mkState(
      [
        mkSquad({ id: 1, side: "ATTACKER", unit: "SWORDSMAN", x: 10, y: 10, hp: 1e6, maxHp: 1e6 }),
        mkSquad({ id: 2, side: "DEFENDER", unit: "MILITIA", x: 11, y: 10, hp: 5 }),
      ],
      { "DEFENDER:MILITIA": 0 },
    );
    let revived = false;
    let prevHp = 5;
    for (let t = 0; t < 30; t++) {
      s = stepBattlefield(s);
      const militia = s.squads.find((q) => q.id === 2)!;
      expect(militia.dead, `tick ${s.tick}：配額 0 卻死了`).toBe(false);
      expect(militia.hp).toBeGreaterThan(0);
      if (militia.hp > prevHp) revived = true;
      prevHp = militia.hp;
    }
    expect(revived, "應該看得到殘血回彈（40% 血再戰）").toBe(true);
  });

  it("屍體不動也不再參戰", () => {
    let s = mkState(
      [
        mkSquad({ id: 1, side: "ATTACKER", unit: "SWORDSMAN", x: 10, y: 10 }),
        mkSquad({ id: 2, side: "DEFENDER", unit: "MILITIA", x: 11, y: 10, hp: 5 }),
        mkSquad({ id: 3, side: "DEFENDER", unit: "MILITIA", x: 20, y: 10, hp: 1e6, maxHp: 1e6 }),
      ],
      { "DEFENDER:MILITIA": 1 },
    );
    s = stepBattlefield(s);
    const corpse = s.squads.find((q) => q.id === 2)!;
    expect(corpse.dead).toBe(true);
    const { x, y } = corpse;
    for (let t = 0; t < 10; t++) s = stepBattlefield(s);
    const later = s.squads.find((q) => q.id === 2)!;
    expect([later.x, later.y]).toEqual([x, y]);
    expect(later.fighting).toBe(false);
    expect(later.targetId).toBeNull();
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
