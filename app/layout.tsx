import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "RuinCity 廢墟之城",
    template: "%s · RuinCity",
  },
  description:
    "像素風格・手機網頁・多人戰爭策略遊戲。500×500 廢土地圖，600 名領主，12 天一場戰役。",
  applicationName: "RuinCity",
  appleWebApp: { capable: true, title: "RuinCity", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#1a1614",
  width: "device-width",
  initialScale: 1,
  // 地圖自己處理縮放；避免瀏覽器的雙擊縮放干擾手勢
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
