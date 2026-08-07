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

/** M2 之前只有一個開發用賽季 */
const DEFAULT_SEASON = "s0";

export const revalidate = 3600;

export async function GET(request: Request) {
  const seasonId = new URL(request.url).searchParams.get("season") ?? DEFAULT_SEASON;
  if (!/^[a-z0-9-]{1,32}$/.test(seasonId)) {
    return NextResponse.json({ error: "invalid season id" }, { status: 400 });
  }

  let meta: Record<string, unknown>;
  try {
    const raw = await readFile(join(process.cwd(), "public", "terrain", seasonId, "meta.json"));
    meta = JSON.parse(raw.toString()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: `賽季 ${seasonId} 的地形尚未生成，執行 pnpm map:generate` },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      seasonId,
      seed: meta.seed,
      width: MAP.width,
      height: MAP.height,
      chunk: { size: CHUNK_SIZE, cols: CHUNK_COLS, rows: CHUNK_ROWS },
      chunkBaseUrl: `/terrain/${seasonId}`,
      terrainCodes: meta.terrainCodes,
      ruins: meta.ruins,
      areas: meta.areas,
      fairness: meta.fairness,
      spawns: meta.spawns,
    },
    { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
  );
}
