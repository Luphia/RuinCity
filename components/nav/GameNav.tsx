import Link from "next/link";

/**
 * 底部分頁列。`(game)` layout 與 `/map` 共用 ——
 * 地圖是公開路由、不在 layout 群組下，但**不能是死路**：
 * 玩家在地圖上看完要能一步回到據點／軍事，尤其是手機上沒有返回鍵可依賴。
 */
const TABS = [
  { href: "/base", label: "據點" },
  { href: "/territory", label: "領土" },
  { href: "/war", label: "軍事" },
  { href: "/market", label: "集市" },
  { href: "/steward", label: "執政官" },
  { href: "/map", label: "地圖" },
] as const;

export function GameNav() {
  return (
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
  );
}
