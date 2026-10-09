/**
 * 區塊的產出圖。**未完成的區塊一律 403** —— 「完成前不能進入」守在這裡，不只在頁面上。
 * 完成後內容不再變動，可以長期快取。
 */

import { NextResponse } from "next/server";

import { isArtifactKind, readArtifact } from "@/lib/server/artifacts";
import { db } from "@/lib/server/runtime";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string; kind: string; index: string }> },
) {
  const { key, kind, index } = await params;
  const i = Number(index);
  if (!isArtifactKind(kind) || !Number.isInteger(i) || i < 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const size = new URL(req.url).searchParams.get("size") === "thumb" ? "thumb" : "full";
  const r = await readArtifact(db(), key, kind, i, size);
  if (!r.ok) {
    return r.reason === "NOT_COMPLETE"
      ? NextResponse.json({ error: "這一塊還在建設中，完成前不開放" }, { status: 403 })
      : NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return new Response(Buffer.from(r.data), {
    headers: {
      "Content-Type": r.mime,
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
