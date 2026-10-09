/**
 * 世界地圖：一個經緯度範圍裡**有人捐過款**的區塊（粗狀態）。
 * 範圍太大就不回格子 —— 地圖縮到整個亞洲時不該掃整張表。
 */

import { NextResponse } from "next/server";

import { blocksInRange } from "@/lib/server/blocks";
import { db } from "@/lib/server/runtime";
import { BLOCKS_PER_DEGREE, COLS, blockBounds, blockOf } from "@/lib/world/grid";

export const dynamic = "force-dynamic";

/** 超過這個跨度（度）就不回區塊 */
const MAX_SPAN_DEG = 3;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const south = Number(q.get("south"));
  const north = Number(q.get("north"));
  const west = Number(q.get("west"));
  const east = Number(q.get("east"));
  if (![south, north, west, east].every(Number.isFinite) || north < south) {
    return NextResponse.json({ error: "bad bounds" }, { status: 400 });
  }
  const lngSpan = east >= west ? east - west : 360 - west + east;
  if (north - south > MAX_SPAN_DEG || lngSpan > MAX_SPAN_DEG) {
    return NextResponse.json({ tooWide: true, blocks: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const sw = blockOf({ lat: south, lng: west });
  const ne = blockOf({ lat: north, lng: east });
  // 跨換日線時拆成兩段
  const ranges =
    ne.col >= sw.col
      ? [{ colMin: sw.col, colMax: ne.col }]
      : [
          { colMin: sw.col, colMax: COLS - 1 },
          { colMin: 0, colMax: ne.col },
        ];
  try {
    const found = (
      await Promise.all(ranges.map((r) => blocksInRange(db(), { rowMin: sw.row, rowMax: ne.row, ...r })))
    ).flat();
    return NextResponse.json(
      {
        tooWide: false,
        blocksPerDegree: BLOCKS_PER_DEGREE,
        blocks: found.map((b) => ({ ...b, bounds: blockBounds(b) })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[api/blocks]", e);
    return NextResponse.json({ error: "資料庫無法連線" }, { status: 503 });
  }
}
