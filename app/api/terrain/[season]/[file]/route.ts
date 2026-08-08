import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { schema } from "@/lib/db";

/**
 * 地形檔的資料庫出口。
 *
 * 磁碟上有檔時走 `/terrain/...` 靜態路徑（CDN）；這條路由是給
 * **檔案系統會蒸發的環境**（serverless 的新實例）—— `terrain_files`
 * 是地形的真相，這裡把它端出來，快取條件與靜態檔相同：
 * 地形在賽季內永不改變，所以 immutable。
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ season: string; file: string }> },
) {
  const { season, file } = await params;
  const seasonId = /^s(\d{1,9})$/.exec(season)?.[1];
  if (!seasonId || !/^(meta\.json|\d{1,3}_\d{1,3}\.bin)$/.test(file)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const { getDb } = await import("@/lib/db");
    const [row] = await getDb()
      .select({ data: schema.terrainFiles.data })
      .from(schema.terrainFiles)
      .where(
        and(
          eq(schema.terrainFiles.seasonId, Number(seasonId)),
          eq(schema.terrainFiles.name, file),
        ),
      )
      .limit(1);
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    return new NextResponse(Buffer.from(row.data), {
      headers: {
        "Content-Type": file.endsWith(".json") ? "application/json" : "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    // 沒有資料庫的環境（E2E、預覽）
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
