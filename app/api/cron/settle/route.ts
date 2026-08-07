import { NextResponse } from "next/server";

/**
 * 結算引擎的軌道 B（Push）：每 60 秒掃描所有到期且「會影響他人」的事件
 * （MARCH_ARRIVE / RUIN_TICK / ISOLATION_EXPIRE …），結算並透過 SSE 推播。
 *
 * 這保證**守方即使離線也會被結算** —— 不能因為守方沒登入，攻方的行軍就卡住。
 *
 * M0 只有骨架；實際的結算器在 M2 隨事件表一起做。
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  return NextResponse.json({
    ok: true,
    settled: 0,
    note: "settlement engine lands in M2",
    serverTime: new Date().toISOString(),
  });
}
