import { describe, expect, it } from "vitest";

import { RAIDING, UNIT } from "./balance";
import { vaultProtection } from "./formulas";
import { zeroAmounts, type Amounts } from "./settle";
import {
  applyCarryLimit,
  armyUpkeep,
  carryOf,
  diminishingFactor,
  isEmptyArmy,
  lootableOf,
  mergeArmies,
  msUntilStarvation,
  parseAmounts,
  parseArmy,
  starve,
  STARVATION_RATE,
  STARVATION_TICK_MS,
  subtractArmy,
  woundedRecoveryCost,
  type Army,
} from "./army";

const HOUR = 3_600_000;

describe("★ 餓死：你不能把軍隊留著不用", () => {
  it("沒挨餓就一個都不死", () => {
    const r = starve({ SPEARMAN: 100 }, 0);
    expect(r.lost).toEqual({});
    expect(r.survivors).toEqual({ SPEARMAN: 100 });
  });

  it("每 10 分鐘死 3%", () => {
    const r = starve({ SPEARMAN: 1000 }, STARVATION_TICK_MS);
    expect(r.ticks).toBe(1);
    expect(r.lost.SPEARMAN).toBe(Math.floor(1000 * STARVATION_RATE));
  });

  it("不滿 10 分鐘不算一次", () => {
    expect(starve({ SPEARMAN: 1000 }, STARVATION_TICK_MS - 1).ticks).toBe(0);
  });

  it("★ 優先餓死糧耗最高的 —— 先失去騎兵，不是民兵", () => {
    // 掠奪騎兵糧耗 3、長矛兵 1
    expect(UNIT.RAIDER.upkeep).toBeGreaterThan(UNIT.SPEARMAN.upkeep);
    const r = starve({ SPEARMAN: 100, RAIDER: 100 }, STARVATION_TICK_MS);
    expect(r.lost.RAIDER).toBeGreaterThan(0);
    expect(r.lost.SPEARMAN ?? 0).toBe(0);
  });

  it("★ 確定性 —— 同一個輸入結算兩次結果一樣", () => {
    const a = starve({ SPEARMAN: 137, RAIDER: 41 }, 5 * STARVATION_TICK_MS);
    const b = starve({ SPEARMAN: 137, RAIDER: 41 }, 5 * STARVATION_TICK_MS);
    expect(a).toEqual(b);
  });

  it("★ 小部隊也餓得死 —— 3% 不足一人時至少死一個", () => {
    const r = starve({ SPEARMAN: 5 }, STARVATION_TICK_MS);
    expect(r.lost.SPEARMAN).toBe(1);
  });

  it("餓到全滅就停手，不會變成負數", () => {
    const r = starve({ SPEARMAN: 3 }, 100 * STARVATION_TICK_MS);
    expect(r.survivors).toEqual({});
    expect(r.lost.SPEARMAN).toBe(3);
  });

  it("挨餓越久死越多", () => {
    const short = starve({ SPEARMAN: 1000 }, 3 * STARVATION_TICK_MS);
    const long = starve({ SPEARMAN: 1000 }, 12 * STARVATION_TICK_MS);
    expect(long.lost.SPEARMAN!).toBeGreaterThan(short.lost.SPEARMAN!);
  });

  it("提前六小時就算得出來", () => {
    // 1,200 糧、每小時淨 −200 → 6 小時後見底
    expect(msUntilStarvation(1200, -200)).toBeCloseTo(6 * HOUR, 6);
    expect(msUntilStarvation(1200, 0)).toBe(Infinity);
    expect(msUntilStarvation(1200, 50)).toBe(Infinity);
  });
});

describe("糧耗", () => {
  it("駐軍與行軍中的部隊一起算", () => {
    const home: Army = { SPEARMAN: 100 };
    const marching: Army = { RAIDER: 20 };
    const both = armyUpkeep([home, marching]);
    expect(both.grain).toBeCloseTo(
      armyUpkeep([home]).grain + armyUpkeep([marching]).grain,
      6,
    );
  });

  it("★ 行軍中的部隊照吃糧 —— 否則派出去繞圈就是免費的倉庫", () => {
    expect(armyUpkeep([{ SPEARMAN: 50 }]).grain).toBeGreaterThan(0);
  });

  it("只吃糧食，不吃木石鐵", () => {
    const up = armyUpkeep([{ SPEARMAN: 100 }]);
    expect(up.timber).toBe(0);
    expect(up.stone).toBe(0);
    expect(up.iron).toBe(0);
  });
});

describe("★ 掠奪：地窖與載重", () => {
  const resources = (n: number): Amounts => ({ grain: n, timber: n, stone: n, iron: n });

  it("庫存低於地窖保護量就搶不到東西", () => {
    const vault = vaultProtection(1, 0, { vault: 2 });
    const loot = lootableOf(resources(vault - 1), 1, 0, 2);
    expect(loot.grain).toBe(0);
  });

  it("★ 第 1 天的新手被攻擊，資源損失為 0（春季地窖 ×2）", () => {
    // docs/16 §4.1 的例子：庫存 600、Lv1 主堡、無倉庫、春季
    const loot = lootableOf(resources(600), 1, 0, 2);
    expect(loot.grain).toBe(0);
    // 非春季就搶得到了
    expect(lootableOf(resources(600), 1, 0, 1).grain).toBeGreaterThan(0);
  });

  it("超過地窖的部分才搶得走", () => {
    const vault = vaultProtection(10, 0, { vault: 1 });
    const loot = lootableOf(resources(vault + 500), 10, 0, 1);
    expect(loot.grain).toBe(500);
  });

  it("★ 載重不夠時各資源按比例分攤 —— 不會只搶一種", () => {
    const loot = applyCarryLimit({ grain: 800, timber: 200 }, 500);
    expect(loot.grain! + loot.timber!).toBeLessThanOrEqual(500);
    // 800 : 200 的比例應該保留下來
    expect(loot.grain! / loot.timber!).toBeCloseTo(4, 0);
  });

  it("載重夠就全拿", () => {
    expect(applyCarryLimit({ grain: 100, timber: 50 }, 1000)).toEqual({
      grain: 100,
      timber: 50,
    });
  });

  it("掠奪騎兵的載重是劍士的近三倍", () => {
    expect(carryOf({ RAIDER: 1 })).toBeGreaterThan(carryOf({ SWORDSMAN: 1 }) * 2.5);
  });

  it("★ 重複劫掠遞減：100% / 60% / 36% / 21.6%", () => {
    expect(diminishingFactor(0)).toBeCloseTo(1, 6);
    expect(diminishingFactor(1)).toBeCloseTo(0.6, 6);
    expect(diminishingFactor(2)).toBeCloseTo(0.36, 6);
    expect(diminishingFactor(3)).toBeCloseTo(0.216, 6);
  });

  it("遞減視窗是 6 小時", () => {
    expect(RAIDING.diminishing.windowMs).toBe(6 * HOUR);
  });
});

describe("傷兵", () => {
  it("復原要花糧食 30% 的招募成本", () => {
    const cost = woundedRecoveryCost({ SPEARMAN: 10 });
    expect(cost.grain).toBeCloseTo(UNIT.SPEARMAN.cost.grain * 0.3 * 10, 6);
    // 只吃糧食
    expect(cost.timber).toBe(0);
  });

  it("沒有傷兵就不用花錢", () => {
    expect(woundedRecoveryCost({})).toEqual(zeroAmounts());
  });
});

describe("部隊運算", () => {
  it("合併", () => {
    expect(mergeArmies({ SPEARMAN: 10 }, { SPEARMAN: 5, RAIDER: 2 })).toEqual({
      SPEARMAN: 15,
      RAIDER: 2,
    });
  });

  it("扣減；歸零的兵種會被移掉", () => {
    expect(subtractArmy({ SPEARMAN: 10, RAIDER: 2 }, { SPEARMAN: 10 })).toEqual({ RAIDER: 2 });
  });

  it("★ 兵不夠時回 null，不是回一支負數的部隊", () => {
    expect(subtractArmy({ SPEARMAN: 5 }, { SPEARMAN: 10 })).toBeNull();
    expect(subtractArmy({}, { SPEARMAN: 1 })).toBeNull();
  });

  it("空軍隊判定", () => {
    expect(isEmptyArmy({})).toBe(true);
    expect(isEmptyArmy({ SPEARMAN: 0 })).toBe(true);
    expect(isEmptyArmy({ SPEARMAN: 1 })).toBe(false);
  });
});

describe("從不可信的 jsonb 讀資料", () => {
  it("認不出來的兵種被丟掉", () => {
    expect(parseArmy({ SPEARMAN: 10, "🐟": 999, RAIDER: "x" })).toEqual({ SPEARMAN: 10 });
  });

  it("負數與零被丟掉", () => {
    expect(parseArmy({ SPEARMAN: -5, RAIDER: 0 })).toEqual({});
  });

  it("null 不會炸", () => {
    expect(parseArmy(null)).toEqual({});
    expect(parseAmounts(undefined)).toEqual(zeroAmounts());
  });

  it("資源只讀四種", () => {
    expect(parseAmounts({ grain: 10, relic: 99, nope: 1 })).toEqual({
      ...zeroAmounts(),
      grain: 10,
    });
  });
});
