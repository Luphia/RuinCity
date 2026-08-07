"use server";

/**
 * 展開一格：50×50 的戰場視圖要知道這一格上有什麼。
 *
 * ★ 迷霧規則跟著現有的授權走：
 *   - 自己的據點 → 看得到駐軍與建築配置
 *   - 敵人的據點 → 只看得到「有一座城」，守軍不可見（要知道就派偵查）
 *   - 這一格的戰鬥 → 只有當事人看得到（與戰報同一條規則）
 */

import { and, desc, eq, or } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { parseArmy, type Army } from "@/lib/game/army";
import type { SceneSlot } from "@/lib/game/citadel";

export interface TileScene {
  readonly x: number;
  readonly y: number;
  readonly hasBase: boolean;
  readonly isMine: boolean;
  /** 只有自己的據點才有 */
  readonly garrison: Army;
  readonly slots: readonly SceneSlot[] | null;
  /** 這一格最近一場我參與的戰鬥；null = 沒打過或看不到 */
  readonly latestBattleId: number | null;
}

async function viewer(): Promise<{ playerId: number; seasonId: number } | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;

  const { getDb } = await import("@/lib/db");
  const [row] = await getDb()
    .select({ playerId: schema.players.id, seasonId: schema.players.seasonId })
    .from(schema.players)
    .innerJoin(schema.users, eq(schema.players.userId, schema.users.id))
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(and(eq(schema.users.email, email), eq(schema.seasons.status, "RUNNING")))
    .limit(1);
  return row ?? null;
}

export async function loadTileScene(x: number, y: number): Promise<TileScene | null> {
  const me = await viewer();
  if (!me) return null;

  const { getDb } = await import("@/lib/db");
  const db = getDb();

  // 這一格是不是某座據點的核心（2×2 的任何一格都算那座城）
  const [core] = await db
    .select({ playerId: schema.tiles.playerId })
    .from(schema.tiles)
    .where(
      and(
        eq(schema.tiles.seasonId, me.seasonId),
        eq(schema.tiles.x, x),
        eq(schema.tiles.y, y),
        eq(schema.tiles.kind, "BASE_CORE"),
      ),
    )
    .limit(1);

  const ownerId = core?.playerId ?? null;
  const isMine = ownerId === me.playerId;

  let garrison: Army = {};
  let slots: SceneSlot[] | null = null;

  if (isMine) {
    const [player] = await db
      .select({ citadelLevel: schema.players.citadelLevel, baseX: schema.players.baseX, baseY: schema.players.baseY })
      .from(schema.players)
      .where(eq(schema.players.id, me.playerId));

    const [g] = await db
      .select({ units: schema.garrisons.units })
      .from(schema.garrisons)
      .where(
        and(
          eq(schema.garrisons.seasonId, me.seasonId),
          eq(schema.garrisons.ownerId, me.playerId),
          eq(schema.garrisons.atX, player?.baseX ?? x),
          eq(schema.garrisons.atY, player?.baseY ?? y),
        ),
      )
      .limit(1);
    garrison = parseArmy(g?.units ?? {});

    const slotRows = await db
      .select()
      .from(schema.baseSlots)
      .where(eq(schema.baseSlots.playerId, me.playerId));

    slots = [
      { slot: "A", building: "CITADEL", level: player?.citadelLevel ?? 1, busy: false },
      ...(["B", "C", "D"] as const).map((slot): SceneSlot => {
        const row = slotRows.find((r) => r.slot === slot);
        return {
          slot,
          building: (row?.building ?? null) as SceneSlot["building"],
          level: row?.level ?? 0,
          busy: false,
        };
      }),
    ];
  }

  // 這一格最近一場我參與的戰鬥
  const [report] = await db
    .select({ id: schema.battleReports.id })
    .from(schema.battleReports)
    .where(
      and(
        eq(schema.battleReports.seasonId, me.seasonId),
        eq(schema.battleReports.atX, x),
        eq(schema.battleReports.atY, y),
        or(
          eq(schema.battleReports.attackerId, me.playerId),
          eq(schema.battleReports.defenderId, me.playerId),
        ),
      ),
    )
    .orderBy(desc(schema.battleReports.createdAt))
    .limit(1);

  return {
    x,
    y,
    hasBase: ownerId !== null,
    isMine,
    garrison,
    slots,
    latestBattleId: report?.id ?? null,
  };
}
