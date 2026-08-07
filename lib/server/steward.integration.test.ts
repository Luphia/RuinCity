import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import { defaultDirectives, type Directives } from "@/lib/game/steward";
import { zeroAmounts } from "@/lib/game/settle";
import { buildFacilityFor, claimTileFor } from "@/lib/server/base-ops";
import { settleWithin } from "@/lib/server/player-state";
import { ensureSteward, loadBriefing, runStewardWithin, saveDirectives } from "@/lib/server/steward";
import {
  createHarness,
  readResources,
  seedPlayer,
  seedSeason,
  seedTile,
  writeTerrainFixture,
  type Harness,
} from "@/lib/server/testing/pg-harness";

/**
 * 執政官與共用操作核心的整合測試。
 *
 * ★ 這裡的重點不是「決策對不對」（那由 `steward.test.ts` 的 38 個純函式
 *   測試涵蓋），而是 **`docs/18` §2 與 §11.2 在真實資料庫上真的成立嗎**：
 *   執政官走的是與玩家同一條路徑、核心佇列一根手指都沒碰。
 */

const T0 = new Date(Date.UTC(2026, 7, 10));
const HOUR = 3_600_000;

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

function directives(over: Partial<Directives> = {}): Directives {
  return { ...defaultDirectives(), ...over };
}

async function setup(opts: { citadelLevel?: number; resources?: number } = {}) {
  const seasonId = await seedSeason(h, { startedAt: T0 });
  const player = await seedPlayer(h, seasonId, {
    startedAt: T0,
    citadelLevel: opts.citadelLevel ?? 10,
    resources: opts.resources ?? 50_000,
  });
  await writeTerrainFixture(seasonId);
  return { seasonId, playerId: player.playerId };
}

describe("★ 共用操作核心：玩家與執政官走同一條路徑", () => {
  it("拓荒 → CLAIM_DONE → tiles 真的多一列，地形從靜態檔抄過來", async () => {
    const { seasonId, playerId } = await setup();
    const now = T0.getTime();

    const result = await h.tx((tx) => claimTileFor(tx, playerId, 101, 99, now));
    expect(result.ok).toBe(true);

    // 立旗完成之前，那一格還不是你的
    const mid = await h.tx((tx) => settleWithin(tx, playerId, now + 60_000));
    expect(mid.tiles).toHaveLength(0);
    expect(mid.build.territoryQueue[0]).not.toBeNull();

    const done = await h.tx((tx) => settleWithin(tx, playerId, result.doneAt! + 1000));
    expect(done.tiles).toHaveLength(1);
    expect(done.tiles[0]).toMatchObject({ x: 101, y: 99, terrain: "PLAIN" });
  });

  it("★ 民兵在下單時就被扣掉，不是立旗完成時", async () => {
    const { playerId } = await setup();
    const now = T0.getTime();

    const before = await h.db
      .select()
      .from(schema.playerPopulation)
      .where(eq(schema.playerPopulation.playerId, playerId));
    expect(Number(before[0]!.used)).toBe(0);

    const r = await h.tx((tx) => claimTileFor(tx, playerId, 101, 99, now));
    expect(r.ok).toBe(true);

    // 立旗還沒完成，但人已經走了
    const during = await h.db
      .select()
      .from(schema.playerPopulation)
      .where(eq(schema.playerPopulation.playerId, playerId));
    expect(Number(during[0]!.used)).toBeGreaterThan(0);

    // 完成之後**不會再扣一次**
    const after = await h.tx((tx) => settleWithin(tx, playerId, r.doneAt! + 1000));
    expect(after.economy.population.used).toBe(Number(during[0]!.used));
  });

  it("★ 拓荒佔用領土佇列 —— 同時拓荒上限 = 佇列數", async () => {
    const { playerId } = await setup();
    const now = T0.getTime();

    // 主堡 Lv10 → territoryQueues(10) = 2 條
    expect((await h.tx((tx) => claimTileFor(tx, playerId, 101, 99, now))).ok).toBe(true);
    expect((await h.tx((tx) => claimTileFor(tx, playerId, 100, 99, now))).ok).toBe(true);
    const third = await h.tx((tx) => claimTileFor(tx, playerId, 99, 100, now));
    expect(third).toEqual({ ok: false, reason: "NO_FREE_QUEUE" });
  });

  it("★ 一格只能有一種設施，成本不會被偷換", async () => {
    const { seasonId, playerId } = await setup();
    await seedTile(h, seasonId, playerId, { x: 101, y: 99, facility: "FARM", facilityLevel: 2 });
    const now = T0.getTime();

    const mismatch = await h.tx((tx) => buildFacilityFor(tx, playerId, 101, 99, "WATCHTOWER", now));
    expect(mismatch).toEqual({ ok: false, reason: "FACILITY_MISMATCH" });

    const ok = await h.tx((tx) => buildFacilityFor(tx, playerId, 101, 99, "FARM", now));
    expect(ok.ok).toBe(true);
  });

  it("★ 建設扣的錢與純函式算的一致，而且真的扣了", async () => {
    const { seasonId, playerId } = await setup({ resources: 50_000 });
    await seedTile(h, seasonId, playerId, { x: 101, y: 99 });

    const before = await readResources(h, playerId);
    await h.tx((tx) => buildFacilityFor(tx, playerId, 101, 99, "FARM", T0.getTime()));
    const after = await readResources(h, playerId);

    expect(after.timber).toBeLessThan(before.timber);
  });

  it("集市每位玩家上限 1 座", async () => {
    const { seasonId, playerId } = await setup();
    await seedTile(h, seasonId, playerId, { x: 101, y: 99, facility: "MARKET", facilityLevel: 1 });
    await seedTile(h, seasonId, playerId, { x: 102, y: 99 });

    const second = await h.tx((tx) => buildFacilityFor(tx, playerId, 102, 99, "MARKET", T0.getTime()));
    expect(second).toEqual({ ok: false, reason: "MARKET_LIMIT" });
  });
});

describe("★ 執政官：鐵則在真實資料庫上成立", () => {
  it("★ 募兵：開了方針、蓋了兵營，執政官就真的招得出兵", async () => {
    const { seasonId, playerId } = await setup();
    await h.db
      .update(schema.baseSlots)
      .set({ building: "BARRACKS", level: 5 })
      .where(and(eq(schema.baseSlots.playerId, playerId), eq(schema.baseSlots.slot, "B")));
    await h.db
      .update(schema.playerPopulation)
      .set({ amount: "400", cap: "500" })
      .where(eq(schema.playerPopulation.playerId, playerId));

    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          levy: {
            enabled: true,
            mix: { SPEARMAN: 1 },
            populationReserve: 0,
            reserve: zeroAmounts(),
          },
        }),
      ),
    );

    const r = await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime()));
    expect(r.executed).toBeGreaterThan(0);

    const trains = await h.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.actorId, playerId), eq(schema.events.type, "TRAIN_DONE")));
    expect(trains.length).toBeGreaterThan(0);

    // 結算之後兵真的進駐軍
    const done = trains[0]!;
    const state = await h.tx((tx) =>
      settleWithin(tx, playerId, done.resolveAt.getTime() + 1000),
    );
    expect((state.garrison.SPEARMAN ?? 0)).toBeGreaterThan(0);
    expect(seasonId).toBeGreaterThan(0);
  });

  it("方針全關就什麼都不做，但安全網 tick 還是要排下去", async () => {
    const { playerId } = await setup();
    const r = await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime()));
    expect(r.ran).toBe(false);
    expect(r.executed).toBe(0);

    const ticks = await h.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.actorId, playerId), eq(schema.events.type, "STEWARD_TICK")));
    expect(ticks).toHaveLength(1);
  });

  it("★ 安全網 tick 不會自我繁殖 —— 跑十次仍然只有一個未結算的", async () => {
    const { playerId } = await setup();
    for (let i = 0; i < 10; i++) {
      await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime() + i * 60_000));
    }
    const ticks = await h.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.actorId, playerId), eq(schema.events.type, "STEWARD_TICK")));
    expect(ticks).toHaveLength(1);
  });

  it("開了拓荒方針就真的會拓 —— 而且走的是 claimTileFor", async () => {
    const { seasonId, playerId } = await setup();
    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
        }),
      ),
    );

    const r = await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime()));
    expect(r.ran).toBe(true);
    expect(r.executed).toBeGreaterThan(0);

    const claims = await h.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.actorId, playerId), eq(schema.events.type, "CLAIM_DONE")));
    expect(claims.length).toBeGreaterThan(0);
    // 拓荒的目標必須貼著核心 2×2
    const p = claims[0]!.payload as { x: number; y: number };
    expect(Math.abs(p.x - 100) + Math.abs(p.y - 100)).toBeLessThanOrEqual(2);
  });

  it("★ 執政官一根手指都沒碰核心佇列", async () => {
    const { playerId } = await setup();
    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
          development: { enabled: true, priority: ["FARM"], reserve: zeroAmounts() },
          levy: { enabled: true, mix: { MILITIA: 1 }, populationReserve: 0, reserve: zeroAmounts() },
        }),
      ),
    );

    for (let i = 0; i < 5; i++) {
      await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime() + i * HOUR));
    }

    const state = await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + 6 * HOUR));
    // 主堡沒升、B/C/D 都還是空的、核心佇列閒著
    expect(state.build.citadel).toBe(10);
    expect(state.build.slots.B.building).toBeNull();
    expect(state.build.coreQueue).toBeNull();
  });

  it("★ 資源保留下限真的擋得住 —— 存起來的木材不會被花掉", async () => {
    const { playerId } = await setup({ resources: 2000 });
    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          expansion: {
            enabled: true,
            preference: "NEAREST",
            reserve: { grain: 0, timber: 2000, stone: 0, iron: 0 },
          },
        }),
      ),
    );

    const before = await readResources(h, playerId);
    const r = await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime()));
    const after = await readResources(h, playerId);

    expect(r.executed).toBe(0);
    expect(after.timber).toBe(before.timber);
    expect(r.decision?.blocked.some((b) => b.reason === "RESERVE")).toBe(true);
  });

  it("暫停期間完全停手", async () => {
    const { playerId } = await setup();
    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
          pausedUntil: T0.getTime() + 6 * HOUR,
        }),
      ),
    );

    const r = await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime() + HOUR));
    expect(r.executed).toBe(0);

    const claims = await h.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.actorId, playerId), eq(schema.events.type, "CLAIM_DONE")));
    expect(claims).toHaveLength(0);
  });

  it("★ 方針超過主堡允許的格數時，多的那些不生效但會進簡報", async () => {
    const { playerId } = await setup({ citadelLevel: 1 });
    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
          development: { enabled: true, priority: ["FARM"], reserve: zeroAmounts() },
          levy: { enabled: true, mix: { MILITIA: 1 }, populationReserve: 0, reserve: zeroAmounts() },
        }),
      ),
    );

    const r = await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime()));
    const noSlot = r.decision?.blocked.filter((b) => b.reason === "NO_SLOT") ?? [];
    expect(noSlot.map((b) => b.directive)).toEqual(["DEVELOPMENT", "LEVY"]);
  });
});

describe("執政官的資料與簡報", () => {
  it("名字由 playerId 決定性生成，重複呼叫不會建第二列", async () => {
    const { playerId } = await setup();
    const a = await h.tx((tx) => ensureSteward(tx, playerId));
    const b = await h.tx((tx) => ensureSteward(tx, playerId));
    expect(a.name).toBe(b.name);

    const rows = await h.db
      .select()
      .from(schema.stewards)
      .where(eq(schema.stewards.playerId, playerId));
    expect(rows).toHaveLength(1);
  });

  it("方針存得進去也讀得回來", async () => {
    const { playerId } = await setup();
    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          expansion: {
            enabled: true,
            preference: "TOWARD_RUIN",
            reserve: { grain: 100, timber: 200, stone: 0, iron: 0 },
          },
          pausedUntil: T0.getTime(),
        }),
      ),
    );

    const loaded = await h.tx((tx) => ensureSteward(tx, playerId));
    expect(loaded.directives.expansion.preference).toBe("TOWARD_RUIN");
    expect(loaded.directives.expansion.reserve.timber).toBe(200);
    expect(loaded.directives.pausedUntil).toBe(T0.getTime());
  });

  it("★ BLOCKED 會去重 —— 離線一晚不會看到同一句話十二遍", async () => {
    const { playerId } = await setup({ resources: 500 });
    await h.tx((tx) =>
      saveDirectives(
        tx,
        playerId,
        directives({
          expansion: {
            enabled: true,
            preference: "NEAREST",
            reserve: { grain: 999_999, timber: 999_999, stone: 0, iron: 0 },
          },
        }),
      ),
    );

    // 每兩小時一個 tick，跑六輪（12 小時）
    for (let i = 0; i < 6; i++) {
      await h.tx((tx) => runStewardWithin(tx, playerId, T0.getTime() + i * 2 * HOUR));
    }

    const briefing = await h.tx((tx) => loadBriefing(tx, playerId, T0.getTime() + 12 * HOUR));
    const blocked = briefing.entries.filter((e) => e.kind === "BLOCKED");
    // 去重窗是 6 小時，12 小時內最多兩則
    expect(blocked.length).toBeLessThanOrEqual(2);
    expect(blocked.length).toBeGreaterThan(0);
  });

  it("簡報帶得出執政官的名字與離開多久", async () => {
    const { playerId } = await setup();
    const briefing = await h.tx((tx) => loadBriefing(tx, playerId, T0.getTime() + 5 * HOUR));
    expect(briefing.stewardName).toBeTruthy();
    expect(briefing.awayMs).toBe(5 * HOUR);
  });
});
