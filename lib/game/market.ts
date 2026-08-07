/**
 * 集市：**只能與同盟成員交易**。純函式，無 I/O。
 * 對應 docs/03-economy.md §5 與 docs/11-balance-tables.md §10。
 *
 * ## ★ 為什麼這一節的規則看起來這麼綁手綁腳
 *
 * 資源不可跨類轉換，所以「石頭滿了但木頭見底」是必然會發生的困境。
 * 原設計讓你去全服市場換一下就好 —— 那等於把一個**社交或軍事**的壓力
 * 洩掉成一次無關痛癢的市場操作。
 *
 * 改成聯盟限定之後，你只剩兩條路：**加入聯盟跟盟友換，或者去搶**。
 * 沒有第三條。所以這裡的每一條限制都不是防弊而已：
 *
 * - **僅限同盟**：把經濟壓力導向社交或戰爭
 * - **掛單方需集市、承接方不需要**：集市佔一格領土，成本讓聯盟裡
 *   自然長出一兩位「商人」，而不是人人自己換
 * - **日轉移上限 `500 × 主堡等級`**：擋小號互餵。上限跟著主堡走，
 *   所以剛開局的小號能搬的量本來就少
 * - **無稅**：聯盟內部沒有中間商
 */

import { MARKET, type Resource } from "./balance";
import { zeroAmounts, type Amounts, type SettleResource } from "./settle";

export type TradeResource = SettleResource;

/** 遺物不可交易（`docs/03` §5） */
export function isTradable(r: Resource): r is TradeResource {
  return r !== "relic";
}

export interface Listing {
  readonly id: number;
  readonly sellerId: number;
  readonly allianceId: number;
  /** 賣方付出的 */
  readonly offer: { readonly resource: TradeResource; readonly amount: number };
  /** 賣方要換回的 */
  readonly want: { readonly resource: TradeResource; readonly amount: number };
  readonly createdAt: number;
}

export interface TraderState {
  readonly playerId: number;
  readonly allianceId: number | null;
  readonly citadelLevel: number;
  readonly resources: Amounts;
  readonly capacity: number;
  /** 集市等級；0 = 沒有集市 */
  readonly marketLevel: number;
  /** 今天已經轉移出去的量（四種資源合計） */
  readonly transferredToday: number;
  /** 目前掛著的單數 */
  readonly openListings: number;
}

export type TradeRejection =
  | "NO_ALLIANCE"
  | "NOT_SAME_ALLIANCE"
  | "NO_MARKET"
  | "LISTING_LIMIT"
  | "INSUFFICIENT_RESOURCES"
  | "DAILY_CAP"
  | "SAME_RESOURCE"
  | "NON_POSITIVE"
  | "SELF_TRADE"
  | "UNTRADABLE";

/** 資源轉移日上限 = `500 × 主堡等級`（`docs/11` §10） */
export function dailyTransferCap(citadelLevel: number): number {
  return MARKET.dailyTransferPerCitadelLevel * citadelLevel;
}

/** 可掛單數 = `2 × 集市等級`（`docs/11` §3） */
export function listingCap(marketLevel: number): number {
  return marketLevel > 0 ? MARKET.listingsPerLevel * marketLevel : 0;
}

/**
 * 商隊送達所需秒數。
 *
 * v1 不可攔截（`docs/03` §5）—— 所以這只是一段延遲，不是一場賭博。
 * 延遲本身仍然有意義：它讓「臨陣求援」來不及，逼人提前調度。
 */
export function caravanSeconds(distanceTiles: number): number {
  return Math.max(1, Math.round((distanceTiles / MARKET.caravanSpeed) * 3600));
}

/**
 * 掛單。賣方**當下就扣款**，資源進入託管 ——
 * 否則掛十張單再花光資源，承接的人會全部撲空。
 */
export function planListing(
  seller: TraderState,
  offer: { resource: TradeResource; amount: number },
  want: { resource: TradeResource; amount: number },
): { readonly escrow: Amounts } | { readonly reason: TradeRejection } {
  if (seller.allianceId === null) return { reason: "NO_ALLIANCE" };
  if (seller.marketLevel <= 0) return { reason: "NO_MARKET" };
  if (seller.openListings >= listingCap(seller.marketLevel)) return { reason: "LISTING_LIMIT" };
  if (offer.amount <= 0 || want.amount <= 0) return { reason: "NON_POSITIVE" };
  // 同種資源互換沒有意義，而且是繞過日上限的漏洞（A 給 B 100 木換 1 木）
  if (offer.resource === want.resource) return { reason: "SAME_RESOURCE" };
  if (seller.resources[offer.resource] < offer.amount) return { reason: "INSUFFICIENT_RESOURCES" };

  const escrow = zeroAmounts();
  escrow[offer.resource] = offer.amount;
  return { escrow };
}

export interface TradeSettlement {
  /** 買方立刻扣掉的（`want`），與賣方立刻收到的量相同 */
  readonly buyerPays: Amounts;
  /** 賣方之後收到的（商隊送達時入帳） */
  readonly sellerReceives: Amounts;
  /** 買方之後收到的（託管中的 `offer`） */
  readonly buyerReceives: Amounts;
  /** 計入日上限的量：雙方各自算自己送出去的 */
  readonly sellerTransferred: number;
  readonly buyerTransferred: number;
}

/**
 * 承接一張單。
 *
 * ★ 日上限對**雙方**各算一次，而且算的是「送出去的量」。
 *   只算單邊的話，小號互餵只要換個方向掛單就繞過去了。
 */
export function planAccept(
  listing: Listing,
  buyer: TraderState,
  seller: Pick<TraderState, "playerId" | "allianceId" | "citadelLevel" | "transferredToday">,
): TradeSettlement | { readonly reason: TradeRejection } {
  if (buyer.playerId === listing.sellerId) return { reason: "SELF_TRADE" };
  if (buyer.allianceId === null) return { reason: "NO_ALLIANCE" };
  if (buyer.allianceId !== listing.allianceId) return { reason: "NOT_SAME_ALLIANCE" };
  // 賣方中途退盟：單失效。聯盟限定不能靠「掛單當下同盟」就算數
  if (seller.allianceId !== listing.allianceId) return { reason: "NOT_SAME_ALLIANCE" };

  if (buyer.resources[listing.want.resource] < listing.want.amount) {
    return { reason: "INSUFFICIENT_RESOURCES" };
  }

  if (seller.transferredToday + listing.offer.amount > dailyTransferCap(seller.citadelLevel)) {
    return { reason: "DAILY_CAP" };
  }
  if (buyer.transferredToday + listing.want.amount > dailyTransferCap(buyer.citadelLevel)) {
    return { reason: "DAILY_CAP" };
  }

  const buyerPays = zeroAmounts();
  buyerPays[listing.want.resource] = listing.want.amount;

  const sellerReceives = zeroAmounts();
  sellerReceives[listing.want.resource] = listing.want.amount;

  const buyerReceives = zeroAmounts();
  buyerReceives[listing.offer.resource] = listing.offer.amount;

  return {
    buyerPays,
    sellerReceives,
    buyerReceives,
    sellerTransferred: listing.offer.amount,
    buyerTransferred: listing.want.amount,
  };
}

/**
 * 商隊送達時把資源加進去，**受儲存上限約束**。
 *
 * 超出的部分直接蒸發 —— 跟一般溢出一樣（`docs/03` §2.3）。
 * 這也順帶擋掉「拿盟友的倉庫當第二個倉庫」。
 */
export function creditDelivery(
  resources: Amounts,
  delivery: Amounts,
  capacity: number,
): { readonly resources: Amounts; readonly overflow: Amounts } {
  const out = { ...resources };
  const overflow = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    const next = out[r] + delivery[r];
    if (next > capacity) {
      overflow[r] = next - capacity;
      out[r] = capacity;
    } else {
      out[r] = next;
    }
  }
  return { resources: out, overflow };
}

/** 撤單：託管的資源退回（不受日上限影響，因為根本沒轉移出去） */
export function planCancel(
  listing: Listing,
  requesterId: number,
): { readonly refund: Amounts } | { readonly reason: TradeRejection } {
  if (listing.sellerId !== requesterId) return { reason: "SELF_TRADE" };
  const refund = zeroAmounts();
  refund[listing.offer.resource] = listing.offer.amount;
  return { refund };
}

/** UI 用：這張單的匯率（拿一單位 `want` 能換到幾單位 `offer`） */
export function exchangeRate(listing: Listing): number {
  return listing.offer.amount / listing.want.amount;
}
