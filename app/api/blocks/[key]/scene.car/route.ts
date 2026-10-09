/**
 * 整個場景包（CAR v1，根 = 場景包 CID）。**未完成的區塊 403。**
 *
 * 每次都從資料庫重新打包，並與記下的 CID 比對 —— 對不上就拒絕送出，
 * 寧可報錯也不給一份「看起來像、其實不一樣」的包。
 *
 * 取得之後：`ipfs dag import <檔案>`，或 `pnpm scene:verify <檔案> --extract <資料夾>`。
 */

import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { schema } from "@/lib/db";
import { writeCar } from "@/lib/ipfs/pack";
import { archiveOf, packScene } from "@/lib/server/archive";
import { db } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const [block] = await db()
    .select({ id: schema.blocks.id, completedAt: schema.blocks.completedAt })
    .from(schema.blocks)
    .where(eq(schema.blocks.key, key));
  if (!block) return NextResponse.json({ error: "沒有這一塊" }, { status: 404 });
  if (!block.completedAt) return NextResponse.json({ error: "這一塊還在建設中，完成前不開放" }, { status: 403 });
  const p = await packScene({ db: db() }, block.id);
  if (!p) return NextResponse.json({ error: "沒有這一塊" }, { status: 404 });
  const info = await archiveOf(db(), block.id);
  const root = p.packed.root.toString();
  if (info && info.archive.sceneCid !== root) {
    console.error(`[scene.car] ${key} 重新打包得到 ${root}，記錄是 ${info.archive.sceneCid}`);
    return NextResponse.json({ error: "重建出的場景包與記錄的 CID 不符，已停止提供" }, { status: 500 });
  }
  const car = writeCar([p.packed.root], p.packed.blocks);
  return new Response(Buffer.from(car), {
    headers: {
      "Content-Type": "application/vnd.ipld.car; version=1",
      "Content-Disposition": `attachment; filename="ruincity-${key}-${root}.car"`,
      "X-Ipfs-Roots": root,
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
