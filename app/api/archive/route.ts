/**
 * 整個世界的保存索引：每一塊的場景包 CID、Boltchain 委託索引 CID 與生效中的委託。
 *
 * 這是唯一會變的東西（每完成一塊就多一列）；它指向的每一個場景包都是不可變的。
 * 有了這份清單，就能從任何 Boltchain 節點把整個世界取回來。
 */

import { NextResponse } from "next/server";

import { archiveIndex } from "@/lib/server/archive";
import { db } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!process.env.DATABASE_URL) return NextResponse.json({ blocks: [] });
  const blocks = await archiveIndex(db());
  return NextResponse.json(
    { format: "ruincity.archive-index/1", generatedAt: new Date().toISOString(), blocks },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
