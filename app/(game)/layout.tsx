import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { GameHud } from "@/components/hud/GameHud";

/**
 * 遊戲主介面。所有子路由都需要登入。
 *
 * 底部 Tab 見 docs/09-art-ux.md §5.1。地圖是**公開路由**（`/map`），
 * 不在這個群組下 —— 封盤期的地圖與公平性數字本來就該讓還沒登記的人看得到。
 */
const TABS = [
  { href: "/base", label: "據點" },
  { href: "/territory", label: "領土" },
  { href: "/war", label: "軍事" },
  { href: "/market", label: "集市" },
  { href: "/steward", label: "執政官" },
  { href: "/map", label: "地圖" },
] as const;

export default async function GameLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <div className="min-h-dvh bg-[#1a1614] pb-14">
      {/* ★ 常駐 HUD（docs/09 §5.1）：資源與「下一件完成的事」在每一個分頁都看得到。
          它自己抓資料、自己外推 —— 沒有進行中的賽季時什麼都不畫 */}
      <GameHud />
      {children}
      <nav className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-w-md border-t border-[#4a413a] bg-[#2e2723] text-[#e8dcc0]">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className="flex-1 py-3 text-center text-xs hover:bg-[#4a413a]"
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
