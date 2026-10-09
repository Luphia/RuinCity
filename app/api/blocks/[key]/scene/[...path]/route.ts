/**
 * 在網站上瀏覽場景包：`/api/blocks/<key>/scene/index.html` 就是包裡的獨立檢視器，
 * 它用相對路徑讀 `scene.json` 與圖 —— 與從 IPFS 打開時讀的是同一批位元組。
 * **未完成的區塊 403。**
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { schema } from "@/lib/db";
import { readBundleFile, sceneBundleFiles } from "@/lib/server/archive";
import { db } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string; path: string[] }> }) {
  const { key, path } = await params;
  const rel = path.join("/");
  if (!rel || path.some((s) => s === "" || s === "." || s === "..")) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const [block] = await db()
    .select({ id: schema.blocks.id, completedAt: schema.blocks.completedAt })
    .from(schema.blocks)
    .where(eq(schema.blocks.key, key));
  if (!block) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!block.completedAt) return NextResponse.json({ error: "這一塊還在建設中，完成前不開放" }, { status: 403 });
  let f = await readBundleFile(db(), block.id, rel);
  if (!f) {
    // 附檔還沒凍結（剛完工、排程還沒打包）：現在凍結
    await sceneBundleFiles({ db: db() }, block.id);
    f = await readBundleFile(db(), block.id, rel);
  }
  if (!f) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new Response(Buffer.from(f.bytes), {
    headers: {
      "Content-Type": f.mime,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
