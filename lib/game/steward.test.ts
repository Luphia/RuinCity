import { describe, expect, it } from "vitest";

import { STEWARD } from "./balance";
import { facilityCost, stewardDirectiveSlots } from "./formulas";
import { zeroAmounts, type Amounts } from "./settle";
import {
  activeDirectives,
  clampPause,
  decideStewardActions,
  defaultDirectives,
  directivesOverLimit,
  isFullProxy,
  parseDirectives,
  spendable,
  stewardName,
  type Directives,
  type StewardCandidate,
  type StewardFacilityOption,
  type StewardInput,
} from "./steward";
import { claimCost } from "./territory";

const T0 = Date.UTC(2026, 7, 10);
const HOUR = 3_600_000;

const rich = (n = 100_000): Amounts => ({ grain: n, timber: n, stone: n, iron: n });

function directives(over: Partial<Directives> = {}): Directives {
  return { ...defaultDirectives(), ...over };
}

function candidate(x: number, y: number, over: Partial<StewardCandidate> = {}): StewardCandidate {
  return {
    x,
    y,
    terrain: "PLAIN",
    distanceToBase: Math.abs(x) + Math.abs(y),
    distanceToRuin: 999,
    hostileNeighbours: 0,
    ...over,
  };
}

function option(
  x: number,
  y: number,
  over: Partial<StewardFacilityOption> = {},
): StewardFacilityOption {
  return { x, y, terrain: "PLAIN", facility: null, level: 0, ...over };
}

function input(over: Partial<StewardInput> = {}): StewardInput {
  return {
    now: T0,
    citadelLevel: 20,
    directives: defaultDirectives(),
    resources: rich(),
    capacity: 200_000,
    netPerHour: zeroAmounts(),
    population: { amount: 100, cap: 500, used: 50 },
    territoryQueuesFree: 1,
    barracksQueuesFree: 0,
    ownedCount: 5,
    territoryCapacity: 80,
    candidates: [],
    facilityOptions: [],
    ...over,
  };
}

describe("★ 鐵則：執政官碰不到核心佇列、軍事、拆除、交易", () => {
  it("回傳型別裡就沒有那些動作 —— 不是靠檢查擋下來的", () => {
    // 開全部方針、資源無限、所有佇列都閒著
    const d = decideStewardActions(
      input({
        directives: directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
          development: {
            enabled: true,
            priority: ["FARM"],
            reserve: zeroAmounts(),
          },
          levy: { enabled: true, mix: { MILITIA: 1 }, populationReserve: 0, reserve: zeroAmounts() },
        }),
        territoryQueuesFree: 4,
        barracksQueuesFree: 2,
        candidates: [candidate(1, 0)],
        facilityOptions: [option(2, 0)],
      }),
    );
    for (const a of d.actions) {
      expect(["CLAIM", "BUILD", "LEVY"]).toContain(a.kind);
    }
  });

  it("數值表也把禁區列出來了（docs/18 §2）", () => {
    expect(STEWARD.forbidden).toContain("CORE_QUEUE");
    expect(STEWARD.forbidden).toContain("MILITARY_MARCH");
    expect(STEWARD.forbidden).toContain("DEMOLISH");
    expect(STEWARD.forbidden).toContain("MARKET_TRADE");
  });
});

describe("★ 只在佇列閒置時行動 —— 衝突根本不會發生", () => {
  const active = directives({
    expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
  });

  it("佇列滿了就一個動作都不做", () => {
    const d = decideStewardActions(
      input({ directives: active, territoryQueuesFree: 0, candidates: [candidate(1, 0)] }),
    );
    expect(d.actions).toHaveLength(0);
    expect(d.blocked).toContainEqual({ directive: "EXPANSION", reason: "QUEUE_BUSY" });
  });

  it("有幾條閒置就最多做幾件事", () => {
    const d = decideStewardActions(
      input({
        directives: active,
        territoryQueuesFree: 2,
        candidates: [candidate(1, 0), candidate(2, 0), candidate(3, 0)],
      }),
    );
    expect(d.actions).toHaveLength(2);
  });
});

describe("★ 資源保留下限：讓取捨留在玩家手上", () => {
  it("只花保留下限以上的部分", () => {
    expect(spendable({ grain: 8000, timber: 8000, stone: 0, iron: 0 }, { grain: 5000, timber: 0, stone: 0, iron: 0 })).toEqual({
      grain: 3000,
      timber: 8000,
      stone: 0,
      iron: 0,
    });
  });

  it("★ 你在存木材升主堡，執政官不會拿去拓荒", () => {
    const cost = claimCost(5);
    const d = decideStewardActions(
      input({
        // 木材剛好只比保留下限多一點點，不夠拓荒
        resources: { grain: 99_999, timber: 5000 + cost.timber - 1, stone: 0, iron: 0 },
        directives: directives({
          expansion: {
            enabled: true,
            preference: "NEAREST",
            reserve: { grain: 0, timber: 5000, stone: 0, iron: 0 },
          },
        }),
        candidates: [candidate(1, 0)],
      }),
    );
    expect(d.actions).toHaveLength(0);
    expect(d.blocked[0]).toMatchObject({ directive: "EXPANSION", reason: "RESERVE" });
  });

  it("多一塊木材就拓得動了", () => {
    const cost = claimCost(5);
    const d = decideStewardActions(
      input({
        resources: { grain: 99_999, timber: 5000 + cost.timber, stone: 0, iron: 0 },
        directives: directives({
          expansion: {
            enabled: true,
            preference: "NEAREST",
            reserve: { grain: 0, timber: 5000, stone: 0, iron: 0 },
          },
        }),
        candidates: [candidate(1, 0)],
      }),
    );
    expect(d.actions).toEqual([{ kind: "CLAIM", x: 1, y: 0 }]);
  });

  it("★ 拓荒成本隨已有領土遞增，同一輪連拓時要逐格重算", () => {
    // 只夠付前兩格（第 5、6 塊）的成本
    const budget = claimCost(5).timber + claimCost(6).timber + claimCost(7).timber - 1;
    const d = decideStewardActions(
      input({
        resources: { grain: 999_999, timber: budget, stone: 0, iron: 0 },
        directives: directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
        }),
        territoryQueuesFree: 4,
        candidates: [candidate(1, 0), candidate(2, 0), candidate(3, 0), candidate(4, 0)],
      }),
    );
    expect(d.actions).toHaveLength(2);
  });
});

describe("★ 可同時啟用的方針數由主堡等級決定", () => {
  const allOn = directives({
    expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
    development: { enabled: true, priority: ["FARM"], reserve: zeroAmounts() },
    levy: { enabled: true, mix: { MILITIA: 1 }, populationReserve: 0, reserve: zeroAmounts() },
  });

  it("Lv1 只有一格、Lv8 兩格、Lv16 三格（docs/18 §4.3）", () => {
    expect(stewardDirectiveSlots(1)).toBe(1);
    expect(stewardDirectiveSlots(7)).toBe(1);
    expect(stewardDirectiveSlots(8)).toBe(2);
    expect(stewardDirectiveSlots(16)).toBe(3);
    expect(stewardDirectiveSlots(30)).toBe(3);
  });

  it("超額的方針依宣告順序取前 N 個 —— 確定性，模擬要能重放", () => {
    expect(activeDirectives(allOn, 1)).toEqual(["EXPANSION"]);
    expect(activeDirectives(allOn, 8)).toEqual(["EXPANSION", "DEVELOPMENT"]);
    expect(activeDirectives(allOn, 16)).toEqual(["EXPANSION", "DEVELOPMENT", "LEVY"]);
  });

  it("被擠掉的方針要出現在簡報裡 —— 領主要知道它沒生效", () => {
    const d = decideStewardActions(
      input({ citadelLevel: 1, directives: allOn, candidates: [candidate(1, 0)] }),
    );
    const noSlot = d.blocked.filter((b) => b.reason === "NO_SLOT");
    expect(noSlot.map((b) => b.directive)).toEqual(["DEVELOPMENT", "LEVY"]);
    expect(directivesOverLimit(allOn, 1)).toBe(2);
  });
});

describe("★ 刻意次優（docs/18 §5）", () => {
  const expansionOn = (preference: "NEAREST" | "TOWARD_RUIN" | "TOWARD_WILD") =>
    directives({ expansion: { enabled: true, preference, reserve: zeroAmounts() } });

  it("NEAREST 選最近的格，不挑高價值地形", () => {
    const d = decideStewardActions(
      input({
        directives: expansionOn("NEAREST"),
        candidates: [
          candidate(9, 0, { terrain: "LODE", distanceToBase: 9 }),
          candidate(1, 0, { terrain: "MARSH", distanceToBase: 1 }),
        ],
      }),
    );
    // 沼澤產出最差，但它最近 —— 這正是次優的地方
    expect(d.actions).toEqual([{ kind: "CLAIM", x: 1, y: 0 }]);
  });

  it("TOWARD_RUIN 選離遺跡最近的", () => {
    const d = decideStewardActions(
      input({
        directives: expansionOn("TOWARD_RUIN"),
        candidates: [
          candidate(1, 0, { distanceToRuin: 200 }),
          candidate(9, 0, { distanceToRuin: 40 }),
        ],
      }),
    );
    expect(d.actions).toEqual([{ kind: "CLAIM", x: 9, y: 0 }]);
  });

  it("TOWARD_WILD 避開有鄰居的格", () => {
    const d = decideStewardActions(
      input({
        directives: expansionOn("TOWARD_WILD"),
        candidates: [
          candidate(1, 0, { hostileNeighbours: 2, distanceToBase: 1 }),
          candidate(6, 0, { hostileNeighbours: 0, distanceToBase: 6 }),
        ],
      }),
    );
    expect(d.actions).toEqual([{ kind: "CLAIM", x: 6, y: 0 }]);
  });

  it("設施依優先序找第一個**對口**的空格 —— 不對口的蓋不下去，跳過不是次優是必要", () => {
    const d = decideStewardActions(
      input({
        directives: directives({
          development: { enabled: true, priority: ["FARM"], reserve: zeroAmounts() },
        }),
        // v2（docs/11 §22.4）：農田只能蓋在糧格。森林在清單前面但不對口 —— 跳過
        facilityOptions: [option(1, 0, { terrain: "FOREST" }), option(2, 0, { terrain: "PLAIN" })],
      }),
    );
    expect(d.actions).toEqual([{ kind: "BUILD", x: 2, y: 0, facility: "FARM", toLevel: 1 }]);
  });
});

describe("★ 先把已佔的地用起來，再去拓新的", () => {
  const both = directives({
    expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
    development: { enabled: true, priority: ["FARM"], reserve: zeroAmounts() },
  });

  it("有空地時先蓋設施", () => {
    const d = decideStewardActions(
      input({
        directives: both,
        territoryQueuesFree: 1,
        candidates: [candidate(1, 0)],
        facilityOptions: [option(2, 0)],
      }),
    );
    expect(d.actions[0]).toMatchObject({ kind: "BUILD" });
  });

  it("沒有建設機會時才拓荒", () => {
    const d = decideStewardActions(
      input({
        directives: both,
        territoryQueuesFree: 1,
        candidates: [candidate(1, 0)],
        facilityOptions: [],
      }),
    );
    expect(d.actions).toEqual([{ kind: "CLAIM", x: 1, y: 0 }]);
  });

  it("多條佇列時兩者交錯填滿", () => {
    const d = decideStewardActions(
      input({
        directives: both,
        territoryQueuesFree: 3,
        candidates: [candidate(1, 0), candidate(2, 0)],
        facilityOptions: [option(3, 0)],
      }),
    );
    // 一次建設用掉唯一的空地，剩下兩條佇列去拓荒
    expect(d.actions.filter((a) => a.kind === "BUILD")).toHaveLength(1);
    expect(d.actions.filter((a) => a.kind === "CLAIM")).toHaveLength(2);
  });

  it("同一格不會被排兩次", () => {
    const d = decideStewardActions(
      input({
        directives: both,
        territoryQueuesFree: 4,
        candidates: [candidate(1, 0)],
        facilityOptions: [option(2, 0)],
      }),
    );
    const keys = d.actions.flatMap((a) => (a.kind === "LEVY" ? [] : [`${a.x},${a.y}`]));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("領土容量與等級上限", () => {
  it("領土滿了就不再拓荒", () => {
    const d = decideStewardActions(
      input({
        directives: directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
        }),
        ownedCount: 80,
        territoryCapacity: 80,
        candidates: [candidate(1, 0)],
      }),
    );
    expect(d.actions).toHaveLength(0);
    expect(d.blocked).toContainEqual({ directive: "EXPANSION", reason: "AT_CAPACITY" });
    expect(d.warnings).toContainEqual({ kind: "TERRITORY_CAPPED" });
  });

  it("設施到頂就記 LEVEL_CAPPED，不是 NO_TARGET", () => {
    const d = decideStewardActions(
      input({
        citadelLevel: 8, // facilityLevelCap(8) = 5
        directives: directives({
          development: { enabled: true, priority: ["FARM"], reserve: zeroAmounts() },
        }),
        facilityOptions: [option(1, 0, { facility: "FARM", level: 5 })],
      }),
    );
    expect(d.blocked).toContainEqual({
      directive: "DEVELOPMENT",
      reason: "LEVEL_CAPPED",
      detail: undefined,
    });
  });

  it("升級成本用的是**下一級**的價目", () => {
    const d = decideStewardActions(
      input({
        directives: directives({
          development: { enabled: true, priority: ["FARM"], reserve: zeroAmounts() },
        }),
        facilityOptions: [option(1, 0, { facility: "FARM", level: 3 })],
        resources: { ...zeroAmounts(), timber: facilityCost("FARM", 4).timber ?? 0 },
      }),
    );
    expect(d.actions).toEqual([{ kind: "BUILD", x: 1, y: 0, facility: "FARM", toLevel: 4 }]);
  });
});

describe("領主接管", () => {
  it("暫停期間全部停手", () => {
    const d = decideStewardActions(
      input({
        directives: directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
          pausedUntil: T0 + HOUR,
        }),
        candidates: [candidate(1, 0)],
      }),
    );
    expect(d.actions).toHaveLength(0);
    expect(d.blocked.every((b) => b.reason === "PAUSED")).toBe(true);
  });

  it("暫停到期後恢復", () => {
    const d = decideStewardActions(
      input({
        now: T0 + 2 * HOUR,
        directives: directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
          pausedUntil: T0 + HOUR,
        }),
        candidates: [candidate(1, 0)],
      }),
    );
    expect(d.actions).toHaveLength(1);
  });

  it("暫停時長 clamp 在 1–24 小時", () => {
    expect(clampPause(0.1)).toBe(STEWARD.pauseMs.min);
    expect(clampPause(100)).toBe(STEWARD.pauseMs.max);
    expect(clampPause(6)).toBe(6 * HOUR);
  });

  it("連續 48 小時未登入 → 全權代理", () => {
    expect(isFullProxy(T0, T0 + 47 * HOUR)).toBe(false);
    expect(isFullProxy(T0, T0 + 48 * HOUR)).toBe(true);
    expect(isFullProxy(null, T0)).toBe(false);
  });
});

describe("★ 簡報的警告：執政官看到的事", () => {
  it("快溢出時提前四小時警告", () => {
    const d = decideStewardActions(
      input({
        resources: { grain: 9000, timber: 0, stone: 0, iron: 0 },
        capacity: 10_000,
        netPerHour: { grain: 500, timber: 0, stone: 0, iron: 0 },
      }),
    );
    const w = d.warnings.find((x) => x.kind === "OVERFLOW_SOON");
    expect(w?.resource).toBe("grain");
    expect(w?.hours).toBeCloseTo(2, 6);
  });

  it("收支為負或為零不會警告溢出", () => {
    const d = decideStewardActions(
      input({
        resources: { grain: 9999, timber: 0, stone: 0, iron: 0 },
        capacity: 10_000,
        netPerHour: { grain: -100, timber: 0, stone: 0, iron: 0 },
      }),
    );
    expect(d.warnings.some((w) => w.kind === "OVERFLOW_SOON")).toBe(false);
  });

  it("人口到頂會警告", () => {
    const d = decideStewardActions(
      input({ population: { amount: 450, cap: 500, used: 50 } }),
    );
    expect(d.warnings).toContainEqual({ kind: "POPULATION_CAPPED" });
  });
});

describe("募兵", () => {
  const levyOn = directives({
    levy: { enabled: true, mix: { MILITIA: 1 }, populationReserve: 0, reserve: zeroAmounts() },
  });

  it("沒有閒置的招募佇列就記 QUEUE_BUSY", () => {
    const d = decideStewardActions(input({ directives: levyOn, barracksQueuesFree: 0 }));
    expect(d.actions).toHaveLength(0);
    expect(d.blocked).toContainEqual({ directive: "LEVY", reason: "QUEUE_BUSY" });
  });

  it("有佇列時依配比招兵", () => {
    const d = decideStewardActions(
      input({
        directives: directives({
          levy: {
            enabled: true,
            mix: { MILITIA: 3, SPEARMAN: 1 },
            populationReserve: 0,
            reserve: zeroAmounts(),
          },
        }),
        barracksQueuesFree: 1,
        population: { amount: 400, cap: 500, used: 100 },
      }),
    );
    const militia = d.actions.find((a) => a.kind === "LEVY" && a.unit === "MILITIA");
    const spear = d.actions.find((a) => a.kind === "LEVY" && a.unit === "SPEARMAN");
    expect(militia).toBeDefined();
    expect(spear).toBeDefined();
    if (militia?.kind === "LEVY" && spear?.kind === "LEVY") {
      expect(militia.count).toBeGreaterThan(spear.count);
    }
  });

  it("★ 人口保留下限擋住募兵 —— 拓荒隊也要人", () => {
    const d = decideStewardActions(
      input({
        directives: directives({
          levy: {
            enabled: true,
            mix: { MILITIA: 1 },
            populationReserve: 100,
            reserve: zeroAmounts(),
          },
        }),
        barracksQueuesFree: 1,
        population: { amount: 90, cap: 150, used: 60 },
      }),
    );
    expect(d.blocked).toContainEqual({ directive: "LEVY", reason: "POPULATION_RESERVE" });
  });
});

describe("方針的讀取與預設", () => {
  it("★ 預設全部關閉 —— 不替領主決定要不要用工具", () => {
    const d = defaultDirectives();
    expect(d.expansion.enabled).toBe(false);
    expect(d.development.enabled).toBe(false);
    expect(d.levy.enabled).toBe(false);
  });

  it("★ 認不出來的 jsonb 退回「關閉」，不是「開啟」", () => {
    expect(parseDirectives(null).expansion.enabled).toBe(false);
    expect(parseDirectives({ expansion: "yes" }).expansion.enabled).toBe(false);
    expect(parseDirectives({ expansion: { enabled: 1 } }).expansion.enabled).toBe(false);
  });

  it("讀得回完整的方針", () => {
    const parsed = parseDirectives({
      expansion: { enabled: true, preference: "TOWARD_RUIN", reserve: { timber: 5000 } },
      development: { enabled: true, priority: ["MINE", "🐟", "FARM"] },
      levy: { enabled: true, mix: { SWORDSMAN: 2, NOPE: 5 }, populationReserve: 40 },
      pausedUntil: T0,
    });
    expect(parsed.expansion.preference).toBe("TOWARD_RUIN");
    expect(parsed.expansion.reserve.timber).toBe(5000);
    expect(parsed.development.priority).toEqual(["MINE", "FARM"]);
    expect(parsed.levy.mix).toEqual({ SWORDSMAN: 2 });
    expect(parsed.levy.populationReserve).toBe(40);
    expect(parsed.pausedUntil).toBe(T0);
  });

  it("負的保留下限被夾到 0", () => {
    expect(parseDirectives({ expansion: { reserve: { grain: -500 } } }).expansion.reserve.grain).toBe(0);
  });
});

describe("名字", () => {
  it("同一個 seed 永遠得到同一個名字", () => {
    expect(stewardName(12345)).toBe(stewardName(12345));
  });

  it("不同 seed 大致上不同", () => {
    const names = new Set(Array.from({ length: 200 }, (_, i) => stewardName(i)));
    expect(names.size).toBeGreaterThan(20);
  });
});
