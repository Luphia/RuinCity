import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import { currentPlayerByEmail } from "./current-player";
import { createHarness, seedPlayer, seedSeason, type Harness } from "./testing/pg-harness";

/**
 * ★ 「我在哪一場」是這個 app 裡最容易各寫一份的查詢，
 *   而寫錯的症狀是**開錯賽季地圖**：玩家的據點畫在另一場的世界上。
 *
 * 這一組把那條判準釘住。它不驗 SQL，它驗的是**規則**：
 * 判準永遠從 `players` 出發，不從 `seasons`。
 */

const T0 = new Date(Date.UTC(2026, 7, 10));

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("★ 我在哪一場賽季", () => {
  it("★ 下一場開了登記，我的地圖還是我這一場 —— 這正是「開錯賽季地圖」的成因", async () => {
    const mine = await seedSeason(h, { startedAt: T0 });
    const me = await seedPlayer(h, mine, { startedAt: T0 });

    // 第 7 天：下一場開放登記。它比較新，但**我不在裡面**
    const next = await seedSeason(h, { startedAt: T0 });
    await h.db
      .update(schema.seasons)
      .set({ status: "REGISTRATION", startedAt: null })
      .where(eq(schema.seasons.id, next));

    const found = await h.tx((tx) => currentPlayerByEmail(me.email, tx));
    expect(found?.seasonId).toBe(mine);
    expect(found?.playerId).toBe(me.playerId);
  });

  it("★ 終戰期（ENDING）仍然是我的賽季 —— 只認 RUNNING 會讓最後兩天整個 app 說「你沒有賽季」", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const me = await seedPlayer(h, seasonId, { startedAt: T0 });

    await h.db
      .update(schema.seasons)
      .set({ status: "ENDING" })
      .where(eq(schema.seasons.id, seasonId));

    expect((await h.tx((tx) => currentPlayerByEmail(me.email, tx)))?.seasonId).toBe(seasonId);
  });

  it("★ 出局／放棄的人也查得到 —— 他要看得到自己的世界與結束畫面", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const me = await seedPlayer(h, seasonId, { startedAt: T0 });

    await h.db
      .update(schema.players)
      .set({ eliminatedAt: T0, exitReason: "ABANDONED" })
      .where(eq(schema.players.id, me.playerId));

    const found = await h.tx((tx) => currentPlayerByEmail(me.email, tx));
    expect(found?.seasonId).toBe(seasonId);
    expect(found?.eliminatedAt).toBe(T0.getTime());
    expect(found?.exitReason).toBe("ABANDONED");
  });

  it("封存的賽季不算 —— 那一場結束了", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const me = await seedPlayer(h, seasonId, { startedAt: T0 });

    await h.db
      .update(schema.seasons)
      .set({ status: "ARCHIVED" })
      .where(eq(schema.seasons.id, seasonId));

    expect(await h.tx((tx) => currentPlayerByEmail(me.email, tx))).toBeNull();
  });

  it("沒有據點的帳號回 null（登記了但還沒開打也是這一種）", async () => {
    expect(await h.tx((tx) => currentPlayerByEmail("nobody@test.local", tx))).toBeNull();
  });

  it("回傳的座標就是據點左上角 —— 地圖的個人圖層靠它定位", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const me = await seedPlayer(h, seasonId, { startedAt: T0, baseX: 312, baseY: 455 });
    const found = await h.tx((tx) => currentPlayerByEmail(me.email, tx));
    expect([found?.baseX, found?.baseY]).toEqual([312, 455]);
  });
});
