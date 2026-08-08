"use server";

/**
 * 地圖的個人圖層：我的據點、我的領土、我在路上的部隊。
 *
 * ★ 只回**自己的**東西。別人的領土與行軍是迷霧的一部分 ——
 *   來襲預警有自己的規則（`warningVisibleAt`），走 /war 的預警列表，
 *   不在這裡（見 docs/09 §12 的取捨）。
 *
 * ★ 回傳 null = 沒登入或沒有進行中的賽季（正常狀態，地圖照常顯示，
 *   只是沒有個人圖層）。
 */

import { and, eq } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { serverNow } from "@/lib/time";

export interface MyMarch {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly departedAt: number;
  readonly arrivesAt: number;
  readonly type: string;
}

export interface MapOverlay {
  readonly serverTime: number;
  readonly base: { readonly x: number; readonly y: number };
  readonly tiles: readonly { readonly x: number; readonly y: number }[];
  readonly marches: readonly MyMarch[];
}

export async function loadMyMapOverlay(): Promise<MapOverlay | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;

  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const [me] = await db
    .select({
      playerId: schema.players.id,
      seasonId: schema.players.seasonId,
      baseX: schema.players.baseX,
      baseY: schema.players.baseY,
    })
    .from(schema.players)
    .innerJoin(schema.users, eq(schema.players.userId, schema.users.id))
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(and(eq(schema.users.email, email), eq(schema.seasons.status, "RUNNING")))
    .limit(1);
  if (!me) return null;

  const tiles = await db
    .select({ x: schema.tiles.x, y: schema.tiles.y })
    .from(schema.tiles)
    .where(and(eq(schema.tiles.seasonId, me.seasonId), eq(schema.tiles.playerId, me.playerId)));

  const marches = await db
    .select({
      fromX: schema.marches.fromX,
      fromY: schema.marches.fromY,
      toX: schema.marches.toX,
      toY: schema.marches.toY,
      departedAt: schema.marches.departedAt,
      arrivesAt: schema.marches.arrivesAt,
      type: schema.marches.type,
    })
    .from(schema.marches)
    .where(
      and(
        eq(schema.marches.seasonId, me.seasonId),
        eq(schema.marches.ownerId, me.playerId),
        eq(schema.marches.status, "IN_TRANSIT"),
      ),
    );

  return {
    serverTime: await serverNow(),
    base: { x: me.baseX, y: me.baseY },
    tiles,
    marches: marches.map((m) => ({
      ...m,
      departedAt: m.departedAt.getTime(),
      arrivesAt: m.arrivesAt.getTime(),
    })),
  };
}
