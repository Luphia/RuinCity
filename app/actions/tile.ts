"use server";

/**
 * 展開一格：50×50 的戰場視圖要知道這一格上有什麼。
 *
 * ★ 迷霧規則跟著現有的授權走：
 *   - 自己的據點 → 看得到駐軍與建築配置
 *   - 敵人的據點 → 只看得到「有一座城」，守軍不可見（要知道就派偵查）
 *   - 這一格的戰鬥 → 只有當事人看得到（與戰報同一條規則）
 */

import { and, desc, eq, gt, or } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { parseArmy, type Army } from "@/lib/game/army";
import { SPECTATE_WINDOW_MS } from "@/lib/game/battlefield";
import { STRUCTURE } from "@/lib/game/balance";
import { currentHp, maxHpOf } from "@/lib/game/structures";
import type { SceneSlot } from "@/lib/game/citadel";
import { serverNow } from "@/lib/time";

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
  /**
   * 領地建物（`docs/02` §2.6）。據點那一格是 null —— 據點畫的是城。
   * 這是**顯示用**的快照；耐久的真相在伺服器，攻擊時重算。
   */
  readonly structure: {
    readonly kind: "FLAG" | "TOWER";
    readonly label: string;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    /** 這一格是不是我的 */
    readonly mine: boolean;
    /** 誰都沒佔的野地 */
    readonly unclaimed: boolean;
  } | null;
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

  // 這一格的領地狀態（不是據點才有意義）
  const [tile] = await db
    .select({
      playerId: schema.tiles.playerId,
      facility: schema.tiles.facility,
      facilityLevel: schema.tiles.facilityLevel,
      kind: schema.tiles.kind,
      structureHp: schema.tiles.structureHp,
      structureHitAt: schema.tiles.structureHitAt,
    })
    .from(schema.tiles)
    .where(and(eq(schema.tiles.seasonId, me.seasonId), eq(schema.tiles.x, x), eq(schema.tiles.y, y)))
    .limit(1);

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

  // 這一格最近一場看得到的戰鬥:我參與的任何時候都看得到;
  // 別人的只在觀戰窗口內公開(地圖上的交戰標示點進來)
  const now = await serverNow();
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
          gt(schema.battleReports.createdAt, new Date(now - SPECTATE_WINDOW_MS)),
        ),
      ),
    )
    .orderBy(desc(schema.battleReports.createdAt))
    .limit(1);

  /**
   * ★ 領地建物：無主的野地也畫一面旗（灰的）——
   *   玩家要看得出「這一格能不能佔」，而不是只有一片草。
   */
  const isTerritory = ownerId === null;
  const kind = tile?.facility === "FORTRESS" ? ("TOWER" as const) : ("FLAG" as const);
  const level = kind === "TOWER" ? (tile?.facilityLevel ?? 0) : 0;
  const structure = isTerritory
    ? {
        kind,
        label: STRUCTURE[kind].label,
        level,
        hp: currentHp(
          kind,
          level,
          {
            hp: tile?.structureHp ?? null,
            hitAt: tile?.structureHitAt ? tile.structureHitAt.getTime() : null,
          },
          now,
        ),
        maxHp: maxHpOf(kind, level),
        mine: tile?.playerId === me.playerId,
        unclaimed: !tile || tile.playerId === null,
      }
    : null;

  return {
    x,
    y,
    hasBase: ownerId !== null,
    isMine,
    garrison,
    slots,
    latestBattleId: report?.id ?? null,
    structure,
  };
}
