import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import { dailyTransferCap } from "@/lib/game/market";
import { settleWithin } from "@/lib/server/player-state";
import {
  acceptListingFor,
  cancelListingFor,
  createListingFor,
  loadBoardFor,
} from "@/lib/server/market-ops";
import {
  createHarness,
  readResources,
  seedPlayer,
  seedSeason,
  seedAlliance,
  seedTile,
  type Harness,
} from "@/lib/server/testing/pg-harness";

/**
 * 集市的整合測試。
 *
 * ★ 交易是**唯一**會把資源從一個帳號搬到另一個的路徑，
 *   所以它的整合測試不是「有比較好」，是必要的：
 *   託管扣款、日上限記帳、`FOR UPDATE` 的搶單、
 *   商隊送達 —— 每一步都跨兩位玩家，純函式測不到那個交叉。
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

/** 兩位同盟成員，賣方有一座集市 */
async function pair(opts: { resources?: number; citadelLevel?: number } = {}) {
  const seasonId = await seedSeason(h, { startedAt: T0 });

  const seller = await seedPlayer(h, seasonId, {
    startedAt: T0,
    resources: opts.resources ?? 1500,
    citadelLevel: opts.citadelLevel ?? 20,
    baseX: 100,
    baseY: 100,
  });
  const buyer = await seedPlayer(h, seasonId, {
    startedAt: T0,
    resources: opts.resources ?? 1500,
    citadelLevel: opts.citadelLevel ?? 20,
    baseX: 160,
    baseY: 100,
  });

  const allianceId = await seedAlliance(h, seasonId, [seller.playerId, buyer.playerId]);

  // 賣方的集市（掛單需要，承接不需要）
  await seedTile(h, seasonId, seller.playerId, {
    x: 101,
    y: 99,
    facility: "MARKET",
    facilityLevel: 2,
  });

  return { seasonId, allianceId, sellerId: seller.playerId, buyerId: buyer.playerId };
}

describe("★ 掛單：託管是真的扣款", () => {
  it("掛單當下賣方的石材就少了", async () => {
    const { sellerId } = await pair();
    const before = await readResources(h, sellerId);

    const r = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 600, "timber", 500, T0.getTime()),
    );
    expect(r.ok).toBe(true);

    const after = await readResources(h, sellerId);
    expect(after.stone).toBeCloseTo(before.stone - 600, 3);
  });

  it("沒有集市就掛不了單", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const p = await seedPlayer(h, seasonId, { startedAt: T0 });
    await seedAlliance(h, seasonId, [p.playerId], { name: "無市聯盟" });

    const r = await h.tx((tx) =>
      createListingFor(tx, p.playerId, "stone", 100, "timber", 100, T0.getTime()),
    );
    expect(r).toEqual({ ok: false, reason: "NO_MARKET" });
  });

  it("★ 無聯盟者完全無法交易 —— 這是刻意的", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const p = await seedPlayer(h, seasonId, { startedAt: T0, allianceId: null });
    const r = await h.tx((tx) =>
      createListingFor(tx, p.playerId, "stone", 100, "timber", 100, T0.getTime()),
    );
    expect(r).toEqual({ ok: false, reason: "NO_ALLIANCE" });
  });

  it("掛單數上限 = 2 × 集市等級（Lv2 → 4 張）", async () => {
    const { sellerId } = await pair();
    for (let i = 0; i < 4; i++) {
      const r = await h.tx((tx) =>
        createListingFor(tx, sellerId, "stone", 100, "timber", 100, T0.getTime()),
      );
      expect(r.ok).toBe(true);
    }
    const fifth = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 100, "timber", 100, T0.getTime()),
    );
    expect(fifth).toEqual({ ok: false, reason: "LISTING_LIMIT" });
  });

  it("★ DB 的 CHECK 也擋同種資源互換 —— 繞過純函式也擋得住", async () => {
    const { seasonId, sellerId } = await pair();
    await expect(
      h.tx((tx) =>
        tx.insert(schema.marketListings).values({
          seasonId,
          sellerId,
          allianceId: 1,
          offerResource: "timber",
          offerAmount: "100",
          wantResource: "timber",
          wantAmount: "1",
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("★ 承接：資源真的跨帳號移動", () => {
  it("走完一趟：買方立刻扣款，商隊到期後雙方入帳", async () => {
    const { sellerId, buyerId } = await pair();
    const now = T0.getTime();

    const listing = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 600, "timber", 500, now),
    );
    const sellerAfterList = await readResources(h, sellerId);
    const buyerBefore = await readResources(h, buyerId);

    const accepted = await h.tx((tx) => acceptListingFor(tx, buyerId, listing.listingId!, now));
    expect(accepted.ok).toBe(true);

    // 買方的木材立刻少 800
    const buyerAfterAccept = await readResources(h, buyerId);
    expect(buyerAfterAccept.timber).toBeCloseTo(buyerBefore.timber - 500, 3);

    // 商隊還在路上，賣方還沒收到木材
    expect(sellerAfterList.timber).toBeCloseTo((await readResources(h, sellerId)).timber, 3);

    // 送達之後才入帳
    const at = accepted.arrivesAt! + 1000;
    await h.tx((tx) => settleWithin(tx, sellerId, at));
    await h.tx((tx) => settleWithin(tx, buyerId, at));

    const sellerFinal = await h.tx((tx) => settleWithin(tx, sellerId, at));
    const buyerFinal = await h.tx((tx) => settleWithin(tx, buyerId, at));
    expect(sellerFinal.economy.resources.timber).toBeGreaterThan(sellerAfterList.timber + 400);
    expect(buyerFinal.economy.resources.stone).toBeGreaterThan(buyerBefore.stone + 500);
  });

  it("★ 同一張單不能被接兩次", async () => {
    const { sellerId, buyerId } = await pair();
    const now = T0.getTime();
    const listing = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 100, "timber", 100, now),
    );

    expect((await h.tx((tx) => acceptListingFor(tx, buyerId, listing.listingId!, now))).ok).toBe(
      true,
    );
    const again = await h.tx((tx) => acceptListingFor(tx, buyerId, listing.listingId!, now));
    expect(again).toEqual({ ok: false, reason: "LISTING_GONE" });
  });

  it("不同聯盟的人接不到", async () => {
    const { seasonId, sellerId } = await pair();
    const now = T0.getTime();
    const outsider = await seedPlayer(h, seasonId, { startedAt: T0, baseX: 200, baseY: 200 });
    await seedAlliance(h, seasonId, [outsider.playerId], {
      faction: 2,
      slotNo: 2,
      name: "外人",
    });

    const listing = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 100, "timber", 100, now),
    );
    const r = await h.tx((tx) => acceptListingFor(tx, outsider.playerId, listing.listingId!, now));
    expect(r).toEqual({ ok: false, reason: "NOT_SAME_ALLIANCE" });
  });

  it("不能接自己的單", async () => {
    const { sellerId } = await pair();
    const now = T0.getTime();
    const listing = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 100, "timber", 100, now),
    );
    const r = await h.tx((tx) => acceptListingFor(tx, sellerId, listing.listingId!, now));
    expect(r).toEqual({ ok: false, reason: "SELF_TRADE" });
  });
});

describe("★ 日轉移上限：記帳跨遊戲月重置", () => {
  it("同一個遊戲月內累加，超過就擋", async () => {
    // 主堡 Lv1 → 上限 500
    const { sellerId, buyerId } = await pair({ citadelLevel: 1, resources: 1500 });
    const now = T0.getTime();
    expect(dailyTransferCap(1)).toBe(500);

    const a = await h.tx((tx) => createListingFor(tx, sellerId, "stone", 400, "timber", 400, now));
    const okA = await h.tx((tx) => acceptListingFor(tx, buyerId, a.listingId!, now));
    expect(okA.ok).toBe(true);

    const b = await h.tx((tx) => createListingFor(tx, sellerId, "stone", 400, "timber", 400, now));
    const blocked = await h.tx((tx) => acceptListingFor(tx, buyerId, b.listingId!, now));
    expect(blocked).toEqual({ ok: false, reason: "DAILY_CAP" });
  });

  it("★ 換一個遊戲月（= 一個真實日）就重置", async () => {
    const { sellerId, buyerId } = await pair({ citadelLevel: 1, resources: 1500 });
    const now = T0.getTime();

    const a = await h.tx((tx) => createListingFor(tx, sellerId, "stone", 400, "timber", 400, now));
    await h.tx((tx) => acceptListingFor(tx, buyerId, a.listingId!, now));

    // 一個遊戲月 = 一個真實日
    const nextMonth = now + 25 * HOUR;
    const b = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 400, "timber", 400, nextMonth),
    );
    const okB = await h.tx((tx) => acceptListingFor(tx, buyerId, b.listingId!, nextMonth));
    expect(okB.ok).toBe(true);
  });

  it("記帳落到 market_transfers，雙方各一列", async () => {
    const { sellerId, buyerId } = await pair();
    const now = T0.getTime();
    const listing = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 600, "timber", 500, now),
    );
    await h.tx((tx) => acceptListingFor(tx, buyerId, listing.listingId!, now));

    const [s] = await h.db
      .select()
      .from(schema.marketTransfers)
      .where(eq(schema.marketTransfers.playerId, sellerId));
    const [b] = await h.db
      .select()
      .from(schema.marketTransfers)
      .where(eq(schema.marketTransfers.playerId, buyerId));

    // 記的是「自己送出去的量」，兩邊數字不同
    expect(Number(s!.amount)).toBe(600);
    expect(Number(b!.amount)).toBe(500);
  });
});

describe("撤單與看板", () => {
  it("撤單退回託管，而且單子關掉", async () => {
    const { sellerId } = await pair();
    const now = T0.getTime();
    const before = await readResources(h, sellerId);

    const listing = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 600, "timber", 500, now),
    );
    const r = await h.tx((tx) => cancelListingFor(tx, sellerId, listing.listingId!, now));
    expect(r.ok).toBe(true);

    const after = await readResources(h, sellerId);
    expect(after.stone).toBeCloseTo(before.stone, 3);

    const [row] = await h.db
      .select()
      .from(schema.marketListings)
      .where(eq(schema.marketListings.id, listing.listingId!));
    expect(row!.status).toBe("CANCELLED");
  });

  it("別人的單撤不掉", async () => {
    const { sellerId, buyerId } = await pair();
    const now = T0.getTime();
    const listing = await h.tx((tx) =>
      createListingFor(tx, sellerId, "stone", 100, "timber", 100, now),
    );
    const r = await h.tx((tx) => cancelListingFor(tx, buyerId, listing.listingId!, now));
    expect(r).toEqual({ ok: false, reason: "SELF_TRADE" });
  });

  it("看板只列同盟的未成交單，並標出哪些是自己的", async () => {
    const { sellerId, buyerId } = await pair();
    const now = T0.getTime();
    await h.tx((tx) => createListingFor(tx, sellerId, "stone", 100, "timber", 100, now));

    const board = await h.tx((tx) => loadBoardFor(tx, buyerId, now));
    expect(board.listings).toHaveLength(1);
    expect(board.listings[0]!.mine).toBe(false);
    expect(board.dailyCap).toBe(dailyTransferCap(20));

    const own = await h.tx((tx) => loadBoardFor(tx, sellerId, now));
    expect(own.listings[0]!.mine).toBe(true);
    expect(own.marketLevel).toBe(2);
  });

  it("無聯盟者的看板是空的", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const p = await seedPlayer(h, seasonId, { startedAt: T0, allianceId: null });
    const board = await h.tx((tx) => loadBoardFor(tx, p.playerId, T0.getTime()));
    expect(board.allianceId).toBeNull();
    expect(board.listings).toHaveLength(0);
  });
});
