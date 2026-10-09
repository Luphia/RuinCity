import type { Metadata, Viewport } from "next";
import Link from "next/link";

import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

import { auth } from "@/auth";
import { isDemoPayments } from "@/lib/payments/registry";
import { usingFakeProviders } from "@/lib/providers/registry";

export const metadata: Metadata = {
  title: { default: "RuinCity · 千年之後", template: "%s · RuinCity" },
  description:
    "把地球切成 0.01° 的區塊，用捐款請 AI 畫出每一塊在人類離開一千年後的樣子。從臺北 101 開始。",
  applicationName: "RuinCity",
};

export const viewport: Viewport = {
  themeColor: "#0b1420",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth().catch(() => null);
  const demoPay = isDemoPayments();
  const fake = usingFakeProviders();
  return (
    <html lang="zh-Hant">
      <body className="flex min-h-dvh flex-col antialiased">
        {/**
         * ★ 示範模式要一直講出來：示範金流不收錢、示範畫師不畫圖。
         *   正式環境誤開了，這條橫幅是第一個也是最明顯的警告。
         */}
        {demoPay || fake ? (
          <div data-testid="demo-banner" className="border-b border-amber-300/20 bg-amber-500/15 px-3 py-1.5 text-center text-xs text-amber-100">
            示範模式：
            {demoPay ? "捐款不會實際收款" : null}
            {demoPay && fake ? "，" : null}
            {fake ? "畫面由示範畫師產生，未呼叫任何 AI" : null}
          </div>
        ) : null}
        <header className="sticky top-0 z-30 flex shrink-0 items-center gap-4 border-b border-white/10 bg-slate-950/50 px-4 py-2.5 text-sm backdrop-blur-md">
          <Link href="/" className="font-semibold tracking-wide text-white">
            RuinCity <span className="font-normal text-white/60">千年之後</span>
          </Link>
          <Link href="/world" className="text-white/70 transition hover:text-white">
            世界地圖
          </Link>
          <Link href="/about" className="text-white/70 transition hover:text-white">
            怎麼運作
          </Link>
          <span className="flex-1" />
          {session?.user ? (
            <span className="max-w-40 truncate text-xs text-white/60">{session.user.email}</span>
          ) : (
            <Link href="/signin" className="rounded-full border border-sky-200/40 px-3 py-1 text-sky-100 transition hover:border-sky-100 hover:text-white">
              登入
            </Link>
          )}
        </header>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </body>
    </html>
  );
}
