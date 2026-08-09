/**
 * 地圖上會變的那一份：烽火。
 *
 * ★ 為什麼不併在 `/api/map/overview` 裡：總覽的大宗是**地形中繼資料**
 *   （seed、三座遺跡、六百個出生點、公平性驗證），那些一場賽季裡不會變，
 *   所以它快取一分鐘。而交戰只有兩分鐘（`BATTLE.durationMs`）——
 *   跟著總覽一分鐘更新一次，等於「一半的仗玩家永遠看不到」。
 *
 *   拆成兩支之後分工很乾淨：開圖拉一次總覽（可快取、可 CDN），
 *   之後只輪詢這一支（不快取、回應很小）。
 *
 * ★ 賽季由呼叫端指定。這是公開資料（烽火全世界看得到），
 *   而「我是哪一場」總覽已經解析過一次了 —— 客戶端把答案帶回來就好，
 *   不必為了一支輪詢端點再跑一次 `currentPlayer()`。
 */

import { NextResponse } from "next/server";

import { loadMapBattles } from "@/lib/server/map-battles";
import { serverNow } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const season = new URL(request.url).searchParams.get("season") ?? "";
  const numeric = /^s(\d+)$/.exec(season)?.[1];
  if (!numeric) {
    // 開發地圖（`s0`）沒有賽季，也就沒有仗 —— 那不是錯誤
    return NextResponse.json(
      { seasonId: season, serverTime: Date.now(), battles: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const now = await serverNow();
    return NextResponse.json(
      { seasonId: season, serverTime: now, battles: await loadMapBattles(Number(numeric), now) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // 沒有資料庫的環境（E2E、預覽）就沒有烽火。輪詢不該把地圖弄壞
    return NextResponse.json(
      { seasonId: season, serverTime: Date.now(), battles: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
