import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { GameHud } from "@/components/hud/GameHud";
import { GameNav } from "@/components/nav/GameNav";
import { loadElimination } from "@/app/actions/elimination";

/**
 * 遊戲主介面。所有子路由都需要登入。
 *
 * 底部 Tab 見 docs/09-art-ux.md §5.1。地圖是**公開路由**（`/map`），
 * 不在這個群組下 —— 封盤期的地圖與公平性數字本來就該讓還沒登記的人看得到。
 */
export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  /**
   * ★ 出局的領主不能再進遊戲畫面（`docs/02` §3.1）。
   *
   *   擋在 layout 而不是每一頁：`settleWithin` 會對出局者丟
   *   `PlayerEliminatedError`，而那是**所有寫入路徑的共同入口** ——
   *   不在這裡擋的話，玩家看到的是六個分頁各自炸出一個技術錯誤，
   *   而不是「你的主城陷落了」。
   */
  const out = await loadElimination();
  if (out) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center text-[#e8dcc0]">
        <p className="text-5xl">🏚</p>
        <h1 className="text-2xl font-bold text-[#c4442f]">主城陷落</h1>
        <p className="text-sm leading-relaxed opacity-80">
          {out.at} —— 你的主城被攻破，這一季到此為止。
          <br />
          領地已回歸廢土，殘部就地解散。
        </p>
        <p className="rounded border border-[#4a413a] bg-[#2e2723] p-3 text-xs leading-relaxed opacity-70">
          出局是永久的：主城一旦被拆毀，這一場賽季不會再回來。
          <br />
          下一場賽季開放登記時，你會帶著傳承點重新開始。
        </p>
        <div className="flex gap-3">
          <Link href="/map" className="rounded border border-[#8a6b3a] px-4 py-2 text-sm text-[#d9a441]">
            看地圖
          </Link>
          <Link href="/seasons" className="rounded border border-[#8a6b3a] px-4 py-2 text-sm text-[#d9a441]">
            下一場賽季
          </Link>
        </div>
      </main>
    );
  }

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
