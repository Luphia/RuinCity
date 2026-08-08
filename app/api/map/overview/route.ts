/**
 * 地圖總覽：賽季的靜態世界資料。
 *
 * 地形 chunk 本身是靜態檔（`/terrain/{seasonId}/{cx}_{cy}.bin`，見 `docs/01` §3.2），
 * 走 CDN 長期快取，不經過這個路由。這裡只回傳「一次就夠」的中繼資料：
 * 三座遺跡、陣營面積、公平性驗證數字、以及出生點。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { MAP } from "@/lib/game/balance";
import { BATTLE_TRACE_WINDOW_MS, SPECTATE_WINDOW_MS } from "@/lib/game/battlefield";
import { CHUNK_COLS, CHUNK_ROWS, CHUNK_SIZE } from "@/lib/render/chunks";

/** `pnpm map:generate` 產的開發地圖。沒有真實賽季時的退路 */
const FALLBACK_SEASON = "s0";

/**
 * ★ 不能寫死 `s0`。
 *
 * M5b 之後每一場賽季都有自己的 seed 與自己的地形檔（封盤期寫出，
 * 見 `lib/server/terrain-files.ts`）。指著 `s0` 的話，玩家在 `/map` 看到的是
 * 一張跟自己那一局完全無關的地圖 —— 連自己的據點都不在上面，
 * 而且畫面上不會有任何跡象顯示看錯了。
 */
async function resolveSeason(explicit: string | null): Promise<string> {
  if (explicit) return explicit;
  try {
    const { getDb, schema } = await import("@/lib/db");
    const { desc, ne } = await import("drizzle-orm");
    const [row] = await getDb()
      .select({ id: schema.seasons.id })
      .from(schema.seasons)
      .where(ne(schema.seasons.status, "ARCHIVED"))
      .orderBy(desc(schema.seasons.id))
      .limit(1);
    if (row) return `s${row.id}`;
  } catch {
    // 沒有資料庫的環境（E2E、預覽）就用開發地圖
  }
  return FALLBACK_SEASON;
}

/** 每次請求都要問資料庫「現在是哪一場」，所以不能整路由靜態化 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const explicit = new URL(request.url).searchParams.get("season");
  const seasonId = await resolveSeason(explicit);
  if (!/^[a-z0-9-]{1,32}$/.test(seasonId)) {
    return NextResponse.json({ error: "invalid season id" }, { status: 400 });
  }

  const load = async (id: string) => {
    const raw = await readFile(join(process.cwd(), "public", "terrain", id, "meta.json"));
    return JSON.parse(raw.toString()) as Record<string, unknown>;
  };

  let meta: Record<string, unknown> | null = null;
  let resolved = seasonId;
  let chunkBaseUrl = `/terrain/${seasonId}`;
  try {
    meta = await load(seasonId);
  } catch {
    /**
     * 磁碟上沒有（新實例、唯讀檔案系統）→ 問資料庫。
     * `terrain_files` 是地形的真相（封盤時入庫，啟動時 `ensureLatestTerrain`
     * 會補磁碟快取）；還在補的空窗期，chunk 直接走 `/api/terrain`。
     */
    try {
      const numeric = /^s(\d+)$/.exec(seasonId)?.[1];
      if (numeric) {
        const { getDb, schema } = await import("@/lib/db");
        const { and, eq } = await import("drizzle-orm");
        const [row] = await getDb()
          .select({ data: schema.terrainFiles.data })
          .from(schema.terrainFiles)
          .where(
            and(
              eq(schema.terrainFiles.seasonId, Number(numeric)),
              eq(schema.terrainFiles.name, "meta.json"),
            ),
          )
          .limit(1);
        if (row) {
          meta = JSON.parse(Buffer.from(row.data).toString()) as Record<string, unknown>;
          chunkBaseUrl = `/api/terrain/${seasonId}`;
        }
      }
    } catch {
      // 沒有資料庫的環境（E2E、預覽）—— 往下走磁碟的退路
    }

    /**
     * 資料庫也沒有 → 退回開發地圖，但**要讓呼叫端知道這不是你那一局
     * 的地圖** —— 靜默地換一張圖比顯示錯誤更糟。
     */
    if (!meta) {
      if (explicit || seasonId === FALLBACK_SEASON) {
        return NextResponse.json(
          { error: `賽季 ${seasonId} 的地形尚未生成，執行 pnpm map:generate` },
          { status: 404 },
        );
      }
      try {
        meta = await load(FALLBACK_SEASON);
        resolved = FALLBACK_SEASON;
        chunkBaseUrl = `/terrain/${FALLBACK_SEASON}`;
      } catch {
        return NextResponse.json(
          { error: `賽季 ${seasonId} 的地形尚未生成，執行 pnpm map:generate` },
          { status: 404 },
        );
      }
    }
  }
  const isFallback = resolved !== seasonId;

  /**
   * ★ 交戰標示:戰鬥地點全賽季公開(烽火全世界看得到)。
   *   `fresh` = 還在觀戰窗口內(脈動紅 ✕、點進去可以看重播);
   *   窗口過了的殘跡再留 6 小時 —— 「這一帶最近打得兇」本身就是
   *   值得繞路的情報。只給座標與戰報 id,數字帳目仍然只有當事人看得到。
   */
  let battles: { id: number; x: number; y: number; fresh: boolean }[] = [];
  const numericSeason = /^s(\d+)$/.exec(seasonId)?.[1];
  if (numericSeason) {
    try {
      const { getDb, schema } = await import("@/lib/db");
      const { and, desc, eq, gt } = await import("drizzle-orm");
      const { serverNow } = await import("@/lib/time");
      const now = await serverNow();
      const rows = await getDb()
        .select({
          id: schema.battleReports.id,
          x: schema.battleReports.atX,
          y: schema.battleReports.atY,
          createdAt: schema.battleReports.createdAt,
        })
        .from(schema.battleReports)
        .where(
          and(
            eq(schema.battleReports.seasonId, Number(numericSeason)),
            gt(schema.battleReports.createdAt, new Date(now - BATTLE_TRACE_WINDOW_MS)),
          ),
        )
        .orderBy(desc(schema.battleReports.createdAt))
        .limit(200);
      // 同一格打了好幾場 → 只留最新的一場(rows 已按時間新→舊)
      const seen = new Set<string>();
      for (const r of rows) {
        const key = `${r.x},${r.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        battles.push({
          id: r.id,
          x: r.x,
          y: r.y,
          fresh: now - r.createdAt.getTime() <= SPECTATE_WINDOW_MS,
        });
      }
    } catch {
      battles = []; // 沒有資料庫的環境(E2E、預覽)就沒有烽火
    }
  }

  return NextResponse.json(
    {
      seasonId: resolved,
      /** true = 這不是你那一局的地圖，是開發用的替代品 */
      isFallback,
      requestedSeason: seasonId,
      seed: meta.seed,
      width: MAP.width,
      height: MAP.height,
      chunk: { size: CHUNK_SIZE, cols: CHUNK_COLS, rows: CHUNK_ROWS },
      chunkBaseUrl,
      terrainCodes: meta.terrainCodes,
      ruins: meta.ruins,
      areas: meta.areas,
      fairness: meta.fairness,
      spawns: meta.spawns,
      battles,
    },
    {
      headers: {
        // 地形檔本身走長期快取；這份中繼資料會隨賽季換人，只快取一分鐘
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
