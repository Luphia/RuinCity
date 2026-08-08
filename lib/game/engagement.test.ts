import { describe, expect, it } from "vitest";

import { BATTLE_SLOTS } from "./balance";
import { armyPopulation } from "./formulas";
import {
  canJoin,
  distributeLosses,
  distributeSpoils,
  sideArmy,
  slotUsage,
  slotsFor,
  type Participant,
} from "./engagement";

const p = (playerId: number, side: "ATTACKER" | "DEFENDER", army: Participant["army"]) =>
  ({ playerId, side, army }) as Participant;

describe("★ 一格的容量：5 對 5，主城 10 對 10", () => {
  it("容量由「是不是主城」決定", () => {
    expect(slotsFor(false)).toEqual(BATTLE_SLOTS.tile);
    expect(slotsFor(true)).toEqual(BATTLE_SLOTS.keep);
    expect(BATTLE_SLOTS.tile.attacker).toBe(5);
    expect(BATTLE_SLOTS.keep.attacker).toBe(10);
  });

  it("攻方滿了就進不去，守方名額不受影響", () => {
    const five = Array.from({ length: 5 }, (_, i) => p(i + 1, "ATTACKER", { SWORDSMAN: 10 }));
    expect(canJoin(five, "ATTACKER", false)).toBe("SLOTS_FULL");
    expect(canJoin(five, "DEFENDER", false)).toBe(true);
    // 同樣五支，在主城還有一半的位子
    expect(canJoin(five, "ATTACKER", true)).toBe(true);
  });

  it("★ 名額算的是**部隊**不是人 —— 一個人可以佔多個", () => {
    const solo = Array.from({ length: 5 }, () => p(7, "ATTACKER", { SWORDSMAN: 10 }));
    expect(canJoin(solo, "ATTACKER", false)).toBe("SLOTS_FULL");
    // 若改成「一人一格」，五個人聯手反而比一個人分五批弱 —— 那會鼓勵洗小號
  });

  it("slotUsage 給 UI 一個「還剩幾個位子」", () => {
    const now = [p(1, "ATTACKER", {}), p(2, "ATTACKER", {}), p(3, "DEFENDER", {})];
    expect(slotUsage(now, false)).toEqual({
      attacker: { used: 2, cap: 5 },
      defender: { used: 1, cap: 5 },
    });
  });
});

describe("多方總帳", () => {
  const parts = [
    p(1, "ATTACKER", { SWORDSMAN: 100, CATAPULT: 5 }),
    p(2, "ATTACKER", { SWORDSMAN: 300 }),
    p(3, "DEFENDER", { SPEARMAN: 200 }),
  ];

  it("一方的總兵力是各自的合併", () => {
    expect(sideArmy(parts, "ATTACKER")).toEqual({ SWORDSMAN: 400, CATAPULT: 5 });
    expect(sideArmy(parts, "DEFENDER")).toEqual({ SPEARMAN: 200 });
  });

  it("★ 損失按出兵比例分回去，總和恰好等於總帳", () => {
    const share = distributeLosses(parts, "ATTACKER", { SWORDSMAN: 200, CATAPULT: 3 });
    const a = share.get(0)!;
    const b = share.get(1)!;
    expect((a.SWORDSMAN ?? 0) + (b.SWORDSMAN ?? 0)).toBe(200);
    // 100:300 → 50:150
    expect(a.SWORDSMAN).toBe(50);
    expect(b.SWORDSMAN).toBe(150);
  });

  it("★ 比例以兵種為單位 —— 你派的是投石機就只賠投石機", () => {
    const share = distributeLosses(parts, "ATTACKER", { CATAPULT: 3 });
    expect(share.get(0)!.CATAPULT).toBe(3); // 只有 1 號帶了器械
    expect(share.get(1)!.CATAPULT ?? 0).toBe(0);
  });

  it("沒有人會賠掉比自己帶的還多", () => {
    const share = distributeLosses(parts, "ATTACKER", { SWORDSMAN: 400, CATAPULT: 99 });
    expect(share.get(0)!.SWORDSMAN).toBeLessThanOrEqual(100);
    expect(share.get(1)!.SWORDSMAN).toBeLessThanOrEqual(300);
    expect(share.get(0)!.CATAPULT).toBeLessThanOrEqual(5);
  });

  it("除不盡時用 largest-remainder —— 不會憑空生滅士兵", () => {
    const three = [
      p(1, "ATTACKER", { SWORDSMAN: 10 }),
      p(2, "ATTACKER", { SWORDSMAN: 10 }),
      p(3, "ATTACKER", { SWORDSMAN: 10 }),
    ];
    const share = distributeLosses(three, "ATTACKER", { SWORDSMAN: 10 });
    const total = [0, 1, 2].reduce((s, i) => s + (share.get(i)!.SWORDSMAN ?? 0), 0);
    expect(total).toBe(10);
  });

  it("守方的損失不會被算進攻方的分配裡", () => {
    const share = distributeLosses(parts, "DEFENDER", { SPEARMAN: 50 });
    expect(share.get(2)!.SPEARMAN).toBe(50);
    expect(share.has(0)).toBe(false);
  });
});

describe("★ 戰利品按存活兵力分 —— 死光的那一支搬不動東西", () => {
  it("兩支存活比 1:3 就拿 1:3", () => {
    const survivors = new Map([
      [0, { SWORDSMAN: 25 }],
      [1, { SWORDSMAN: 75 }],
    ]);
    const spoils = distributeSpoils(survivors, 400);
    expect(spoils.get(0)).toBe(100);
    expect(spoils.get(1)).toBe(300);
    expect((spoils.get(0) ?? 0) + (spoils.get(1) ?? 0)).toBe(400);
  });

  it("全滅的那一支拿不到，而且總數不會少", () => {
    const survivors = new Map([
      [0, {}],
      [1, { SWORDSMAN: 10 }],
    ]);
    expect(armyPopulation({})).toBe(0);
    const spoils = distributeSpoils(survivors, 99);
    expect(spoils.get(0)).toBe(0);
    expect(spoils.get(1)).toBe(99);
  });

  it("大家都死光就沒有人拿得走（不會 NaN）", () => {
    const spoils = distributeSpoils(new Map([[0, {}]]), 500);
    expect(spoils.get(0)).toBe(0);
  });
});
