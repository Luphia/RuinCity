import { NextResponse } from "next/server";

import { runCronTick } from "@/lib/server/cron";
import { serverNow } from "@/lib/time";

/**
 * 結算 tick 的 HTTP 入口（production：Vercel Cron 每分鐘打一次）。
 *
 * ★ 邏輯全部在 `lib/server/cron.ts` 的 `runCronTick` —— 本機的
 *   `pnpm worker` 跑的是**同一份** tick，這裡只負責驗 secret 與包 JSON。
 *   沒有資料庫的環境（E2E、預覽）不會 500：區段錯誤收在 `errors` 裡。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = await serverNow();
  const tick = await runCronTick(now);

  return NextResponse.json({
    ok: true,
    ...tick,
    serverTime: new Date(now).toISOString(),
  });
}
