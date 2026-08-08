import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";

import { schema } from "@/lib/db";
import { runCronTick } from "@/lib/server/cron";
import { scheduleEvent } from "@/lib/server/player-state";
import { saveDirectives } from "@/lib/server/steward";
import { defaultDirectives } from "@/lib/game/steward";
import { zeroAmounts } from "@/lib/game/settle";
import {
  createHarness,
  seedPlayer,
  seedSeason,
  writeTerrainFixture,
  type Harness,
} from "@/lib/server/testing/pg-harness";

/**
 * `runCronTick` 的整合測試 —— 這一份 tick 同時是 `/api/cron/settle`
 * 與 `pnpm worker` 的心臟，所以它要在真的 Postgres 上被驗過：
 * 到期事件真的被收掉、執政官真的被叫起來、安全網真的重新排下去。
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

async function setup() {
  const seasonId = await seedSeason(h, { startedAt: T0 });
  const { playerId } = await seedPlayer(h, seasonId, {
    startedAt: T0,
    citadelLevel: 10,
    resources: 50_000,
  });
  await writeTerrainFixture(seasonId);
  return { seasonId, playerId };
}

describe("runCronTick：worker 與 cron 路由共用的那一輪", () => {
  it("到期的 STEWARD_TICK 被收掉，安全網重新排下去", async () => {
    const { seasonId, playerId } = await setup();
    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "STEWARD_TICK",
        actorId: playerId,
        payload: { kind: "STEWARD_TICK" },
        resolveAt: T0.getTime() + HOUR,
      }),
    );

    const now = T0.getTime() + HOUR + 1000;
    const tick = await runCronTick(now, h.tx);
    expect(tick.errors).toEqual([]);
    expect(tick.settled).toBe(1);
    expect(tick.failures).toBe(0);

    // 舊 tick 已結算、新 tick 排在未來 —— 執政官的心跳不會斷
    const resolved = await h.db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actorId, playerId),
          eq(schema.events.type, "STEWARD_TICK"),
          isNotNull(schema.events.resolvedAt),
        ),
      );
    expect(resolved).toHaveLength(1);
    const next = await h.db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actorId, playerId),
          eq(schema.events.type, "STEWARD_TICK"),
          isNull(schema.events.resolvedAt),
          gt(schema.events.resolveAt, new Date(now)),
        ),
      );
    expect(next).toHaveLength(1);

    // 同一個 now 再跑一輪：沒有到期的東西，什麼都不做
    const again = await runCronTick(now, h.tx);
    expect(again.settled).toBe(0);
  });

  it("★ 開了方針的玩家：tick 會讓執政官真的做事（拓荒）", async () => {
    const { seasonId, playerId } = await setup();
    await h.tx((tx) =>
      saveDirectives(tx, playerId, {
        ...defaultDirectives(),
        expansion: { enabled: true, preference: "NEAREST", reserve: zeroAmounts() },
      }),
    );
    await h.tx((tx) =>
      scheduleEvent(tx, {
        seasonId,
        type: "STEWARD_TICK",
        actorId: playerId,
        payload: { kind: "STEWARD_TICK" },
        resolveAt: T0.getTime() + HOUR,
      }),
    );

    const tick = await runCronTick(T0.getTime() + HOUR + 30_000, h.tx);
    expect(tick.errors).toEqual([]);
    expect(tick.stewardRuns).toBe(1);

    // 走的是與玩家相同的 claimTileFor：真的排出一面 CLAIM_DONE 旗
    const claims = await h.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.actorId, playerId), eq(schema.events.type, "CLAIM_DONE")));
    expect(claims.length).toBeGreaterThan(0);
  });

  it("沒有到期的事就是無事 —— 不多結算、不多叫執政官", async () => {
    const tick = await runCronTick(T0.getTime() + HOUR + 40_000, h.tx);
    expect(tick.errors).toEqual([]);
    expect(tick.settled).toBe(0);
    expect(tick.stewardRuns).toBe(0);
    expect(tick.marches).toEqual({ resolved: 0, battles: 0, failures: 0 });
  });
});
