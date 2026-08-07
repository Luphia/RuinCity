import { describe, expect, it } from "vitest";

import { CAMPS, COMBAT, SEASON_MODIFIERS, UNIT } from "./balance";
import { moraleFactor, resolveBattle, type Army } from "./combat";
import { armyPopulation, innateDefense, vaultProtection } from "./formulas";

const ATTACK = { marchType: "ATTACK" } as const;

function power(r: ReturnType<typeof resolveBattle>) {
  return {
    atk: r.breakdown.attackerFinalPower,
    def: r.breakdown.defenderFinalPower,
  };
}

describe("士氣係數", () => {
  it("符合 docs/04 §3.2 的表", () => {
    const table: [number, number, number][] = [
      [100, 100, 1.0],
      [100, 200, 0.78],
      [100, 500, 0.57],
      [100, 1000, 0.45],
      [100, 2000, 0.35],
    ];
    for (const [def, atk, expected] of table) {
      expect(moraleFactor(def, atk)).toBeCloseTo(expected, 2);
    }
  });

  it("守方人口大於攻方時不獎勵守方（上限 1）", () => {
    expect(moraleFactor(5000, 100)).toBe(1);
  });

  it("遺跡爭奪戰不套用士氣", () => {
    const attacker = { army: { SWORDSMAN: 2000 } satisfies Army };
    const defender = { army: { ARCHER: 50 } satisfies Army };

    const normal = resolveBattle(attacker, defender, ATTACK);
    const ruin = resolveBattle(attacker, defender, { ...ATTACK, skipMorale: true });

    expect(normal.breakdown.morale).toBeLessThan(0.5);
    expect(ruin.breakdown.morale).toBe(1);
    expect(power(ruin).atk).toBeGreaterThan(power(normal).atk);
  });
});

describe("損失曲線", () => {
  it("符合 docs/04 §3.3 的存活率表", () => {
    // 用純粹的戰力比驗證曲線本身
    const table: [number, number][] = [
      [1.1, 0.13],
      [1.5, 0.46],
      [2.0, 0.65],
      [3.0, 0.81],
      [5.0, 0.91],
    ];
    for (const [ratio, expected] of table) {
      const survival = 1 - (1 / ratio) ** COMBAT.lossExponent;
      expect(survival).toBeCloseTo(expected, 2);
    }
  });

  it("險勝要付出慘痛代價：戰力比 1.1 時攻方只剩 13%", () => {
    // 構造一場攻方戰力剛好略高的戰鬥
    const r = resolveBattle(
      { army: { SWORDSMAN: 100 } },
      { army: { SPEARMAN: 100 } },
      ATTACK,
    );
    expect(r.outcome).toBe("ATTACKER_WIN");
    const survivors = armyPopulation(r.attackerSurvivors);
    expect(survivors).toBeLessThan(100);
    expect(survivors).toBeGreaterThan(0);
  });

  it("敗方全滅", () => {
    const r = resolveBattle(
      { army: { MILITIA: 10 } },
      { army: { ARCHER: 500 } },
      ATTACK,
    );
    expect(r.outcome).toBe("DEFENDER_WIN");
    expect(armyPopulation(r.attackerSurvivors)).toBe(0);
  });

  it("突襲雙方都保留部分兵力", () => {
    const atk = { army: { RAIDER: 200 } satisfies Army };
    const def = { army: { SPEARMAN: 50 } satisfies Army };

    const full = resolveBattle(atk, def, { marchType: "ATTACK" });
    const raid = resolveBattle(atk, def, { marchType: "RAID" });

    expect(armyPopulation(full.defenderSurvivors)).toBe(0);
    expect(armyPopulation(raid.defenderSurvivors)).toBeGreaterThan(0);
    expect(armyPopulation(raid.attackerSurvivors)).toBeGreaterThan(
      armyPopulation(full.attackerSurvivors),
    );
  });
});

describe("兵種克制", () => {
  it("長矛兵是廉價的反騎兵牆", () => {
    const cavalry = { army: { LANCER: 100 } satisfies Army };
    const vsSpear = resolveBattle(cavalry, { army: { SPEARMAN: 200 } }, ATTACK);
    const vsSword = resolveBattle(cavalry, { army: { SWORDSMAN: 200 } }, ATTACK);

    // 同樣 200 人，長矛擋騎兵遠比劍士有效
    expect(vsSpear.breakdown.defenderFinalPower).toBeGreaterThan(
      vsSword.breakdown.defenderFinalPower * 2,
    );
  });

  it("弓手是最強的通用防守單位，但帶去進攻是浪費", () => {
    const asDefender = resolveBattle(
      { army: { SWORDSMAN: 100 } },
      { army: { ARCHER: 100 } },
      ATTACK,
    );
    const asAttacker = resolveBattle(
      { army: { ARCHER: 100 } },
      { army: { SWORDSMAN: 100 } },
      ATTACK,
    );
    // 弓手守得住劍士，但攻不動劍士
    expect(asDefender.outcome).toBe("DEFENDER_WIN");
    expect(asAttacker.outcome).toBe("DEFENDER_WIN");
  });

  it("騎兵佔比加權，避免 39% vs 40% 的二元跳變", () => {
    const mostlyInfantry = resolveBattle(
      { army: { SWORDSMAN: 100, LANCER: 5 } },
      { army: { SPEARMAN: 100 } },
      ATTACK,
    );
    const mostlyCavalry = resolveBattle(
      { army: { SWORDSMAN: 5, LANCER: 100 } },
      { army: { SPEARMAN: 100 } },
      ATTACK,
    );
    expect(mostlyInfantry.breakdown.cavalryWeight).toBeLessThan(0.2);
    expect(mostlyCavalry.breakdown.cavalryWeight).toBeGreaterThan(0.8);
    // 守方的長矛對騎兵防禦高 → 面對騎兵時守方戰力更高
    expect(mostlyCavalry.breakdown.defenderFinalPower).toBeGreaterThan(
      mostlyInfantry.breakdown.defenderFinalPower,
    );
  });
});

describe("城池防禦", () => {
  it("沒有攻城器械就別想拆牆，且懲罰上限 50%", () => {
    const atk = { army: { SWORDSMAN: 500 } satisfies Army };
    const withSiege = { army: { SWORDSMAN: 500, RAM: 10 } satisfies Army };

    const noSiege = resolveBattle(atk, { army: { ARCHER: 100 }, wallLevel: 10 }, ATTACK);
    const siege = resolveBattle(withSiege, { army: { ARCHER: 100 }, wallLevel: 10 }, ATTACK);

    expect(noSiege.breakdown.noSiegeMultiplier).toBeCloseTo(0.5, 5);
    expect(siege.breakdown.noSiegeMultiplier).toBe(1);

    // 城牆 20 級也不會超過 −50%
    const capped = resolveBattle(atk, { army: { ARCHER: 100 }, wallLevel: 20 }, ATTACK);
    expect(capped.breakdown.noSiegeMultiplier).toBeCloseTo(0.5, 5);
  });

  it("固有防禦讓早期進攻的交換極度昂貴（docs/16 §4.1）", () => {
    // Lv5 守方：50 民兵（防 12）+ 50 長矛（防 20）= 1,600 + 固有 600 = 2,200
    const defender = {
      army: { MILITIA: 50, SPEARMAN: 50 } satisfies Army,
      innateDefense: innateDefense(5),
    };

    // 守方人口(100) > 攻方人口 → 士氣是 1.0，不打折。
    // 這正是文件原本算錯的地方。
    const at45 = resolveBattle({ army: { SWORDSMAN: 45 } }, defender, ATTACK);
    expect(at45.breakdown.morale).toBe(1);
    expect(at45.outcome).toBe("DEFENDER_WIN");

    // 46 名劍士才勝得了，而且幾乎全滅
    const at46 = resolveBattle({ army: { SWORDSMAN: 46 } }, defender, ATTACK);
    expect(at46.outcome).toBe("ATTACKER_WIN");
    expect(armyPopulation(at46.attackerSurvivors)).toBeLessThanOrEqual(1);

    // 50 名劍士也只有 6 個回得來 —— 嚇阻來自「交換昂貴」，不是「擋得住」
    const at50 = resolveBattle({ army: { SWORDSMAN: 50 } }, defender, ATTACK);
    expect(at50.outcome).toBe("ATTACKER_WIN");
    expect(armyPopulation(at50.attackerSurvivors)).toBe(6);
  });

  it("固有防禦在後期相對微不足道 —— 保護強度隨成長自然淡出", () => {
    const lv20 = innateDefense(20); // 2,400
    const bigArmy = resolveBattle(
      { army: { SWORDSMAN: 3000 } },
      { army: { ARCHER: 2000 }, innateDefense: lv20 },
      ATTACK,
    );
    // 固有防禦佔守方總戰力的比重應該很低
    expect(lv20 / bigArmy.breakdown.defenderFinalPower).toBeLessThan(0.03);
  });

  it("主旗（盟主據點）固有防禦加倍", () => {
    expect(innateDefense(20, true)).toBe(innateDefense(20) * 2);
  });

  it("醫療帳只在自己據點生效，且上限 60%", () => {
    const def = { army: { ARCHER: 100 }, infirmaryLevel: 30 };
    const atk = { army: { SWORDSMAN: 1000 } };

    const away = resolveBattle(atk, def, { ...ATTACK, defenderAtHome: false });
    const home = resolveBattle(atk, def, { ...ATTACK, defenderAtHome: true });

    expect(armyPopulation(away.defenderWounded)).toBe(0);
    // 25% + 2%×30 = 85% → clamp 到 60%
    expect(armyPopulation(home.defenderWounded)).toBe(60);
  });
});

describe("掠奪", () => {
  it("掠奪量受士氣打折，且受載重上限限制", () => {
    const lootable = { grain: 10_000, timber: 10_000, stone: 0, iron: 0 };

    // 大打小：士氣低 → 拿得少
    const bully = resolveBattle(
      { army: { RAIDER: 100 } }, // 載重 14,000
      { army: { MILITIA: 5 }, lootable },
      ATTACK,
    );
    // 勢均力敵：士氣 1 → 吃滿載重
    const fair = resolveBattle(
      { army: { RAIDER: 100 } },
      { army: { MILITIA: 190 }, lootable },
      ATTACK,
    );

    const bullyTotal = (bully.loot.grain ?? 0) + (bully.loot.timber ?? 0);
    const fairTotal = (fair.loot.grain ?? 0) + (fair.loot.timber ?? 0);

    expect(fair.outcome).toBe("ATTACKER_WIN");
    expect(bullyTotal).toBeLessThan(fairTotal * 0.5);
  });

  it("按未保護量的比例分攤載重，不會只搶一種", () => {
    const r = resolveBattle(
      { army: { RAIDER: 10 } }, // 載重 1,400
      { army: { MILITIA: 18 }, lootable: { grain: 3000, timber: 1000 } },
      ATTACK,
    );
    expect(r.outcome).toBe("ATTACKER_WIN");
    expect(r.loot.grain).toBeGreaterThan(0);
    expect(r.loot.timber).toBeGreaterThan(0);
    // 糧食是木材的 3 倍 → 搶到的比例也接近 3:1
    expect((r.loot.grain ?? 0) / (r.loot.timber ?? 1)).toBeCloseTo(3, 0);
  });

  it("攻城單位載重為 0，搶不走東西", () => {
    const r = resolveBattle(
      { army: { RAM: 50 } },
      { army: { MILITIA: 90 }, lootable: { grain: 9999 } },
      ATTACK,
    );
    expect(r.outcome).toBe("ATTACKER_WIN");
    expect(r.loot.grain ?? 0).toBe(0);
  });

  it("敗方拿不到戰利品", () => {
    const r = resolveBattle(
      { army: { MILITIA: 10 } },
      { army: { ARCHER: 500 }, lootable: { grain: 9999 } },
      ATTACK,
    );
    expect(r.outcome).toBe("DEFENDER_WIN");
    expect(r.loot).toEqual({});
  });
});

describe("★ 第 1 天的新手被打（docs/16 §7）", () => {
  it("新手損失一堂課，攻方收穫零，且不計積分", () => {
    // Lv1 新手：10 民兵、庫存 600、春季地窖保護 660
    const stock = 600;
    const vault = vaultProtection(1, 0, SEASON_MODIFIERS.SPRING);
    const unprotected = Math.max(0, stock - vault);

    const r = resolveBattle(
      { army: { SWORDSMAN: 200 } },
      {
        army: { MILITIA: 10 },
        innateDefense: innateDefense(1),
        lootable: { grain: unprotected, timber: unprotected },
      },
      ATTACK,
    );

    // 春季地窖 (300 + 30) × 2 = 660 > 600 → 一毛都搶不到
    expect(vault).toBe(660);
    expect(unprotected).toBe(0);

    expect(r.outcome).toBe("ATTACKER_WIN");
    expect(r.breakdown.defenderFlatDefense).toBe(120);
    expect(r.breakdown.morale).toBeCloseTo(0.35, 2);
    expect(r.loot.grain ?? 0).toBe(0);

    // 人口比 20:1 → 不計任何賽季積分
    expect(r.scoring).toBe(false);

    // 新手損失就是那 10 名民兵
    expect(armyPopulation(r.defenderLosses)).toBe(10);
  });

  it("勢均力敵的戰鬥照常計分", () => {
    const r = resolveBattle(
      { army: { SWORDSMAN: 100 } },
      { army: { ARCHER: 100 } },
      ATTACK,
    );
    expect(r.scoring).toBe(true);
  });
});

describe("結算不變式", () => {
  it("存活 + 損失 = 原始兵力", () => {
    const cases: [Army, Army][] = [
      [{ SWORDSMAN: 137, RAIDER: 41 }, { ARCHER: 89, SPEARMAN: 53 }],
      [{ MILITIA: 1 }, { MILITIA: 1 }],
      [{ LANCER: 999, RAM: 7 }, { WASTE_GUARD: 300 }],
    ];
    for (const [a, d] of cases) {
      const r = resolveBattle({ army: a }, { army: d }, ATTACK);
      for (const [unit, n] of Object.entries(a)) {
        const survived = r.attackerSurvivors[unit as keyof Army] ?? 0;
        const lost = r.attackerLosses[unit as keyof Army] ?? 0;
        expect(survived + lost).toBe(n);
      }
      for (const [unit, n] of Object.entries(d)) {
        const survived = r.defenderSurvivors[unit as keyof Army] ?? 0;
        const lost = r.defenderLosses[unit as keyof Army] ?? 0;
        expect(survived + lost).toBe(n);
      }
    }
  });

  it("完全確定性：同樣的輸入跑兩次結果相同", () => {
    const input = [
      { army: { SWORDSMAN: 523, LANCER: 88 } satisfies Army, attackTech: 0.12 },
      { army: { ARCHER: 401, SPEARMAN: 233 } satisfies Army, wallLevel: 6 },
      ATTACK,
    ] as const;
    expect(resolveBattle(...input)).toEqual(resolveBattle(...input));
  });

  it("空軍隊不會讓公式爆炸", () => {
    const r = resolveBattle({ army: {} }, { army: { ARCHER: 10 } }, ATTACK);
    expect(r.outcome).toBe("DEFENDER_WIN");
    expect(Number.isFinite(r.breakdown.attackerFinalPower)).toBe(true);
  });
});

describe("廢土營地（PvE）", () => {
  const campGarrison = (level: number) => {
    const pop = CAMPS.garrison.base * CAMPS.garrison.growth ** (level - 1);
    const archerShare = Math.min(CAMPS.archerShareMax, CAMPS.archerSharePerLevel * level);
    return {
      MILITIA: Math.round((pop * (1 - archerShare)) / UNIT.MILITIA.population),
      ARCHER: Math.round((pop * archerShare) / UNIT.ARCHER.population),
    };
  };
  const campReward = (level: number) =>
    CAMPS.reward.base * CAMPS.reward.growth ** (level - 1);

  it("★ PvE 不套用士氣 —— 反霸凌機制只該作用在玩家之間", () => {
    const attacker = { army: { SWORDSMAN: 200 } };
    const defender = { army: campGarrison(1), innateDefense: CAMPS.innateDefensePerLevel };

    const withMorale = resolveBattle(attacker, defender, { marchType: "ATTACK" });
    const pve = resolveBattle(attacker, defender, { marchType: "ATTACK", skipMorale: true });

    // 200 打 25 的士氣係數約 0.53，會讓清營地變成穩賠
    expect(withMorale.breakdown.morale).toBeLessThan(0.6);
    expect(pve.breakdown.morale).toBe(1);
    expect(armyPopulation(pve.attackerLosses)).toBeLessThan(
      armyPopulation(withMorale.attackerLosses),
    );
  });

  it("★ 新手用民兵就清得動 Lv1 營地，而且划算", () => {
    // 民兵每人口 80 資源，Lv1 獎勵四種合計 8,000
    const result = resolveBattle(
      { army: { MILITIA: 120 } },
      { army: campGarrison(1), innateDefense: CAMPS.innateDefensePerLevel },
      { marchType: "ATTACK", skipMorale: true },
    );
    expect(result.outcome).toBe("ATTACKER_WIN");

    const lost = armyPopulation(result.attackerLosses);
    const militiaCost =
      UNIT.MILITIA.cost.grain + UNIT.MILITIA.cost.timber + UNIT.MILITIA.cost.iron;
    expect(campReward(1) * 4).toBeGreaterThan(lost * militiaCost * 1.5);
  });

  it("獎勵成長慢於守軍成長 —— 高階營地不會變成後期提款機", () => {
    const ratio = (L: number) =>
      (campReward(L) * 4) / (CAMPS.garrison.base * CAMPS.garrison.growth ** (L - 1));
    expect(ratio(1)).toBeGreaterThan(ratio(10));
    expect(CAMPS.reward.growth).toBeLessThan(CAMPS.garrison.growth);
  });

  it("低階營地的弓手比例必須夠低 —— 弓手防禦 62 是民兵的 5 倍", () => {
    expect(UNIT.ARCHER.defInfantry / UNIT.MILITIA.defInfantry).toBeGreaterThan(4);
    const share = (L: number) => Math.min(CAMPS.archerShareMax, CAMPS.archerSharePerLevel * L);
    expect(share(1)).toBeLessThanOrEqual(0.05);
    expect(share(10)).toBe(CAMPS.archerShareMax);
  });
});
