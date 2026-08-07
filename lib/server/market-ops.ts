import "server-only";

/**
 * 集市操作的**共用核心**。
 *
 * ★ 與 `base-ops.ts` 同一個理由：Server Action 的第一件事是從 session
 *   解出「我是誰」，而非人類的行動者沒有 session。
 *   AI 玩家（`docs/15`）是完整的玩家，它們會交易 ——
 *   執政官不會，那是 `18` §2 明列的禁區。
 *
 * ★ 交易是**最值得被作弊的地方**：它把資源從一個帳號搬到另一個。
 *   所以每一項都在這裡重新驗證 —— 聯盟關係、集市等級、掛單數、
 *   日轉移上限、託管餘額。呼叫端送上來的只有 listing id 與數量。
 */

import { and, eq, sql } from "drizzle-orm";

import { RESOURCES, type Resource } from "@/lib/game/balance";
import { toGameDate } from "@/lib/game/calendar";
import {
  caravanSeconds,
  dailyTransferCap,
  isTradable,
  listingCap,
  planAccept,
  planCancel,
  planListing,
  type Listing,
  type TradeResource,
  type TraderState,
} from "@/lib/game/market";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { scheduleEvent, settleWithin } from "@/lib/server/player-state";

export interface MarketResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly listingId?: number;
  readonly arrivesAt?: number;
}

const num = (v: string | number | null | undefined) => Number(v ?? 0);

export function parseTradeResource(v: string): TradeResource | null {
  if (!RESOURCES.includes(v as Resource)) return null;
  const r = v as Resource;
  return isTradable(r) ? r : null;
}

/**
 * 組出純函式要的交易者狀態。
 *
 * 集市**等級**要從領土格上找 —— 集市是一座設施而不是核心建築，
 * 而且每位玩家上限一座（`docs/02` §3）。
 */
async function traderStateOf(
  tx: TxDb,
  state: Awaited<ReturnType<typeof settleWithin>>,
  now: number,
): Promise<TraderState> {
  const [membership] = await tx
    .select({ allianceId: schema.allianceMembers.allianceId })
    .from(schema.allianceMembers)
    .where(eq(schema.allianceMembers.playerId, state.playerId))
    .limit(1);

  // 孤立的集市不算數 —— 那格連不回據點
  const marketTile = state.tiles.find((t) => t.facility === "MARKET" && t.state !== "ISOLATED");

  const [open] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.marketListings)
    .where(
      and(
        eq(schema.marketListings.sellerId, state.playerId),
        eq(schema.marketListings.status, "OPEN"),
      ),
    );

  const gameMonth = toGameDate(state.seasonStartedAt, now).month;
  const [transferred] = await tx
    .select({ amount: schema.marketTransfers.amount })
    .from(schema.marketTransfers)
    .where(
      and(
        eq(schema.marketTransfers.playerId, state.playerId),
        eq(schema.marketTransfers.gameMonth, gameMonth),
      ),
    );

  return {
    playerId: state.playerId,
    allianceId: membership?.allianceId ?? null,
    citadelLevel: state.build.citadel,
    resources: state.economy.resources,
    capacity: state.economy.capacity,
    marketLevel: marketTile?.facilityLevel ?? 0,
    transferredToday: num(transferred?.amount),
    openListings: open?.n ?? 0,
  };
}

async function addTransfer(tx: TxDb, playerId: number, gameMonth: number, amount: number) {
  await tx
    .insert(schema.marketTransfers)
    .values({ playerId, gameMonth, amount: String(amount) })
    .onConflictDoUpdate({
      target: [schema.marketTransfers.playerId, schema.marketTransfers.gameMonth],
      set: { amount: sql`${schema.marketTransfers.amount} + ${String(amount)}` },
    });
}

/** 掛一張單。賣方**當下就扣款**，資源進入託管 */
export async function createListingFor(
  tx: TxDb,
  playerId: number,
  offerResource: string,
  offerAmount: number,
  wantResource: string,
  wantAmount: number,
  now: number,
): Promise<MarketResult> {
  const offer = parseTradeResource(offerResource);
  const want = parseTradeResource(wantResource);
  if (!offer || !want) return { ok: false, reason: "UNTRADABLE" };
  if (!Number.isFinite(offerAmount) || !Number.isFinite(wantAmount)) {
    return { ok: false, reason: "NON_POSITIVE" };
  }

  const amountOffered = Math.floor(offerAmount);
  const amountWanted = Math.floor(wantAmount);

  const state = await settleWithin(tx, playerId, now);
  const trader = await traderStateOf(tx, state, now);

  const plan = planListing(
    trader,
    { resource: offer, amount: amountOffered },
    { resource: want, amount: amountWanted },
  );
  if ("reason" in plan) return { ok: false, reason: plan.reason };

  await tx
    .update(schema.playerResources)
    .set({ [offer]: String(trader.resources[offer] - amountOffered) })
    .where(eq(schema.playerResources.playerId, playerId));

  const [row] = await tx
    .insert(schema.marketListings)
    .values({
      seasonId: state.seasonId,
      sellerId: playerId,
      allianceId: trader.allianceId!,
      offerResource: offer,
      offerAmount: String(amountOffered),
      wantResource: want,
      wantAmount: String(amountWanted),
    })
    .returning({ id: schema.marketListings.id });

  return { ok: true, listingId: row?.id };
}

/** 承接一張單。雙方的資源都走商隊，由 `MARKET_DELIVERY` 事件送達 */
export async function acceptListingFor(
  tx: TxDb,
  buyerId: number,
  listingId: number,
  now: number,
): Promise<MarketResult> {
  /**
   * ★ 先鎖單再讀狀態。兩個人同時按下「承接」時，第二個人必須看到
   *   `TAKEN` —— 少了 `FOR UPDATE`，兩邊都會讀到 `OPEN`，
   *   而賣方只有一份託管。
   */
  const [row] = await tx
    .select()
    .from(schema.marketListings)
    .where(and(eq(schema.marketListings.id, listingId), eq(schema.marketListings.status, "OPEN")))
    .for("update");
  if (!row) return { ok: false, reason: "LISTING_GONE" };

  const offer = parseTradeResource(row.offerResource);
  const want = parseTradeResource(row.wantResource);
  if (!offer || !want) return { ok: false, reason: "UNTRADABLE" };

  const buyerState = await settleWithin(tx, buyerId, now);
  const buyer = await traderStateOf(tx, buyerState, now);
  const sellerState = await settleWithin(tx, row.sellerId, now);
  const seller = await traderStateOf(tx, sellerState, now);

  const listing: Listing = {
    id: row.id,
    sellerId: row.sellerId,
    allianceId: row.allianceId,
    offer: { resource: offer, amount: num(row.offerAmount) },
    want: { resource: want, amount: num(row.wantAmount) },
    createdAt: row.createdAt.getTime(),
  };

  const settlement = planAccept(listing, buyer, seller);
  if ("reason" in settlement) return { ok: false, reason: settlement.reason };

  // 買方立刻扣款；託管的 offer 早就從賣方身上扣掉了
  await tx
    .update(schema.playerResources)
    .set({ [want]: String(buyer.resources[want] - listing.want.amount) })
    .where(eq(schema.playerResources.playerId, buyerId));

  const gameMonth = toGameDate(buyerState.seasonStartedAt, now).month;
  await addTransfer(tx, row.sellerId, gameMonth, settlement.sellerTransferred);
  await addTransfer(tx, buyerId, gameMonth, settlement.buyerTransferred);

  await tx
    .update(schema.marketListings)
    .set({ status: "TAKEN", buyerId, closedAt: new Date(now) })
    .where(eq(schema.marketListings.id, listingId));

  // 商隊：v1 不可攔截（`docs/03` §5），所以這只是一段延遲，不是一場賭博
  const distance =
    Math.abs(buyerState.baseX - sellerState.baseX) + Math.abs(buyerState.baseY - sellerState.baseY);
  const arrivesAt = now + caravanSeconds(distance) * 1000;

  for (const [to, delivery] of [
    [row.sellerId, settlement.sellerReceives],
    [buyerId, settlement.buyerReceives],
  ] as const) {
    await scheduleEvent(tx, {
      seasonId: buyerState.seasonId,
      type: "MARKET_DELIVERY",
      actorId: to,
      payload: { kind: "DELIVERY", listingId, amounts: delivery },
      resolveAt: arrivesAt,
    });
  }

  return { ok: true, arrivesAt };
}

/** 撤單，託管退回 */
export async function cancelListingFor(
  tx: TxDb,
  playerId: number,
  listingId: number,
  now: number,
): Promise<MarketResult> {
  const [row] = await tx
    .select()
    .from(schema.marketListings)
    .where(and(eq(schema.marketListings.id, listingId), eq(schema.marketListings.status, "OPEN")))
    .for("update");
  if (!row) return { ok: false, reason: "LISTING_GONE" };

  const offer = parseTradeResource(row.offerResource);
  const want = parseTradeResource(row.wantResource);
  if (!offer || !want) return { ok: false, reason: "UNTRADABLE" };

  const state = await settleWithin(tx, playerId, now);
  const plan = planCancel(
    {
      id: row.id,
      sellerId: row.sellerId,
      allianceId: row.allianceId,
      offer: { resource: offer, amount: num(row.offerAmount) },
      want: { resource: want, amount: num(row.wantAmount) },
      createdAt: row.createdAt.getTime(),
    },
    playerId,
  );
  if ("reason" in plan) return { ok: false, reason: plan.reason };

  // 退款受儲存上限約束 —— 掛單期間產出可能已經把倉庫塞滿了
  const refunded = Math.min(
    state.economy.capacity,
    state.economy.resources[offer] + plan.refund[offer],
  );
  await tx
    .update(schema.playerResources)
    .set({ [offer]: String(refunded) })
    .where(eq(schema.playerResources.playerId, playerId));

  await tx
    .update(schema.marketListings)
    .set({ status: "CANCELLED", closedAt: new Date(now) })
    .where(eq(schema.marketListings.id, listingId));

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 看板
// ─────────────────────────────────────────────────────────────

export interface ListingView {
  readonly id: number;
  readonly sellerId: number;
  readonly mine: boolean;
  readonly offer: { readonly resource: TradeResource; readonly amount: number };
  readonly want: { readonly resource: TradeResource; readonly amount: number };
  readonly rate: number;
}

export interface MarketBoard {
  readonly listings: readonly ListingView[];
  readonly allianceId: number | null;
  readonly marketLevel: number;
  readonly listingCap: number;
  readonly transferredToday: number;
  readonly dailyCap: number;
}

/** 聯盟的掛單看板。無聯盟者看到空的 —— 他們本來就不能交易 */
export async function loadBoardFor(
  tx: TxDb,
  playerId: number,
  now: number,
): Promise<MarketBoard> {
  const state = await settleWithin(tx, playerId, now);
  const trader = await traderStateOf(tx, state, now);

  if (trader.allianceId === null) {
    return {
      listings: [],
      allianceId: null,
      marketLevel: trader.marketLevel,
      listingCap: 0,
      transferredToday: trader.transferredToday,
      dailyCap: dailyTransferCap(trader.citadelLevel),
    };
  }

  const rows = await tx
    .select()
    .from(schema.marketListings)
    .where(
      and(
        eq(schema.marketListings.seasonId, state.seasonId),
        eq(schema.marketListings.allianceId, trader.allianceId),
        // 自己的單也看得到（才能撤），但已成交／已撤的不列
        eq(schema.marketListings.status, "OPEN"),
      ),
    );

  const listings: ListingView[] = rows.flatMap((r) => {
    const offer = parseTradeResource(r.offerResource);
    const want = parseTradeResource(r.wantResource);
    if (!offer || !want) return [];
    const offerAmount = num(r.offerAmount);
    const wantAmount = num(r.wantAmount);
    return [
      {
        id: r.id,
        sellerId: r.sellerId,
        mine: r.sellerId === playerId,
        offer: { resource: offer, amount: offerAmount },
        want: { resource: want, amount: wantAmount },
        rate: wantAmount > 0 ? offerAmount / wantAmount : 0,
      },
    ];
  });

  return {
    listings,
    allianceId: trader.allianceId,
    marketLevel: trader.marketLevel,
    listingCap: listingCap(trader.marketLevel),
    transferredToday: trader.transferredToday,
    dailyCap: dailyTransferCap(trader.citadelLevel),
  };
}
