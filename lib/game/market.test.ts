import { describe, expect, it } from "vitest";

import { MARKET } from "./balance";
import {
  caravanSeconds,
  creditDelivery,
  dailyTransferCap,
  exchangeRate,
  isTradable,
  listingCap,
  planAccept,
  planCancel,
  planListing,
  type Listing,
  type TraderState,
} from "./market";

const T0 = Date.UTC(2026, 7, 10);

function trader(over: Partial<TraderState> = {}): TraderState {
  return {
    playerId: 1,
    allianceId: 7,
    citadelLevel: 10,
    resources: { grain: 5000, timber: 5000, stone: 5000, iron: 5000 },
    capacity: 10_000,
    marketLevel: 2,
    transferredToday: 0,
    openListings: 0,
    ...over,
  };
}

const listing: Listing = {
  id: 1,
  sellerId: 1,
  allianceId: 7,
  offer: { resource: "stone", amount: 1000 },
  want: { resource: "timber", amount: 800 },
  createdAt: T0,
};

describe("集市：數字與 docs/11 §10 一致", () => {
  it("日轉移上限 = 500 × 主堡等級", () => {
    expect(dailyTransferCap(10)).toBe(5000);
    expect(dailyTransferCap(1)).toBe(500);
  });

  it("掛單數 = 2 × 集市等級，沒集市就是 0", () => {
    expect(listingCap(3)).toBe(6);
    expect(listingCap(0)).toBe(0);
  });

  it("商隊速度 60 格/h", () => {
    expect(caravanSeconds(60)).toBe(3600);
    expect(MARKET.taxRate).toBe(0);
  });

  it("遺物不可交易", () => {
    expect(isTradable("relic")).toBe(false);
    expect(isTradable("grain")).toBe(true);
  });
});

describe("★ 掛單：掛單方需要集市，承接方不需要", () => {
  it("有集市就能掛", () => {
    const r = planListing(trader(), listing.offer, listing.want);
    expect(r).toEqual({ escrow: { grain: 0, timber: 0, stone: 1000, iron: 0 } });
  });

  it("沒集市不能掛", () => {
    expect(planListing(trader({ marketLevel: 0 }), listing.offer, listing.want)).toEqual({
      reason: "NO_MARKET",
    });
  });

  it("★ 承接方沒集市也能承接 —— 這是「商人」角色長出來的原因", () => {
    const buyer = trader({ playerId: 2, marketLevel: 0 });
    expect("reason" in planAccept(listing, buyer, trader())).toBe(false);
  });

  it("無聯盟者完全無法交易", () => {
    expect(planListing(trader({ allianceId: null }), listing.offer, listing.want)).toEqual({
      reason: "NO_ALLIANCE",
    });
    expect(planAccept(listing, trader({ playerId: 2, allianceId: null }), trader())).toEqual({
      reason: "NO_ALLIANCE",
    });
  });

  it("掛單數超過上限就掛不了", () => {
    expect(planListing(trader({ openListings: 4 }), listing.offer, listing.want)).toEqual({
      reason: "LISTING_LIMIT",
    });
  });

  it("★ 同種資源互換擋掉 —— 那是繞過日上限的漏洞", () => {
    expect(
      planListing(trader(), { resource: "timber", amount: 1000 }, { resource: "timber", amount: 1 }),
    ).toEqual({ reason: "SAME_RESOURCE" });
  });

  it("掛單當下就扣款（託管），資源不夠就掛不了", () => {
    const poor = trader({ resources: { grain: 0, timber: 0, stone: 10, iron: 0 } });
    expect(planListing(poor, listing.offer, listing.want)).toEqual({
      reason: "INSUFFICIENT_RESOURCES",
    });
  });
});

describe("★ 承接：只能跟同一聯盟的人換", () => {
  it("同盟成員可以承接", () => {
    const r = planAccept(listing, trader({ playerId: 2 }), trader());
    expect("reason" in r).toBe(false);
    if ("reason" in r) return;
    expect(r.buyerPays.timber).toBe(800);
    expect(r.buyerReceives.stone).toBe(1000);
    expect(r.sellerReceives.timber).toBe(800);
  });

  it("不同聯盟不能承接", () => {
    expect(planAccept(listing, trader({ playerId: 2, allianceId: 9 }), trader())).toEqual({
      reason: "NOT_SAME_ALLIANCE",
    });
  });

  it("★ 賣方中途退盟，單就失效 —— 不是「掛單當下同盟」就算數", () => {
    expect(
      planAccept(listing, trader({ playerId: 2 }), trader({ allianceId: null })),
    ).toEqual({ reason: "NOT_SAME_ALLIANCE" });
  });

  it("不能承接自己的單", () => {
    expect(planAccept(listing, trader({ playerId: 1 }), trader())).toEqual({
      reason: "SELF_TRADE",
    });
  });
});

describe("★ 日轉移上限：雙方各算一次，防小號互餵", () => {
  it("賣方今天已經送太多就擋下來", () => {
    const seller = trader({ transferredToday: dailyTransferCap(10) - 999 });
    expect(planAccept(listing, trader({ playerId: 2 }), seller)).toEqual({ reason: "DAILY_CAP" });
  });

  it("★ 買方也算 —— 只算單邊的話換個方向掛單就繞過去了", () => {
    const buyer = trader({ playerId: 2, transferredToday: dailyTransferCap(10) - 799 });
    expect(planAccept(listing, buyer, trader())).toEqual({ reason: "DAILY_CAP" });
  });

  it("小號的上限本來就低 —— 上限跟著主堡走", () => {
    const alt = trader({ playerId: 2, citadelLevel: 1 });
    expect(dailyTransferCap(alt.citadelLevel)).toBe(500);
    // Lv1 小號連這張 800 木的單都接不動
    expect(planAccept(listing, alt, trader())).toEqual({ reason: "DAILY_CAP" });
  });

  it("記帳的是「送出去的量」，兩邊數字不同", () => {
    const r = planAccept(listing, trader({ playerId: 2 }), trader());
    if ("reason" in r) throw new Error(r.reason);
    expect(r.sellerTransferred).toBe(1000);
    expect(r.buyerTransferred).toBe(800);
  });
});

describe("商隊送達與撤單", () => {
  it("★ 送達受儲存上限約束 —— 不能拿盟友的倉庫當第二個倉庫", () => {
    const r = creditDelivery(
      { grain: 0, timber: 900, stone: 0, iron: 0 },
      { grain: 0, timber: 500, stone: 0, iron: 0 },
      1000,
    );
    expect(r.resources.timber).toBe(1000);
    expect(r.overflow.timber).toBe(400);
  });

  it("撤單退回託管的資源", () => {
    expect(planCancel(listing, 1)).toEqual({
      refund: { grain: 0, timber: 0, stone: 1000, iron: 0 },
    });
  });

  it("別人的單撤不掉", () => {
    expect(planCancel(listing, 2)).toEqual({ reason: "SELF_TRADE" });
  });

  it("匯率算給 UI 看", () => {
    expect(exchangeRate(listing)).toBeCloseTo(1.25, 6);
  });
});
