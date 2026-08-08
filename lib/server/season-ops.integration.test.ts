/**
 * 賽季生命週期的整合測試。
 *
 * ★ 這裡最要緊的兩件事都是**資料庫層**才驗得到的：
 *   1. 名額的併發控制真的靠 `CHECK (taken <= capacity)` 擋住超賣
 *   2. T = 0 寫進去的 600 位玩家，`settledAt` 是同一個時間戳
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { PHASE_DURATION, SEASON_CAPACITY, startingResources } from "@/lib/game/season";
import * as schema from "@/lib/db/schema";
import {
  abandonSeasonFor,
  advanceSeasons,
  createSeason,
  ensureNextSeason,
  lockdownSeason,
  registerFor,
  scheduleOf,
  startSeason,
} from "./season-ops";
import { createHarness, type Harness } from "./testing/pg-harness";

/** 封盤要跑真的地圖生成。候選壓到 2、不換 seed，測試才跑得完 */
const FAST_WORLD = { ruinCandidateCount: 2, maxSeedAttempts: 1 } as const;

const T0 = Date.UTC(2026, 8, 1);
const HOUR = 3_600_000;

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

let userCounter = 0;
async function makeUser(): Promise<number> {
  const email = `s${++userCounter}@season.test`;
  const [u] = await h.db
    .insert(schema.users)
    .values({ email, provider: "email", displayName: email })
    .returning({ id: schema.users.id });
  return u!.id;
}

describe("createSeason", () => {
  it("開一場賽季會同時建好九列名額，加起來 600", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 4242, registrationOpensAt: T0 }));

    const quotas = await h.db
      .select()
      .from(schema.seasonQuotas)
      .where(eq(schema.seasonQuotas.seasonId, seasonId));

    expect(quotas).toHaveLength(9);
    expect(quotas.reduce((s, q) => s + q.capacity, 0)).toBe(SEASON_CAPACITY);
    expect(quotas.every((q) => q.taken === 0)).toBe(true);

    const [season] = await h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId));
    expect(season!.status).toBe("REGISTRATION");
    // 時間軸從 registrationOpensAt 推導，不是隨手寫死
    expect(scheduleOf(season!).registrationOpensAt).toBe(T0);
  });
});

describe("登記", () => {
  it("正常登記會遞增名額、遞增 humanCount", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 7, registrationOpensAt: T0 }));
    const userId = await makeUser();

    const r = await h.tx((tx) =>
      registerFor(tx, seasonId, userId, { faction: 2, band: "FRONTIER" }, T0 + HOUR),
    );
    expect(r).toEqual({ ok: true });

    const [quota] = await h.db
      .select()
      .from(schema.seasonQuotas)
      .where(
        and(
          eq(schema.seasonQuotas.seasonId, seasonId),
          eq(schema.seasonQuotas.faction, 2),
          eq(schema.seasonQuotas.spawnBand, "FRONTIER"),
        ),
      );
    expect(quota!.taken).toBe(1);

    const [season] = await h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId));
    expect(season!.humanCount).toBe(1);
  });

  it("同一場不能登記兩次", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 8, registrationOpensAt: T0 }));
    const userId = await makeUser();

    await h.tx((tx) =>
      registerFor(tx, seasonId, userId, { faction: 1, band: "HEARTLAND" }, T0 + HOUR),
    );
    const second = await h.tx((tx) =>
      registerFor(tx, seasonId, userId, { faction: 3, band: "VANGUARD" }, T0 + HOUR),
    );
    expect(second).toEqual({ ok: false, reason: "ALREADY_REGISTERED" });

    // 被拒的那次不該留下痕跡
    const [quota] = await h.db
      .select()
      .from(schema.seasonQuotas)
      .where(
        and(
          eq(schema.seasonQuotas.seasonId, seasonId),
          eq(schema.seasonQuotas.faction, 3),
          eq(schema.seasonQuotas.spawnBand, "VANGUARD"),
        ),
      );
    expect(quota!.taken).toBe(0);
  });

  it("★ 一個人不能同時在兩場賽季裡 —— 下一場在第 7 天就開放了", async () => {
    const first = await h.tx((tx) => createSeason(tx, { seed: 9, registrationOpensAt: T0 }));
    const second = await h.tx((tx) =>
      createSeason(tx, { seed: 10, registrationOpensAt: T0 + 7 * 24 * HOUR }),
    );
    const userId = await makeUser();

    await h.tx((tx) =>
      registerFor(tx, first, userId, { faction: 1, band: "HEARTLAND" }, T0 + HOUR),
    );
    const r = await h.tx((tx) =>
      registerFor(
        tx,
        second,
        userId,
        { faction: 1, band: "HEARTLAND" },
        T0 + 7 * 24 * HOUR + HOUR,
      ),
    );
    expect(r).toEqual({ ok: false, reason: "ALREADY_IN_ANOTHER_SEASON" });

    // 前一場封存之後就放行
    await h.db
      .update(schema.seasons)
      .set({ status: "ARCHIVED" })
      .where(eq(schema.seasons.id, first));
    const again = await h.tx((tx) =>
      registerFor(
        tx,
        second,
        userId,
        { faction: 1, band: "HEARTLAND" },
        T0 + 7 * 24 * HOUR + HOUR,
      ),
    );
    expect(again).toEqual({ ok: true });
  });

  it("★ 額滿由 DB 的 CHECK 擋住 —— 不是應用層讀計數", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 11, registrationOpensAt: T0 }));

    // 直接把名額灌到 capacity - 1，省掉 39 次登記
    await h.db
      .update(schema.seasonQuotas)
      .set({ taken: sql`${schema.seasonQuotas.capacity} - 1` })
      .where(
        and(
          eq(schema.seasonQuotas.seasonId, seasonId),
          eq(schema.seasonQuotas.faction, 1),
          eq(schema.seasonQuotas.spawnBand, "VANGUARD"),
        ),
      );

    const winner = await makeUser();
    expect(
      await h.tx((tx) =>
        registerFor(tx, seasonId, winner, { faction: 1, band: "VANGUARD" }, T0 + HOUR),
      ),
    ).toEqual({ ok: true });

    const loser = await makeUser();
    expect(
      await h.tx((tx) =>
        registerFor(tx, seasonId, loser, { faction: 1, band: "VANGUARD" }, T0 + HOUR),
      ),
    ).toEqual({ ok: false, reason: "QUOTA_FULL" });

    /**
     * ★ 就算繞過 planRegistration 的預檢（模擬兩個交易同時讀到 taken = 39），
     *   約束仍然會擋下第 41 個人。這一條才是真正的併發保證。
     */
    await expect(
      h.tx(async (tx) => {
        await tx
          .update(schema.seasonQuotas)
          .set({ taken: sql`${schema.seasonQuotas.taken} + 1` })
          .where(
            and(
              eq(schema.seasonQuotas.seasonId, seasonId),
              eq(schema.seasonQuotas.faction, 1),
              eq(schema.seasonQuotas.spawnBand, "VANGUARD"),
            ),
          );
      }),
    ).rejects.toThrow();
  });

  it("登記期以外不收", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 12, registrationOpensAt: T0 }));
    const userId = await makeUser();
    const r = await h.tx((tx) =>
      registerFor(tx, seasonId, userId, { faction: 1, band: "HEARTLAND" }, T0 + 5 * 24 * HOUR),
    );
    expect(r).toEqual({ ok: false, reason: "NOT_OPEN" });
  });
});

describe("★ 封盤 → 開賽", () => {
  let seasonId: number;
  const humanIds: number[] = [];

  beforeAll(async () => {
    seasonId = await h.tx((tx) => createSeason(tx, { seed: 99991, registrationOpensAt: T0 }));

    // 四位真人：兩位組隊、兩位散客，涵蓋三個環帶
    const picks = [
      { faction: 1 as const, band: "HEARTLAND", squadCode: "PALS" },
      { faction: 1 as const, band: "HEARTLAND", squadCode: "PALS" },
      { faction: 2 as const, band: "FRONTIER", squadCode: null },
      { faction: 3 as const, band: "VANGUARD", squadCode: null },
    ];
    for (const p of picks) {
      const userId = await makeUser();
      humanIds.push(userId);
      const r = await h.tx((tx) => registerFor(tx, seasonId, userId, p, T0 + HOUR));
      expect(r).toEqual({ ok: true });
    }

    await h.tx((tx) => lockdownSeason(tx, seasonId, { world: FAST_WORLD }));
  }, 180_000);

  it("封盤後狀態是 SEALED，AI 補到剛好 600", async () => {
    const [season] = await h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId));
    expect(season!.status).toBe("SEALED");
    expect(season!.humanCount + season!.aiCount).toBe(SEASON_CAPACITY);
    expect(season!.humanCount).toBe(4);
  });

  it("公平性報告與遺跡座標都存下來了 —— 封盤期的預覽要看", () => {
    return h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId))
      .then(([season]) => {
        expect(Array.isArray(season!.ruinPositions)).toBe(true);
        expect((season!.ruinPositions as unknown[]).length).toBe(3);
        expect(season!.fairnessReport).toHaveProperty("pass");
      });
  });

  it("★ 座位表存了 600 個，T = 0 不必再跑一次地圖生成", async () => {
    const [season] = await h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId));
    const plan = season!.spawnPlan as { registrationId: number | null; terrain: string[] }[];
    expect(plan).toHaveLength(SEASON_CAPACITY);
    expect(plan.filter((s) => s.registrationId !== null)).toHaveLength(4);
    // 每個座位都帶著核心 2×2 的地形
    expect(plan.every((s) => s.terrain.length === 4)).toBe(true);
  });

  it("真人的出生座標寫回登記列，開賽前就看得到", async () => {
    const regs = await h.db
      .select()
      .from(schema.seasonRegistrations)
      .where(eq(schema.seasonRegistrations.seasonId, seasonId));
    expect(regs).toHaveLength(4);
    for (const r of regs) {
      expect(r.assignedX).not.toBeNull();
      expect(r.assignedY).not.toBeNull();
      // 但玩家還不存在 —— 資源不能從封盤那一刻就開始累積
      expect(r.playerId).toBeNull();
    }
  });

  it("★ 同代碼的兩人被放在一起", async () => {
    const regs = await h.db
      .select()
      .from(schema.seasonRegistrations)
      .where(
        and(
          eq(schema.seasonRegistrations.seasonId, seasonId),
          eq(schema.seasonRegistrations.squadCode, "PALS"),
        ),
      );
    expect(regs).toHaveLength(2);
    const [a, b] = regs;
    const dist = Math.max(Math.abs(a!.assignedX! - b!.assignedX!), Math.abs(a!.assignedY! - b!.assignedY!));
    // 小隊群集的半徑，比隨機兩點近得多（隨機約 100+ 格）
    expect(dist).toBeLessThan(40);
  });

  describe("T = 0", () => {
    const startAt = T0 + 3 * 24 * HOUR + 12 * HOUR;

    beforeAll(async () => {
      await h.tx((tx) => startSeason(tx, seasonId, startAt));
    }, 180_000);

    it("600 位玩家全部寫進去，狀態轉 RUNNING", async () => {
      const [row] = await h.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.players)
        .where(eq(schema.players.seasonId, seasonId));
      expect(row!.n).toBe(SEASON_CAPACITY);

      const [season] = await h.db
        .select()
        .from(schema.seasons)
        .where(eq(schema.seasons.id, seasonId));
      expect(season!.status).toBe("RUNNING");
      expect(season!.startedAt!.getTime()).toBe(startAt);
    });

    it("★ 所有人的 settledAt 是同一個時間戳 —— 這是「全員同時進入」的全部意義", async () => {
      const rows = await h.db
        .select({ n: sql<number>`count(distinct ${schema.players.settledAt})::int` })
        .from(schema.players)
        .where(eq(schema.players.seasonId, seasonId));
      expect(rows[0]!.n).toBe(1);

      const res = await h.db
        .select({ n: sql<number>`count(distinct ${schema.playerResources.settledAt})::int` })
        .from(schema.playerResources)
        .innerJoin(schema.players, eq(schema.players.id, schema.playerResources.playerId))
        .where(eq(schema.players.seasonId, seasonId));
      expect(res[0]!.n).toBe(1);
    });

    it("真人與 AI 的比例正確，AI 都有性格", async () => {
      const players = await h.db
        .select()
        .from(schema.players)
        .where(eq(schema.players.seasonId, seasonId));
      const ai = players.filter((p) => p.isAi);
      expect(ai).toHaveLength(SEASON_CAPACITY - 4);
      expect(ai.every((p) => p.aiPersona !== null && p.aiVariance !== null)).toBe(true);
      expect(players.filter((p) => !p.isAi).every((p) => p.userId !== null)).toBe(true);
      // 三種性格都有出現
      expect(new Set(ai.map((p) => p.aiPersona)).size).toBe(3);
    });

    it("登記列補上 playerId，玩家找得到自己", async () => {
      const regs = await h.db
        .select()
        .from(schema.seasonRegistrations)
        .where(eq(schema.seasonRegistrations.seasonId, seasonId));
      expect(regs.every((r) => r.playerId !== null)).toBe(true);
    });

    it("★ 邊陲的起始資源 ×1.4，中腹是基準", async () => {
      const rows = await h.db
        .select({
          band: schema.players.spawnBand,
          grain: schema.playerResources.grain,
        })
        .from(schema.players)
        .innerJoin(
          schema.playerResources,
          eq(schema.playerResources.playerId, schema.players.id),
        )
        .where(eq(schema.players.seasonId, seasonId));

      for (const r of rows) {
        expect(Number(r.grain)).toBe(startingResources(r.band).grain);
      }
    });

    it("★ 起始民兵從第一秒就佔人口", async () => {
      const rows = await h.db
        .select({ used: schema.playerPopulation.used, units: schema.garrisons.units })
        .from(schema.players)
        .innerJoin(
          schema.playerPopulation,
          eq(schema.playerPopulation.playerId, schema.players.id),
        )
        .innerJoin(
          schema.garrisons,
          and(
            eq(schema.garrisons.ownerId, schema.players.id),
            eq(schema.garrisons.atX, schema.players.baseX),
          ),
        )
        .where(eq(schema.players.seasonId, seasonId))
        .limit(20);

      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(Number(r.used)).toBe(10);
        expect(r.units).toEqual({ MILITIA: 10 });
      }
    });

    it("每人四格核心、三個空格位、一位執政官", async () => {
      const [tiles] = await h.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.tiles)
        .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.kind, "BASE_CORE")));
      expect(tiles!.n).toBe(SEASON_CAPACITY * 4);

      const [stewards] = await h.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.stewards)
        .innerJoin(schema.players, eq(schema.players.id, schema.stewards.playerId))
        .where(eq(schema.players.seasonId, seasonId));
      expect(stewards!.n).toBe(SEASON_CAPACITY);

      const [slots] = await h.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.baseSlots)
        .innerJoin(schema.players, eq(schema.players.id, schema.baseSlots.playerId))
        .where(eq(schema.players.seasonId, seasonId));
      expect(slots!.n).toBe(SEASON_CAPACITY * 3);
    });

    it("★ 核心格的地形是真的地形，不是全部 PLAIN", async () => {
      const kinds = await h.db
        .selectDistinct({ terrain: schema.tiles.terrain })
        .from(schema.tiles)
        .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.kind, "BASE_CORE")));
      expect(kinds.length).toBeGreaterThan(1);
    });

    it("開局的玩家可以直接被結算 —— 整條經濟鏈接得上", async () => {
      const { settleWithin } = await import("./player-state");
      const [me] = await h.db
        .select()
        .from(schema.players)
        .where(and(eq(schema.players.seasonId, seasonId), eq(schema.players.isAi, false)))
        .limit(1);

      const state = await h.tx((tx) => settleWithin(tx, me!.id, startAt + 2 * HOUR));
      expect(state.build.citadel).toBe(1);
      expect(state.garrison).toEqual({ MILITIA: 10 });
      // 主堡保底產出讓資源一定在長
      expect(state.economy.resources.stone).toBeGreaterThan(
        startingResources(me!.spawnBand).stone,
      );
      // 前線 +1 領土容量真的到得了推導層
      expect(state.bandBonus).toBe(me!.spawnBand === "VANGUARD" ? 1 : 0);
    });
  });
});

describe("advanceSeasons", () => {
  it("★ 冪等：已經在正確階段的賽季不會被動到", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 555, registrationOpensAt: T0 }));

    // 還在登記期 → 什麼都不做
    expect(await h.tx((tx) => advanceSeasons(tx, T0 + HOUR))).toMatchObject({
      locked: 0,
      started: 0,
    });

    const [before] = await h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId));
    expect(before!.status).toBe("REGISTRATION");
  });

  it("推到終戰期只是換一個狀態，不會重跑封盤", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 556, registrationOpensAt: T0 }));
    await h.db
      .update(schema.seasons)
      .set({ status: "RUNNING", startedAt: new Date(T0 + 3.5 * 24 * HOUR) })
      .where(eq(schema.seasons.id, seasonId));

    const schedule = scheduleOf(
      (await h.db.select().from(schema.seasons).where(eq(schema.seasons.id, seasonId)))[0]!,
    );

    const summary = await h.tx((tx) => advanceSeasons(tx, schedule.endsAt + HOUR));
    expect(summary.ended).toBeGreaterThanOrEqual(1);

    const [after] = await h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId));
    expect(after!.status).toBe("ENDING");

    // 再跑一次不會有變化
    await h.tx((tx) => advanceSeasons(tx, schedule.endsAt + 2 * HOUR));
    const [again] = await h.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, seasonId));
    expect(again!.status).toBe("ENDING");
  });
});

describe("★ ensureNextSeason：七天的節奏", () => {
  /**
   * 這一組是回歸測試。第一版的判準是「現在有沒有賽季在收登記」，
   * 而登記在第 3 天就截止、下一場要第 7 天才開 —— 中間那四天本來就
   * 應該沒有人在收人。結果結算迴圈在封盤後的第一分鐘就開了下一場，
   * 七天的輪替變成三天，而且每一輪都再快一點。
   *
   * 症狀在真實環境下才看得到：seed 完一場賽季、打一次 /api/cron/settle，
   * 回應裡就多了一個 `created: 2`。
   */
  let fresh: Harness;

  beforeAll(async () => {
    fresh = await createHarness();
  });
  afterAll(async () => {
    await fresh.close();
  });

  const idsOf = async () =>
    (await fresh.db.select({ id: schema.seasons.id }).from(schema.seasons)).map((r) => r.id);

  it("完全沒有賽季時開第一場", async () => {
    const id = await fresh.tx((tx) => ensureNextSeason(tx, T0));
    expect(id).not.toBeNull();
    expect(await idsOf()).toHaveLength(1);
  });

  it("★ 登記截止之後**不**馬上開下一場 —— 那四天的空窗是刻意的", async () => {
    // 登記期內
    expect(await fresh.tx((tx) => ensureNextSeason(tx, T0 + HOUR))).toBeNull();
    // 登記已截止（第 3 天）、封盤中
    expect(await fresh.tx((tx) => ensureNextSeason(tx, T0 + 3 * 24 * HOUR + HOUR))).toBeNull();
    // 開賽了，但還沒到第 7 天
    expect(await fresh.tx((tx) => ensureNextSeason(tx, T0 + 6 * 24 * HOUR))).toBeNull();
    expect(await idsOf()).toHaveLength(1);
  });

  it("第 7 天開下一場，而且對齊在格子上（不被 cron 的觸發時刻拖走）", async () => {
    const at = T0 + PHASE_DURATION.cadenceMs + 37 * 60_000; // 晚了 37 分鐘才跑到
    const id = await fresh.tx((tx) => ensureNextSeason(tx, at));
    expect(id).not.toBeNull();

    const [next] = await fresh.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, id!));
    // 用 nextOpensAt 而不是 now —— 否則每一輪都會往後漂
    expect(scheduleOf(next!).registrationOpensAt).toBe(T0 + PHASE_DURATION.cadenceMs);
  });

  it("剛開完就再問一次不會又開一場", async () => {
    const before = await idsOf();
    expect(
      await fresh.tx((tx) => ensureNextSeason(tx, T0 + PHASE_DURATION.cadenceMs + HOUR)),
    ).toBeNull();
    expect(await idsOf()).toEqual(before);
  });

  it("★ 排程停擺很久之後重新對時，不會開出一場「一出生就該封盤」的賽季", async () => {
    const long = T0 + PHASE_DURATION.cadenceMs * 5;
    const id = await fresh.tx((tx) => ensureNextSeason(tx, long));
    expect(id).not.toBeNull();

    const [next] = await fresh.db
      .select()
      .from(schema.seasons)
      .where(eq(schema.seasons.id, id!));
    // 落後超過一個週期 → 從現在重新起算，而不是照抄早就過期的 nextOpensAt
    expect(scheduleOf(next!).registrationOpensAt).toBe(long);
    expect(scheduleOf(next!).registrationClosesAt).toBeGreaterThan(long);
  });
});

/**
 * ★ 放棄賽季（`docs/13` §8）——「一位領主同時只能在一場」的出口。
 *
 * 這一組驗的是那條規則不再是一座牢：放棄之後**馬上**能報名下一場，
 * 而且放棄的後果與主城被打爆完全相同（共用 `leaveSeason`）。
 */
describe("★ 放棄賽季", () => {
  it("放棄登記期的賽季 → 名額與真人數都退回去，而且能改報另一場", async () => {
    const first = await h.tx((tx) => createSeason(tx, { seed: 71, registrationOpensAt: T0 }));
    const second = await h.tx((tx) =>
      createSeason(tx, { seed: 72, registrationOpensAt: T0 + 7 * 24 * HOUR }),
    );
    const userId = await makeUser();

    await h.tx((tx) => registerFor(tx, first, userId, { faction: 2, band: "FRONTIER" }, T0 + HOUR));

    const takenOf = async (seasonId: number) => {
      const [q] = await h.db
        .select({ taken: schema.seasonQuotas.taken })
        .from(schema.seasonQuotas)
        .where(
          and(
            eq(schema.seasonQuotas.seasonId, seasonId),
            eq(schema.seasonQuotas.faction, 2),
            eq(schema.seasonQuotas.spawnBand, "FRONTIER"),
          ),
        );
      return q!.taken;
    };
    const humansOf = async (seasonId: number) => {
      const [s] = await h.db
        .select({ n: schema.seasons.humanCount })
        .from(schema.seasons)
        .where(eq(schema.seasons.id, seasonId));
      return s!.n;
    };
    expect(await takenOf(first)).toBe(1);
    expect(await humansOf(first)).toBe(1);

    const bye = await h.tx((tx) => abandonSeasonFor(tx, userId, T0 + 2 * HOUR));
    expect(bye).toEqual({ ok: true, seasonId: first, hadPlayer: false });

    // ★ 還沒封盤 → 座位真的還空著，名額與真人數都要還回去
    expect(await takenOf(first)).toBe(0);
    expect(await humansOf(first)).toBe(0);

    // ★ 出口成立：立刻就能報下一場
    const again = await h.tx((tx) =>
      registerFor(tx, second, userId, { faction: 1, band: "HEARTLAND" }, T0 + 7 * 24 * HOUR + HOUR),
    );
    expect(again).toEqual({ ok: true });
  });

  it("退出的登記不佔座位 —— 封盤時不會替他生一座空城", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 73, registrationOpensAt: T0 }));
    const stay = await makeUser();
    const quit = await makeUser();
    await h.tx((tx) => registerFor(tx, seasonId, stay, { faction: 1, band: "HEARTLAND" }, T0 + HOUR));
    await h.tx((tx) => registerFor(tx, seasonId, quit, { faction: 1, band: "HEARTLAND" }, T0 + HOUR));
    await h.tx((tx) => abandonSeasonFor(tx, quit, T0 + 2 * HOUR));

    const [row] = await h.db
      .select({ withdrawnAt: schema.seasonRegistrations.withdrawnAt })
      .from(schema.seasonRegistrations)
      .where(
        and(
          eq(schema.seasonRegistrations.seasonId, seasonId),
          eq(schema.seasonRegistrations.userId, quit),
        ),
      );
    expect(row!.withdrawnAt).not.toBeNull();

    const summary = await h.tx((tx) => lockdownSeason(tx, seasonId, { world: FAST_WORLD }));
    // 只剩一位真人，其餘全是 AI
    expect(summary.humans).toBe(1);
    expect(summary.humans + summary.ai).toBe(SEASON_CAPACITY);
  }, 180_000);

  it("★ 放棄已經開打的賽季 → 據點拆除、領地釋放，而且能立刻報名另一場", async () => {
    const seasonId = await h.tx((tx) => createSeason(tx, { seed: 74, registrationOpensAt: T0 }));
    const userId = await makeUser();
    await h.tx((tx) => registerFor(tx, seasonId, userId, { faction: 1, band: "HEARTLAND" }, T0 + HOUR));
    await h.tx((tx) => lockdownSeason(tx, seasonId, { world: FAST_WORLD }));
    const startAt = T0 + 3 * 24 * HOUR + 12 * HOUR;
    await h.tx((tx) => startSeason(tx, seasonId, startAt));

    const [me] = await h.db
      .select({ id: schema.players.id })
      .from(schema.players)
      .where(and(eq(schema.players.seasonId, seasonId), eq(schema.players.userId, userId)));
    expect(me).toBeDefined();

    const bye = await h.tx((tx) => abandonSeasonFor(tx, userId, startAt + HOUR));
    expect(bye).toEqual({ ok: true, seasonId, hadPlayer: true });

    const [after] = await h.db
      .select({
        eliminatedAt: schema.players.eliminatedAt,
        exitReason: schema.players.exitReason,
      })
      .from(schema.players)
      .where(eq(schema.players.id, me!.id));
    expect(after!.eliminatedAt).not.toBeNull();
    // ★ 與主城被打爆共用同一份拆除，差別只有這個字串
    expect(after!.exitReason).toBe("ABANDONED");

    const [tileCount] = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.playerId, me!.id)));
    expect(tileCount!.n).toBe(0);

    const [garrisonCount] = await h.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.garrisons)
      .where(and(eq(schema.garrisons.seasonId, seasonId), eq(schema.garrisons.ownerId, me!.id)));
    expect(garrisonCount!.n).toBe(0);

    // ★ 出口成立：那一場還在跑，但他已經不在裡面了
    const next = await h.tx((tx) =>
      createSeason(tx, { seed: 75, registrationOpensAt: startAt + 2 * HOUR }),
    );
    const again = await h.tx((tx) =>
      registerFor(tx, next, userId, { faction: 3, band: "VANGUARD" }, startAt + 3 * HOUR),
    );
    expect(again).toEqual({ ok: true });
  }, 180_000);

  it("不在任何一場裡就沒有東西可以放棄", async () => {
    const userId = await makeUser();
    const r = await h.tx((tx) => abandonSeasonFor(tx, userId, T0));
    expect(r).toEqual({ ok: false, reason: "NOT_IN_ANY_SEASON" });
  });
});
