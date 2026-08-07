import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";

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
