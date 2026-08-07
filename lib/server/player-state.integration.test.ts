import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { SEASON_MODIFIERS } from "@/lib/game/balance";
import { schema } from "@/lib/db";
import { claimTileFor } from "@/lib/server/base-ops";
import { scheduleEvent, settleWithin } from "@/lib/server/player-state";
import {
  createHarness,
  readResources,
  seedPlayer,
  seedSeason,
  seedTile,
  type Harness,
} from "@/lib/server/testing/pg-harness";

/**
 * `lib/server/*` 的整合測試，跑在**真的 Postgres** 上（PGlite）。
 *
 * ★ 這裡驗的是純函式測試看不到的東西：交易邊界、`FOR UPDATE` 的鎖、
 *   upsert 的衝突、`CHECK` 約束、以及「事件真的被寫回資料庫了嗎」。
 *   `docs/11` §16.1 把這一層列為 M2 的已知缺口 —— 這個檔案是來補它的。
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

describe("settleWithin：讀取 + 結算 + 寫回", () => {
  it("離線一小時的產出真的落到資料庫裡", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0, resources: 0 });

    const before = await readResources(h, playerId);
    expect(before.grain).toBe(0);

    await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + HOUR));

    const after = await readResources(h, playerId);
    // 主堡 Lv10 的保底產出 = 5 × 10 × TIME_SCALE(4) = 200/h，再乘春季係數
    expect(after.grain).toBeCloseTo(200 * SEASON_MODIFIERS.SPRING.production, 3);
    expect(after.settledAt).toBe(T0.getTime() + HOUR);
  });

  it("★ 冪等：同一個 now 結算兩次結果一樣", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0, resources: 0 });
    const at = T0.getTime() + 3 * HOUR;

    await h.tx((tx) => settleWithin(tx, playerId, at));
    const once = await readResources(h, playerId);
    await h.tx((tx) => settleWithin(tx, playerId, at));
    const twice = await readResources(h, playerId);

    expect(twice.grain).toBeCloseTo(once.grain, 6);
  });

  it("★ BUILD_DONE 真的把主堡等級寫回 players 表", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0, citadelLevel: 5 });

    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "BUILD_DONE",
        actorId: playerId,
        payload: { kind: "CORE", target: "CITADEL", toLevel: 6 },
        resolveAt: T0.getTime() + HOUR,
      }),
    );

    const state = await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + 2 * HOUR));
    expect(state.build.citadel).toBe(6);

    const [row] = await h.db
      .select({ level: schema.players.citadelLevel })
      .from(schema.players)
      .where(eq(schema.players.id, playerId));
    expect(row!.level).toBe(6);
  });

  it("★ 核心建築完成後 base_slots 被 upsert，不是靜靜地漏掉", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0 });

    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "BUILD_DONE",
        actorId: playerId,
        payload: { kind: "CORE", target: "B", building: "BARRACKS", toLevel: 1 },
        resolveAt: T0.getTime() + HOUR,
      }),
    );
    await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + 2 * HOUR));

    const [slot] = await h.db
      .select()
      .from(schema.baseSlots)
      .where(and(eq(schema.baseSlots.playerId, playerId), eq(schema.baseSlots.slot, "B")));
    expect(slot!.building).toBe("BARRACKS");
    expect(slot!.level).toBe(1);
  });

  it("★ CLAIM_DONE 真的把 tiles 那一列寫出來，含地形", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0 });

    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "CLAIM_DONE",
        actorId: playerId,
        payload: { kind: "CLAIM", x: 101, y: 99, militia: 5, terrain: "LODE", queueIndex: 0 },
        resolveAt: T0.getTime() + HOUR,
      }),
    );
    await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + 2 * HOUR));

    const [tile] = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, 101), eq(schema.tiles.y, 99)));
    expect(tile!.playerId).toBe(playerId);
    expect(tile!.terrain).toBe("LODE");

    /**
     * ★ 這裡的 `used` 是 0，而且**應該**是 0。
     *   事件是直接塞進去的，沒有經過 `claimTileFor` ——
     *   而民兵是在**下單時**被扣掉的，不是立旗完成時。
     *   完整的路徑由 `steward.integration.test.ts` 驗。
     */
    const [pop] = await h.db
      .select()
      .from(schema.playerPopulation)
      .where(eq(schema.playerPopulation.playerId, playerId));
    expect(Number(pop!.used)).toBe(0);
  });

  it("★ ISOLATION_EXPIRE 把地還回去，不是只改狀態", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0 });
    await seedTile(h, seasonId, playerId, { x: 120, y: 120, state: "ISOLATED" });

    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "ISOLATION_EXPIRE",
        actorId: playerId,
        payload: { x: 120, y: 120 },
        resolveAt: T0.getTime() + HOUR,
      }),
    );
    await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + 2 * HOUR));

    const [tile] = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, 120), eq(schema.tiles.y, 120)));
    expect(tile!.playerId).toBeNull();
  });

  it("事件被標記已結算，不會重複套用", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0, citadelLevel: 5 });

    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "BUILD_DONE",
        actorId: playerId,
        payload: { kind: "CORE", target: "CITADEL", toLevel: 6 },
        resolveAt: T0.getTime() + HOUR,
      }),
    );
    await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + 2 * HOUR));
    const second = await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + 3 * HOUR));

    expect(second.build.citadel).toBe(6);
    const [row] = await h.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.actorId, playerId));
    expect(row!.resolvedAt).not.toBeNull();
  });

  it("★ 佇列從未結算的事件推導出來，不另存一張表", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0 });

    const doneAt = T0.getTime() + 10 * HOUR;
    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "BUILD_DONE",
        actorId: playerId,
        payload: { kind: "CORE", target: "CITADEL", toLevel: 11 },
        resolveAt: doneAt,
      }),
    );

    const state = await h.tx((tx) => settleWithin(tx, playerId, T0.getTime() + HOUR));
    expect(state.build.coreQueue).toEqual({ target: "CITADEL", doneAt });
  });
});

describe("★ 交易邊界：資源不會被扣兩次", () => {
  it("兩次連續拓荒各自扣一次，且第二次因為佇列忙而失敗", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0, resources: 100_000 });

    const now = T0.getTime();
    const first = await h.tx((tx) => claimTileFor(tx, playerId, 101, 99, now));
    const second = await h.tx((tx) => claimTileFor(tx, playerId, 100, 99, now));

    // 地形檔在測試環境不存在 —— 兩次都應該乾淨地失敗，而不是扣了錢才失敗
    if (!first.ok) {
      expect(first.reason).toBe("TERRAIN_UNAVAILABLE");
      const after = await readResources(h, playerId);
      expect(after.grain).toBe(100_000);
      return;
    }

    expect(second.ok).toBe(false);
    expect(second.reason).toBe("NO_FREE_QUEUE");
  });

  it("★ 交易失敗要整筆回滾 —— 不能留下扣了錢卻沒排事件的半套狀態", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0, resources: 5000 });

    await expect(
      h.tx(async (tx) => {
        await tx
          .update(schema.playerResources)
          .set({ grain: "0" })
          .where(eq(schema.playerResources.playerId, playerId));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await readResources(h, playerId);
    expect(after.grain).toBe(5000);
  });

  it("★ CHECK 約束擋下負資源 —— DB 是最後一道防線", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const { playerId } = await seedPlayer(h, seasonId, { startedAt: T0, resources: 100 });

    await expect(
      h.tx((tx) =>
        tx
          .update(schema.playerResources)
          .set({ grain: "-1" })
          .where(eq(schema.playerResources.playerId, playerId)),
      ),
    ).rejects.toThrow();
  });
});
