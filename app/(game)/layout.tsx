import { redirect } from "next/navigation";

import { auth } from "@/auth";

/**
 * 遊戲主介面。所有子路由都需要登入。
 *
 * 版面骨架（狀態列 / 遺跡列 / 主內容 / 底部 Tab）在 M1 隨地圖一起做，
 * 見 docs/09-art-ux.md §5.1。
 */
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return <div className="min-h-dvh">{children}</div>;
}
