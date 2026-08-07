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

  let meta: Record<string, unknown>;
  let resolved = seasonId;
  try {
    meta = await load(seasonId);
  } catch {
    /**
     * 這一場的地形還沒寫出來（封盤前，或寫檔失敗）。退回開發地圖，
     * 但**要讓呼叫端知道這不是你那一局的地圖** —— 靜默地換一張圖比
     * 顯示錯誤更糟。
     */
    if (explicit || seasonId === FALLBACK_SEASON) {
      return NextResponse.json(
        { error: `賽季 ${seasonId} 的地形尚未生成，執行 pnpm map:generate` },
        { status: 404 },
      );
    }
    try {
      meta = await load(FALLBACK_SEASON);
      resolved = FALLBACK_SEASON;
    } catch {
      return NextResponse.json(
        { error: `賽季 ${seasonId} 的地形尚未生成，執行 pnpm map:generate` },
        { status: 404 },
      );
    }
  }
  const isFallback = resolved !== seasonId;

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
      chunkBaseUrl: `/terrain/${resolved}`,
      terrainCodes: meta.terrainCodes,
      ruins: meta.ruins,
      areas: meta.areas,
      fairness: meta.fairness,
      spawns: meta.spawns,
    },
    {
      headers: {
        // 地形檔本身走長期快取；這份中繼資料會隨賽季換人，只快取一分鐘
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
