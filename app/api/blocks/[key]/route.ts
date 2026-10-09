/** 區塊頁輪詢用：狀態與四個數字。施工中**不含任何圖** */

import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { getBlockPage } from "@/lib/server/block-page";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const session = await auth();
  try {
    const data = await getBlockPage(key, session?.user?.id ?? null);
    if (!data) return NextResponse.json({ error: "沒有這一塊" }, { status: 404 });
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/blocks/key]", e);
    return NextResponse.json({ error: "資料庫無法連線" }, { status: 503 });
  }
}
