import { describe, expect, it } from "vitest";

/**
 * M2 的驗收條件（`docs/10` M2）。
 *
 * ★ 這些測試**不碰資料庫**。驗收講的是「數字對不對」，
 *   而數字全部由 `/lib/game` 的純函式決定 —— 資料庫只是把它們存起來。
 *   把驗收綁在純函式上，就不需要為了跑測試而準備一個 Postgres。
 *
 * 資料庫那一層（`lib/server/player-state.ts`、`app/actions/base.ts`）
 * 的正確性**沒有**被這些測試涵蓋，見 `docs/11` §16。
 */

import { SEASON_MODIFIERS, type Season } from "./balance";
import {
  checkBuild,
  planCoreBuild,
  planFacility,
  type BuildState,
} from "./build";
import { deriveRates, outpostUpkeep, type TileWithFacility } from "./economy-state";
import { citadelUpgradeSeconds, facilitySeconds, territoryQueues } from "./formulas";
import { settlePlayer, zeroAmounts, type PlayerEconomy } from "./settle";
import { claimCost, claimSeconds } from "./territory";

const T0 = Date.UTC(2026, 7, 10);
const HOUR = 3_600_000;

const modifiersOf = (s: Season) => ({
  production: SEASON_MODIFIERS[s].production,
  upkeep: SEASON_MODIFIERS[s].upkeep,
});

/** 一位剛開局的玩家：主堡 Lv1、核心 2×2、起始資源 */
function newPlayer() {
  const tiles: TileWithFacility[] = [];
  const build: BuildState = {
    citadel: 1,
    slots: { B: { building: null, level: 0 }, C: { building: null, level: 0 }, D: { building: null, level: 0 } },
    coreQueue: null,
    territoryQueue: [],
    lastDemolishAt: null,
  };
  return { tiles, build };
}

function economyFor(citadel: number, tiles: TileWithFacility[], resources = 500): PlayerEconomy {
  const derived = deriveRates({ citadel, depotLevel: 0, tiles });
  return {
    resources: { grain: resources, timber: resources, stone: resources, iron: resources },
    baseRates: derived.baseRates,
    baseUpkeep: outpostUpkeep(derived.outpostLevels),
    capacity: derived.capacity,
    population: { amount: 0, rate: derived.populationRate, cap: derived.populationCap, used: 0 },
    settledAt: T0,
  };
}

describe("★ M2 驗收：關掉分頁一小時，資源正確累積", () => {
  it("離線一小時拿到的量 = 速率 × 1 小時 × 季節係數", () => {
    const tiles: TileWithFacility[] = [
      { x: 1, y: 0, state: "NORMAL", facility: "FARM", facilityLevel: 3, terrain: "PLAIN" },
    ];
    const e = economyFor(5, tiles, 0);
    const r = settlePlayer(e, [], T0 + HOUR, { seasonStartedAt: T0, modifiersOf, apply: (x) => x });

    const expected = e.baseRates.grain * SEASON_MODIFIERS.SPRING.production;
    expect(r.economy.resources.grain).toBeCloseTo(expected, 6);
    // 數字要跟 docs/11 對得上：主堡保底 5×5×4=100，加上 Lv3 農田
    expect(e.baseRates.grain).toBeGreaterThan(100);
  });

  it("離線八小時與連續八次一小時，結果相同", () => {
    const e = economyFor(5, [], 0);
    const ctx = { seasonStartedAt: T0, modifiersOf, apply: (x: PlayerEconomy) => x };

    const once = settlePlayer(e, [], T0 + 8 * HOUR, ctx);
    let step = e;
    for (let i = 1; i <= 8; i++) step = settlePlayer(step, [], T0 + i * HOUR, ctx).economy;

    for (const k of ["grain", "timber", "stone", "iron"] as const) {
      expect(step.resources[k]).toBeCloseTo(once.economy.resources[k], 6);
    }
  });
});

describe("★ M2 驗收：新玩家能發育到主堡 Lv10 + 30 塊領土", () => {
  /**
   * 用純函式跑一次「只升主堡與拓荒」的最短路徑，看時間與資源夠不夠。
   * 這不是完整的賽季模擬（那是 `scripts/simulate-season.ts` 的工作），
   * 只驗「M2 的規則本身不會把玩家鎖死」。
   */
  it("升到 Lv10 的核心佇列總時間在 12 天的賽季內綽綽有餘", () => {
    let seconds = 0;
    for (let level = 2; level <= 10; level++) seconds += citadelUpgradeSeconds(level);
    const hours = seconds / 3600;
    expect(hours).toBeLessThan(6);
  });

  it("30 塊領土的拓荒總時間，以 Lv10 的兩條佇列跑得完", () => {
    let seconds = 0;
    for (let n = 0; n < 30; n++) seconds += claimSeconds(n, "PLAIN");
    const queues = territoryQueues(10);
    expect(queues).toBe(2);
    const hours = seconds / queues / 3600;
    expect(hours).toBeLessThan(12);
  });

  it("拓荒到第 30 塊的成本仍在 Lv10 的儲存上限之內", () => {
    const cost = claimCost(29);
    const derived = deriveRates({ citadel: 10, depotLevel: 0, tiles: [] });
    expect(cost.grain).toBeLessThan(derived.capacity);
    expect(cost.timber).toBeLessThan(derived.capacity);
  });

  it("★ 主堡 Lv10 的每一級升級都存得下 —— 沒有『永遠買不起』的死鎖", () => {
    for (let level = 2; level <= 10; level++) {
      const plan = planCoreBuild(
        { ...newPlayer().build, citadel: level - 1 },
        "CITADEL",
        T0,
      );
      expect("cost" in plan).toBe(true);
      if (!("cost" in plan)) continue;
      const derived = deriveRates({ citadel: level - 1, depotLevel: 0, tiles: [] });
      const check = checkBuild(
        { ...newPlayer().build, citadel: level - 1 },
        { grain: 1e9, timber: 1e9, stone: 1e9, iron: 1e9 },
        derived.capacity,
        plan,
      );
      expect(check.ok ? null : check.reason).not.toBe("EXCEEDS_CAPACITY");
    }
  });

  it("領土容量在 Lv10 時容得下 30 塊", () => {
    expect(deriveRates({ citadel: 10, depotLevel: 0, tiles: [] }).territoryCapacity).toBe(40);
  });
});

describe("★ M2 驗收：三條路線在第 7 天長成三種明顯不同的狀態", () => {
  /**
   * `docs/03` §7.3 的取捨檢驗。三位玩家從同一起點出發，
   * 把同一份「核心佇列時間」花在不同地方，第 7 天該長得完全不一樣。
   */
  const tilesWith = (count: number, level: number): TileWithFacility[] =>
    Array.from({ length: count }, (_, i) => ({
      x: i,
      y: 0,
      state: "NORMAL" as const,
      facility: "FARM" as const,
      facilityLevel: level,
      terrain: "PLAIN" as const,
    }));

  it("衝主堡：上限高但產出低", () => {
    const tall = deriveRates({ citadel: 18, depotLevel: 0, tiles: tilesWith(6, 3) });
    const wide = deriveRates({ citadel: 10, depotLevel: 0, tiles: tilesWith(30, 5) });

    // 衝主堡的人：人口上限與領土容量都遠高於鋪設施的人
    expect(tall.populationCap).toBeGreaterThan(wide.populationCap * 1.6);
    expect(tall.territoryCapacity).toBeGreaterThan(wide.territoryCapacity * 1.6);
    // 但**現在**的產出比較低
    expect(tall.baseRates.grain).toBeLessThan(wide.baseRates.grain);
  });

  it("鋪設施：現在最有錢，但天花板早早撞死", () => {
    const wide = deriveRates({ citadel: 10, depotLevel: 0, tiles: tilesWith(30, 5) });
    // 30 塊領土已經逼近 Lv10 的 40 塊容量
    expect(wide.territoryCapacity - 30).toBeLessThan(15);
  });

  it("三種路線的產出差距足以一眼看出（> 2 倍）", () => {
    const tall = deriveRates({ citadel: 18, depotLevel: 0, tiles: tilesWith(6, 3) });
    const wide = deriveRates({ citadel: 10, depotLevel: 0, tiles: tilesWith(30, 5) });
    expect(wide.baseRates.grain / tall.baseRates.grain).toBeGreaterThan(2);
  });
});

describe("M2 驗收：數字與 docs/11 一致", () => {
  it("主堡保底產出 = 5 × 等級 × TIME_SCALE", () => {
    const derived = deriveRates({ citadel: 10, depotLevel: 0, tiles: [] });
    // 5 × 10 × 4 = 200，四種資源各一份
    expect(derived.baseRates.grain).toBe(200);
    expect(derived.baseRates.iron).toBe(200);
  });

  it("儲存上限 = (2000 + 150×主堡) × (1 + 0.4×倉庫) + 5000×前哨營", () => {
    expect(deriveRates({ citadel: 10, depotLevel: 0, tiles: [] }).capacity).toBe(3500);
    expect(deriveRates({ citadel: 10, depotLevel: 5, tiles: [] }).capacity).toBe(10_500);
  });

  it("孤立領土產出減半，而且不貢獻人口成長", () => {
    const normal = deriveRates({
      citadel: 10,
      depotLevel: 0,
      tiles: [{ x: 0, y: 0, state: "NORMAL", facility: "FARM", facilityLevel: 5, terrain: "PLAIN" }],
    });
    const isolated = deriveRates({
      citadel: 10,
      depotLevel: 0,
      tiles: [
        { x: 0, y: 0, state: "ISOLATED", facility: "FARM", facilityLevel: 5, terrain: "PLAIN" },
      ],
    });

    const normalFarm = normal.baseRates.grain - 200;
    const isolatedFarm = isolated.baseRates.grain - 200;
    expect(isolatedFarm).toBeCloseTo(normalFarm / 2, 6);
    expect(isolated.populationRate).toBeLessThan(normal.populationRate);
  });

  it("前哨營吃糧食維護費", () => {
    expect(outpostUpkeep(0).grain).toBe(0);
    expect(outpostUpkeep(3).grain).toBeGreaterThan(0);
  });

  it("設施建造時間隨等級指數上升，但 Lv1 很快", () => {
    expect(facilitySeconds(1)).toBeLessThan(120);
    expect(facilitySeconds(10)).toBeGreaterThan(facilitySeconds(1) * 10);
  });

  it("領土佇列滿了就不能再開新的設施", () => {
    const s: BuildState = {
      ...newPlayer().build,
      citadel: 10,
      territoryQueue: [{ doneAt: T0 + HOUR }, { doneAt: T0 + HOUR }],
    };
    expect(planFacility(s, "FARM", 0, T0)).toEqual({ reason: "NO_FREE_QUEUE" });
  });

  it("零狀態不會產生 NaN", () => {
    const derived = deriveRates({ citadel: 1, depotLevel: 0, tiles: [] });
    for (const v of Object.values(derived.baseRates)) expect(Number.isFinite(v)).toBe(true);
    expect(Number.isFinite(derived.populationRate)).toBe(true);
    expect(zeroAmounts()).toEqual({ grain: 0, timber: 0, stone: 0, iron: 0 });
  });
});
