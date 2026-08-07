"use server";

/**
 * 集市的 Server Actions。
 *
 * ★ 這裡只做兩件事：解析「我是誰」，然後把工作交給
 *   `lib/server/market-ops.ts` —— 那是唯一的驗證路徑，
 *   AI 玩家之後也走同一條（與 `base-ops.ts` 同一個結構）。
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import {
  acceptListingFor,
  cancelListingFor,
  createListingFor,
  loadBoardFor,
  type MarketBoard,
  type MarketResult,
} from "@/lib/server/market-ops";
import { serverNow } from "@/lib/time";

export type { ListingView, MarketBoard, MarketResult } from "@/lib/server/market-ops";

async function currentPlayerId(): Promise<number> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error("UNAUTHENTICATED");

  const { getDb } = await import("@/lib/db");
  const [row] = await getDb()
    .select({ playerId: schema.players.id })
    .from(schema.players)
    .innerJoin(schema.users, eq(schema.players.userId, schema.users.id))
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(and(eq(schema.users.email, email), eq(schema.seasons.status, "RUNNING")))
    .limit(1);

  if (!row) throw new Error("NO_PLAYER");
  return row.playerId;
}

/** 掛一張單。賣方當下扣款，資源進入託管 */
export async function createListing(
  offerResource: string,
  offerAmount: number,
  wantResource: string,
  wantAmount: number,
): Promise<MarketResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction((tx) =>
    createListingFor(tx, playerId, offerResource, offerAmount, wantResource, wantAmount, now),
  );
  if (result.ok) revalidatePath("/market");
  return result;
}

/** 承接一張單 */
export async function acceptListing(listingId: number): Promise<MarketResult> {
  const buyerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction((tx) => acceptListingFor(tx, buyerId, listingId, now));
  if (result.ok) revalidatePath("/market");
  return result;
}

/** 撤單，託管退回 */
export async function cancelListing(listingId: number): Promise<MarketResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction((tx) => cancelListingFor(tx, playerId, listingId, now));
  if (result.ok) revalidatePath("/market");
  return result;
}

/** 聯盟的掛單看板 */
export async function loadBoard(): Promise<MarketBoard> {
  const playerId = await currentPlayerId();
  const now = await serverNow();
  return withTransaction((tx) => loadBoardFor(tx, playerId, now));
}
