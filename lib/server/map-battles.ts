/**
 * 地圖上的**烽火與城牆**：兩份公開情報的唯一查詢實作。
 *
 * ★ 為什麼獨立成一支：這兩份資料有**兩個**呼叫端 ——
 *   `/api/map/overview`（開圖那一次，連同地形中繼資料一起給）與
 *   `/api/map/battles`（十幾秒輪詢一次，只給會變的那一份）。
 *   兩邊各寫一份 join 的話，遲早分岔成「總覽說有仗、輪詢說沒有」，
 *   而畫面會在兩者之間閃。這與 `current-player.ts` 是同一條規矩。
 *
 * ★ 公開的只有**位置**。戰報的數字帳目仍然只有當事人看得到
 *   （`docs/09` §12.5：烽火全世界看得到，帳目不是）。
 *   城牆同理 —— 只給三段中的哪一段，不給等級：
 *   一座城牆從外面看得出高矮，看不出差幾級。
 */

import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import { BATTLE_TRACE_WINDOW_MS, SPECTATE_WINDOW_MS } from "@/lib/game/battlefield";
import { keepTier, type KeepTier } from "@/lib/game/keep-icon";

export interface MapBattle {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** 觀戰窗口內（點進去看得到重播） */
  readonly fresh: boolean;
  /** 現在正在打（`docs/04` §3d） */
  readonly live?: boolean;
  /**
   * 這場交戰的結算時刻（毫秒）。
   *
   * ★ 給客戶端是為了讓動畫**自己下架**：交戰只有兩分鐘，
   *   而輪詢是十幾秒一次 —— 等輪詢的話，一場已經打完的仗
   *   還會在地圖上砍十幾秒，而那段時間點進去是沒有現場的。
   */
  readonly endsAt?: number;
}

/**
 * 這一場賽季的烽火：正在打的 + 六小時內的殘跡。
 *
 * ★ 正在打的那幾格排在最前面，而且同一格只留一個標示：
 *   打完的戰場只是情報，正在打的是**還來得及參加**的邀請，
 *   後者必須壓過同一格上的舊戰報。
 */
export async function loadMapBattles(seasonId: number, now: number): Promise<MapBattle[]> {
  const db = getDb();

  const live = await db
    .select({
      id: schema.engagements.id,
      x: schema.engagements.x,
      y: schema.engagements.y,
      endsAt: schema.engagements.endsAt,
    })
    .from(schema.engagements)
    .where(and(eq(schema.engagements.seasonId, seasonId), isNull(schema.engagements.resolvedAt)))
    .limit(200);

  const recent = await db
    .select({
      id: schema.battleReports.id,
      x: schema.battleReports.atX,
      y: schema.battleReports.atY,
      createdAt: schema.battleReports.createdAt,
    })
    .from(schema.battleReports)
    .where(
      and(
        eq(schema.battleReports.seasonId, seasonId),
        gt(schema.battleReports.createdAt, new Date(now - BATTLE_TRACE_WINDOW_MS)),
      ),
    )
    .orderBy(desc(schema.battleReports.createdAt))
    .limit(200);

  const out: MapBattle[] = [];
  const seen = new Set<string>();
  for (const r of live) {
    seen.add(`${r.x},${r.y}`);
    out.push({ id: r.id, x: r.x, y: r.y, fresh: true, live: true, endsAt: r.endsAt.getTime() });
  }
  // 同一格打了好幾場 → 只留最新的一場（recent 已按時間新→舊）
  for (const r of recent) {
    const key = `${r.x},${r.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: r.id,
      x: r.x,
      y: r.y,
      fresh: now - r.createdAt.getTime() <= SPECTATE_WINDOW_MS,
    });
  }
  return out;
}

/**
 * 每座主城的**城牆段**，鍵是核心據點左上角的 `"x,y"`。
 *
 * ★ 出生點清單本身來自地形中繼檔（封盤時寫死的座標），
 *   城牆等級卻是活的 —— 所以這裡回一張查得到就套、查不到就算了的表，
 *   而不是重做一份出生點。開發地圖（`s0`）沒有玩家，回空的即可，
 *   圖示會退回第 1 段（木寨）。
 *
 * ★ 出局的人不算。他的城已經沒了（`leave-season.ts` 釋放領地），
 *   而地圖上還立著一座三段城牆的堡壘是會害人排錯行軍的。
 */
export async function loadKeepWallTiers(seasonId: number): Promise<Map<string, KeepTier>> {
  const rows = await getDb()
    .select({
      x: schema.players.baseX,
      y: schema.players.baseY,
      level: schema.baseSlots.level,
      building: schema.baseSlots.building,
    })
    .from(schema.players)
    .leftJoin(schema.baseSlots, eq(schema.baseSlots.playerId, schema.players.id))
    .where(and(eq(schema.players.seasonId, seasonId), isNull(schema.players.eliminatedAt)));

  const out = new Map<string, KeepTier>();
  for (const row of rows) {
    const key = `${row.x},${row.y}`;
    // 沒有 RAMPART 的人也要進表 —— 「還沒砌牆」與「不在這一場」不一樣
    if (!out.has(key)) out.set(key, keepTier(0));
    if (row.building === "RAMPART") out.set(key, keepTier(row.level ?? 0));
  }
  return out;
}
