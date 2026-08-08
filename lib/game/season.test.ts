import { describe, expect, it } from "vitest";

import { SPAWN_BAND, SQUAD } from "./balance";
import {
  humanSoloCountsFrom,
  BASE_STARTING_RESOURCES,
  bonusTerritoryCapacity,
  FACTION_CAPACITY,
  gameMonthOf,
  initialQuotas,
  normaliseSquadCode,
  PHASE_DURATION,
  phaseAt,
  planAiFill,
  planRegistration,
  registrationOpen,
  scheduleFrom,
  SEASON_CAPACITY,
  squadRequestsFrom,
  startingPopulationUsed,
  startingResources,
  totalCapacity,
  type QuotaRow,
  type RegistrationContext,
} from "./season";

const T0 = Date.UTC(2026, 7, 1);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const schedule = scheduleFrom(T0);

describe("★ 三層結構精確吻合：600 = 3 × 5 × 40", () => {
  it("九格名額加起來剛好 600", () => {
    expect(totalCapacity()).toBe(SEASON_CAPACITY);
    expect(initialQuotas()).toHaveLength(9);
  });

  it("每陣營 200 人", () => {
    for (const faction of [1, 2, 3] as const) {
      const sum = initialQuotas()
        .filter((q) => q.faction === faction)
        .reduce((s, q) => s + q.capacity, 0);
      expect(sum).toBe(FACTION_CAPACITY);
    }
  });

  it("環帶比例 20% / 50% / 30%", () => {
    expect(SPAWN_BAND.VANGUARD.quota).toBe(40);
    expect(SPAWN_BAND.HEARTLAND.quota).toBe(100);
    expect(SPAWN_BAND.FRONTIER.quota).toBe(60);
  });
});

describe("生命週期", () => {
  it("登記 3 天 → 封盤 12 小時 → 賽季 12 天 → 終戰 12 小時", () => {
    expect(schedule.registrationClosesAt - schedule.registrationOpensAt).toBe(3 * DAY);
    expect(schedule.startsAt - schedule.registrationClosesAt).toBe(12 * HOUR);
    expect(schedule.endsAt - schedule.startsAt).toBe(12 * DAY);
    expect(schedule.archivesAt - schedule.endsAt).toBe(12 * HOUR);
  });

  it("★ 下一場在第 7 天開放登記 —— 玩家的個人循環是 14 天不是 24 天", () => {
    expect(schedule.nextOpensAt - schedule.registrationOpensAt).toBe(7 * DAY);
    // 下一場開放登記時，這一場還在進行中
    expect(schedule.nextOpensAt).toBeLessThan(schedule.endsAt);
  });

  it("階段由時間戳推導", () => {
    expect(phaseAt(schedule, T0 + HOUR)).toBe("REGISTRATION");
    expect(phaseAt(schedule, schedule.registrationClosesAt + HOUR)).toBe("SEALED");
    expect(phaseAt(schedule, schedule.startsAt + HOUR)).toBe("RUNNING");
    expect(phaseAt(schedule, schedule.endsAt + HOUR)).toBe("ENDING");
    expect(phaseAt(schedule, schedule.archivesAt + HOUR)).toBe("ARCHIVED");
  });

  it("邊界剛好落在下一個階段的起點", () => {
    expect(phaseAt(schedule, schedule.registrationClosesAt)).toBe("SEALED");
    expect(phaseAt(schedule, schedule.startsAt)).toBe("RUNNING");
    expect(phaseAt(schedule, schedule.endsAt)).toBe("ENDING");
  });

  it("遊戲月：一個真實日一個月，未開賽是 0", () => {
    expect(gameMonthOf(schedule, T0)).toBe(0);
    expect(gameMonthOf(schedule, schedule.startsAt)).toBe(1);
    expect(gameMonthOf(schedule, schedule.startsAt + 5 * DAY + HOUR)).toBe(6);
    // 第 12 月結束後仍停在 12
    expect(gameMonthOf(schedule, schedule.endsAt + DAY)).toBe(12);
  });

  it("封盤期有 12 小時可以跑地圖生成 —— 實測平均 18 秒", () => {
    expect(PHASE_DURATION.sealedMs).toBe(12 * HOUR);
  });
});

describe("★ 登記：三個選擇，送出後不可更改", () => {
  function ctx(over: Partial<RegistrationContext> = {}): RegistrationContext {
    return {
      schedule,
      now: T0 + HOUR,
      quota: { capacity: 100, taken: 0 },
      alreadyRegistered: false,
      inAnotherSeason: false,
      squadMembers: [],
      ...over,
    };
  }

  it("正常登記", () => {
    expect(planRegistration({ faction: 1, band: "HEARTLAND" }, ctx())).toEqual({
      faction: 1,
      band: "HEARTLAND",
      squadCode: null,
    });
  });

  it("登記期之外不收", () => {
    expect(
      planRegistration({ faction: 1, band: "HEARTLAND" }, ctx({ now: schedule.startsAt })),
    ).toEqual({ reason: "NOT_OPEN" });
    expect(
      planRegistration({ faction: 1, band: "HEARTLAND" }, ctx({ now: T0 - HOUR })),
    ).toEqual({ reason: "NOT_OPEN" });
  });

  it("★ 額滿就關閉 —— 熱門陣營先滿是設計的一部分", () => {
    expect(
      planRegistration(
        { faction: 1, band: "VANGUARD" },
        ctx({ quota: { capacity: 40, taken: 40 } }),
      ),
    ).toEqual({ reason: "QUOTA_FULL" });
  });

  it("一位玩家同時只能在一場賽季中", () => {
    expect(
      planRegistration({ faction: 1, band: "HEARTLAND" }, ctx({ inAnotherSeason: true })),
    ).toEqual({ reason: "ALREADY_IN_ANOTHER_SEASON" });
  });

  it("同一場不能登記兩次", () => {
    expect(
      planRegistration({ faction: 1, band: "HEARTLAND" }, ctx({ alreadyRegistered: true })),
    ).toEqual({ reason: "ALREADY_REGISTERED" });
  });

  it("陣營與環帶要認得", () => {
    expect(planRegistration({ faction: 9, band: "HEARTLAND" }, ctx())).toEqual({
      reason: "UNKNOWN_FACTION",
    });
    expect(planRegistration({ faction: 1, band: "MIDDLE" }, ctx())).toEqual({
      reason: "UNKNOWN_BAND",
    });
  });
});

describe("★ 同行小隊：一群朋友，不是一支軍隊", () => {
  function ctx(over: Partial<RegistrationContext> = {}): RegistrationContext {
    return {
      schedule,
      now: T0 + HOUR,
      quota: { capacity: 100, taken: 0 },
      alreadyRegistered: false,
      inAnotherSeason: false,
      squadMembers: [],
      ...over,
    };
  }

  it("上限 8 人 —— 40 人抱團開局會把一區壓死", () => {
    expect(SQUAD.maxMembers).toBe(8);
    const full = Array.from({ length: 8 }, () => ({ faction: 1, band: "HEARTLAND" }));
    expect(
      planRegistration(
        { faction: 1, band: "HEARTLAND", squadCode: "ABCD" },
        ctx({ squadMembers: full }),
      ),
    ).toEqual({ reason: "SQUAD_FULL" });
  });

  it("★ 成員必須同陣營同環帶，否則代碼失效", () => {
    expect(
      planRegistration(
        { faction: 2, band: "HEARTLAND", squadCode: "ABCD" },
        ctx({ squadMembers: [{ faction: 1, band: "HEARTLAND" }] }),
      ),
    ).toEqual({ reason: "SQUAD_MISMATCH" });

    expect(
      planRegistration(
        { faction: 1, band: "FRONTIER", squadCode: "ABCD" },
        ctx({ squadMembers: [{ faction: 1, band: "HEARTLAND" }] }),
      ),
    ).toEqual({ reason: "SQUAD_MISMATCH" });
  });

  it("代碼統一轉大寫，格式不合就拒絕", () => {
    expect(normaliseSquadCode(" abcd ")).toBe("ABCD");
    expect(normaliseSquadCode("ab")).toBeNull();
    expect(normaliseSquadCode("this-is-too-long-x")).toBeNull();
    expect(normaliseSquadCode("有中文")).toBeNull();
    expect(normaliseSquadCode(null)).toBeNull();
  });

  it("★ 只有兩人以上才算小隊 —— 一個人填代碼就當散客", () => {
    const requests = squadRequestsFrom([
      { faction: 1, band: "HEARTLAND", squadCode: "TEAM" },
      { faction: 1, band: "HEARTLAND", squadCode: "TEAM" },
      { faction: 2, band: "FRONTIER", squadCode: "SOLO" },
      { faction: 3, band: "VANGUARD", squadCode: null },
    ]);
    expect(requests).toEqual([{ faction: 1, band: "HEARTLAND", size: 2 }]);
  });

  it("同代碼但不同陣營的算兩組（分配器不該把他們放在一起）", () => {
    const requests = squadRequestsFrom([
      { faction: 1, band: "HEARTLAND", squadCode: "X1" },
      { faction: 1, band: "HEARTLAND", squadCode: "X1" },
      { faction: 2, band: "HEARTLAND", squadCode: "X1" },
      { faction: 2, band: "HEARTLAND", squadCode: "X1" },
    ]);
    expect(requests).toHaveLength(2);
  });
});

describe("★ AI 補足：開賽時永遠恰好 600", () => {
  const quotas = (taken: number[]): QuotaRow[] =>
    initialQuotas().map((q, i) => ({ ...q, taken: taken[i] ?? 0 }));

  it("沒人登記就全部補 AI", () => {
    const plan = planAiFill(quotas([]));
    expect(plan.reduce((s, f) => s + f.count, 0)).toBe(SEASON_CAPACITY);
  });

  it("補完之後每一格都是滿的", () => {
    const rows = quotas([10, 20, 30, 5, 5, 5, 0, 0, 0]);
    const plan = planAiFill(rows);
    for (const row of rows) {
      const fill = plan.find((f) => f.faction === row.faction && f.band === row.band);
      expect(row.taken + (fill?.count ?? 0)).toBe(row.capacity);
    }
  });

  it("已經滿的那一格不補", () => {
    const rows = quotas([40, 100, 60, 40, 100, 60, 40, 100, 60]);
    expect(planAiFill(rows)).toEqual([]);
  });
});

describe("開局狀態", () => {
  it("起始資源：糧木石 500、鐵 200", () => {
    expect(startingResources("HEARTLAND")).toEqual(BASE_STARTING_RESOURCES);
  });

  it("★ 邊陲 ×1.4 是補償不是獎勵 —— 離自家遺跡最遠 = 離敵人最近", () => {
    expect(startingResources("FRONTIER").grain).toBe(700);
    expect(startingResources("FRONTIER").iron).toBe(280);
  });

  it("前線 +1 領土容量", () => {
    expect(bonusTerritoryCapacity("VANGUARD")).toBe(1);
    expect(bonusTerritoryCapacity("HEARTLAND")).toBe(0);
    expect(bonusTerritoryCapacity("FRONTIER")).toBe(0);
  });

  it("★ 起始的民兵從第一秒就佔人口 —— 陣亡不返還", () => {
    expect(startingPopulationUsed()).toBe(10);
  });
});

describe("registrationOpen", () => {
  it("只在登記期內為真", () => {
    expect(registrationOpen(schedule, T0 - 1)).toBe(false);
    expect(registrationOpen(schedule, T0)).toBe(true);
    expect(registrationOpen(schedule, schedule.registrationClosesAt - 1)).toBe(true);
    expect(registrationOpen(schedule, schedule.registrationClosesAt)).toBe(false);
  });
});

describe("humanSoloCountsFrom：散客真人的間距名單", () => {
  it("小隊成員不算散客；不足 2 人的小隊算散客", () => {
    const counts = humanSoloCountsFrom([
      { faction: 1, band: "VANGUARD", squadCode: "AAA" },
      { faction: 1, band: "VANGUARD", squadCode: "AAA" },
      { faction: 1, band: "VANGUARD", squadCode: null },
      { faction: 1, band: "VANGUARD", squadCode: "SOLO" }, // 一人小隊 = 散客
      { faction: 2, band: "FRONTIER", squadCode: null },
    ]);
    expect(counts).toContainEqual({ faction: 1, band: "VANGUARD", count: 2 });
    expect(counts).toContainEqual({ faction: 2, band: "FRONTIER", count: 1 });
    expect(counts).toHaveLength(2);
  });
});
