import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { auth } from "@/auth";
import { BlockComplete } from "@/components/BlockComplete";
import { BlockLive } from "@/components/BlockLive";
import { paymentProvider } from "@/lib/payments/registry";
import { getBlockPage } from "@/lib/server/block-page";
import { blockShortLabel, parseBlockKey } from "@/lib/world/grid";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  const id = parseBlockKey(key);
  return { title: id ? blockShortLabel(id) : "區塊" };
}

/**
 * 區塊頁。**完成前只有數字**（`BlockLive`），完成後才能進入（`BlockComplete`）。
 * 這一層只決定給哪一個 —— 圖的存取限制在 API（`/api/blocks/[key]/art/...`）。
 */
export default async function BlockPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const session = await auth().catch(() => null);
  let data;
  try {
    data = await getBlockPage(key, session?.user?.id ?? null);
  } catch (e) {
    console.error("[b/key]", e);
    return (
      <main className="mx-auto max-w-md p-6 text-center">
        <p className="text-alarm">資料庫無法連線</p>
        <p className="text-ash mt-2 text-sm">設定 DATABASE_URL 並執行 pnpm db:migrate。</p>
      </main>
    );
  }
  if (!data) notFound();
  if (data.view.status === "COMPLETE") return <BlockComplete data={data} />;
  return <BlockLive initial={data} signedIn={!!session?.user} canDonate={paymentProvider() !== null} />;
}
