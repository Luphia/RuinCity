import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { GameHud } from "@/components/hud/GameHud";
import { GameNav } from "@/components/nav/GameNav";

/**
 * 遊戲主介面。所有子路由都需要登入。
 *
 * 底部 Tab 見 docs/09-art-ux.md §5.1。地圖是**公開路由**（`/map`），
 * 不在這個群組下 —— 封盤期的地圖與公平性數字本來就該讓還沒登記的人看得到。
 */
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <div className="min-h-dvh bg-[#1a1614] pb-14">
      {/* ★ 常駐 HUD（docs/09 §5.1）：資源與「下一件完成的事」在每一個分頁都看得到。
          它自己抓資料、自己外推 —— 沒有進行中的賽季時什麼都不畫 */}
      <GameHud />
      {children}
      <GameNav />
    </div>
  );
}
