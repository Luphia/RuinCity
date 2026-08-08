import { describe, expect, it } from "vitest";

import { MARCH, SEASON_MODIFIERS } from "./balance";
import {
  DISPATCHABLE,
  innateDefenseOf,
  planDispatch,
  planReturn,
  RAID_LOSS_MULTIPLIER,
  reviveSpared,
  scaleLosses,
  scoutReport,
  scoutSuccessChance,
  tileInnateDefense,
  watchtowerDefenseOf,
  type DispatchState,
} from "./dispatch";
import type { Army } from "./army";

const T0 = Date.UTC(2026, 7, 10);

function state(over: Partial<DispatchState> = {}): DispatchState {
  return {
    from: { x: 100, y: 100 },
    garrison: { SPEARMAN: 100, SWORDSMAN: 50, SCOUT: 10, RAIDER: 20 },
    ...over,
  };
}

describe("★ 出擊規模 ≤ 出發地駐軍量", () => {
  it("派得出去就從駐軍扣掉", () => {
    const p = planDispatch(state(), "RAID", { x: 105, y: 100 }, { SPEARMAN: 40 }, T0);
    expect("reason" in p).toBe(false);
    if ("reason" in p) return;
    expect(p.remainingGarrison.SPEARMAN).toBe(60);
    expect(p.remainingGarrison.SWORDSMAN).toBe(50);
  });

  it("★ 兵不夠就派不出去 —— 否則同一支軍隊能被派十次", () => {
    const p = planDispatch(state(), "RAID", { x: 105, y: 100 }, { SPEARMAN: 500 }, T0);
    expect(p).toEqual({ reason: "NOT_IN_GARRISON" });
  });

  it("沒有的兵種也派不出去", () => {
    const p = planDispatch(state(), "ATTACK", { x: 105, y: 100 }, { CATAPULT: 1 }, T0);
    expect(p).toEqual({ reason: "NOT_IN_GARRISON" });
  });

  it("空軍隊", () => {
    expect(planDispatch(state(), "RAID", { x: 105, y: 100 }, {}, T0)).toEqual({
      reason: "EMPTY_ARMY",
    });
  });

  it("不能派去自己站的那一格", () => {
    expect(planDispatch(state(), "RAID", { x: 100, y: 100 }, { SPEARMAN: 1 }, T0)).toEqual({
      reason: "SAME_TILE",
    });
  });
});

describe("行軍類型", () => {
  it("玩家能主動發起六種（含征服 CLAIM）；RETURN 自動產生", () => {
    expect(DISPATCHABLE).toEqual(["RAID", "ATTACK", "SCOUT", "CLAIM", "REINFORCE", "GARRISON"]);
    // 征服是可派遣的行軍（docs/02 §2.5）—— 目標與容量的驗證在 server 層
    expect("reason" in planDispatch(state(), "CLAIM", { x: 101, y: 100 }, { SPEARMAN: 1 }, T0)).toBe(
      false,
    );
    expect(planDispatch(state(), "RETURN", { x: 101, y: 100 }, { SPEARMAN: 1 }, T0)).toEqual({
      reason: "UNKNOWN_TYPE",
    });
  });

  it("★ 偵查只能派偵查兵", () => {
    expect(
      planDispatch(state(), "SCOUT", { x: 105, y: 100 }, { SCOUT: 5, SPEARMAN: 1 }, T0),
    ).toEqual({ reason: "SCOUT_ONLY" });

    const ok = planDispatch(state(), "SCOUT", { x: 105, y: 100 }, { SCOUT: 5 }, T0);
    expect("reason" in ok).toBe(false);
  });
});

describe("★ 8 小時上限是地圖設計約束", () => {
  it("太遠就派不出去", () => {
    // 據點在 (100,100)；跨到地圖另一角是 ~1,000 格，長矛兵怎麼跑都超過 8 小時
    const p = planDispatch(state(), "ATTACK", { x: 860, y: 860 }, { SPEARMAN: 10 }, T0);
    expect(p).toEqual({ reason: "TOO_FAR" });
  });

  it("近的可以，而且抵達時間 = now + 行軍秒數", () => {
    const p = planDispatch(state(), "RAID", { x: 110, y: 100 }, { SPEARMAN: 10 }, T0);
    if ("reason" in p) throw new Error(p.reason);
    expect(p.arrivesAt).toBe(T0 + Math.round(p.time.seconds * 1000));
    expect(p.time.seconds).toBeGreaterThanOrEqual(MARCH.minSeconds);
  });

  it("★ 部隊的速度取決於最慢的單位 —— 帶投石機就跑不動", () => {
    const withSiege = planDispatch(
      state({ garrison: { RAIDER: 10, CATAPULT: 1 } }),
      "ATTACK",
      { x: 130, y: 100 },
      { RAIDER: 10, CATAPULT: 1 },
      T0,
    );
    const cavalryOnly = planDispatch(
      state({ garrison: { RAIDER: 10 } }),
      "ATTACK",
      { x: 130, y: 100 },
      { RAIDER: 10 },
      T0,
    );
    if ("reason" in withSiege || "reason" in cavalryOnly) throw new Error("planDispatch failed");
    expect(withSiege.time.seconds).toBeGreaterThan(cavalryOnly.time.seconds * 2);
  });

  it("冬季行軍更慢", () => {
    const normal = planDispatch(state(), "RAID", { x: 120, y: 100 }, { SPEARMAN: 10 }, T0);
    const winter = planDispatch(
      state({ season: SEASON_MODIFIERS.WINTER }),
      "RAID",
      { x: 120, y: 100 },
      { SPEARMAN: 10 },
      T0,
    );
    if ("reason" in normal || "reason" in winter) throw new Error("planDispatch failed");
    expect(winter.time.seconds).toBeGreaterThan(normal.time.seconds);
  });
});

describe("★ 回程用實際回去的那支部隊重算", () => {
  it("只剩騎兵時回得比較快", () => {
    const mixed = planReturn(
      { SPEARMAN: 10, RAIDER: 10 },
      { x: 120, y: 100 },
      { x: 100, y: 100 },
      T0,
    );
    const cavalry = planReturn({ RAIDER: 10 }, { x: 120, y: 100 }, { x: 100, y: 100 }, T0);
    expect(mixed!.seconds).toBeGreaterThan(cavalry!.seconds);
  });

  it("全滅就沒有回程", () => {
    expect(planReturn({}, { x: 120, y: 100 }, { x: 100, y: 100 }, T0)).toBeNull();
  });

  it("回程也受 8 小時上限夾住 —— 不會有回不了家的部隊", () => {
    const r = planReturn({ CATAPULT: 1 }, { x: 0, y: 0 }, { x: 400, y: 400 }, T0);
    expect(r!.seconds).toBeLessThanOrEqual(MARCH.maxSeconds);
  });
});

describe("偵查", () => {
  it("守方沒有偵查兵就一定成功", () => {
    expect(scoutSuccessChance(1, 0)).toBe(1);
  });

  it("人多的一方佔優", () => {
    expect(scoutSuccessChance(10, 5)).toBeGreaterThan(0.5);
    expect(scoutSuccessChance(5, 10)).toBeLessThan(0.5);
  });

  it("哨塔提高門檻但擋不死", () => {
    const bare = scoutSuccessChance(10, 5, 0);
    const tower = scoutSuccessChance(10, 5, 10);
    expect(tower).toBeLessThan(bare);
    expect(tower).toBeGreaterThan(0);
  });

  it("一隻都不派就是 0", () => {
    expect(scoutSuccessChance(0, 5)).toBe(0);
  });

  it("失敗時什麼都看不到", () => {
    const r = scoutReport(false, truth(), () => 0.5);
    expect(r).toEqual({
      success: false,
      army: null,
      resources: null,
      citadelLevel: null,
      wallLevel: null,
    });
  });

  it("★ 成功時有誤差，但誤差是確定性的 —— 會變動的情報等於沒有情報", () => {
    const noise = (k: string) => (k.length % 7) / 7;
    const a = scoutReport(true, truth(), noise);
    const b = scoutReport(true, truth(), noise);
    expect(a).toEqual(b);
  });

  it("兵力誤差 ±10%、資源誤差 ±15%", () => {
    const maxNoise = scoutReport(true, truth(), () => 1);
    const minNoise = scoutReport(true, truth(), () => 0);
    expect(maxNoise.army!.SPEARMAN).toBe(110);
    expect(minNoise.army!.SPEARMAN).toBe(90);
    expect(maxNoise.resources!.grain).toBe(1150);
    expect(minNoise.resources!.grain).toBe(850);
  });

  it("建築等級是精確的 —— 那是看得見的東西", () => {
    const r = scoutReport(true, truth(), () => 0.5);
    expect(r.citadelLevel).toBe(12);
    expect(r.wallLevel).toBe(3);
  });
});

function truth() {
  return {
    army: { SPEARMAN: 100 } as Army,
    resources: { grain: 1000, timber: 1000, stone: 1000, iron: 1000 },
    citadelLevel: 12,
    wallLevel: 3,
  };
}

describe("固有防禦", () => {
  it("據點 = 主堡等級 × 120", () => {
    expect(innateDefenseOf(5)).toBe(600);
    expect(innateDefenseOf(20)).toBe(2400);
  });

  it("聯盟主旗 ×2", () => {
    expect(innateDefenseOf(20, true)).toBe(4800);
  });

  it("領土格 = 設施等級 × 30；哨塔 = 200 × 等級", () => {
    expect(tileInnateDefense(5)).toBe(150);
    expect(watchtowerDefenseOf(3)).toBe(600);
  });
});

describe("★ 突襲：只交戰一輪，雙方損失 ×0.6", () => {
  it("損失被折到 0.6", () => {
    expect(RAID_LOSS_MULTIPLIER).toBe(0.6);
    expect(scaleLosses({ SPEARMAN: 100 }, RAID_LOSS_MULTIPLIER)).toEqual({ SPEARMAN: 60 });
  });

  it("折完之後歸零的兵種會被移掉", () => {
    expect(scaleLosses({ SPEARMAN: 1 }, 0.6)).toEqual({});
  });

  it("沒死成的人要加回存活者", () => {
    const original: Army = { SPEARMAN: 100 };
    const fullLosses: Army = { SPEARMAN: 50 };
    const raidLosses = scaleLosses(fullLosses, RAID_LOSS_MULTIPLIER);
    const survivors = reviveSpared({ SPEARMAN: 50 }, original, raidLosses);
    expect(survivors.SPEARMAN).toBe(100 - 30);
  });

  it("全滅時存活者是空的", () => {
    expect(reviveSpared({}, { SPEARMAN: 10 }, { SPEARMAN: 10 })).toEqual({});
  });
});
