import Image from "next/image";

import { SplashHud, type SplashHudData } from "@/components/SplashHud";
import { getBlockPage } from "@/lib/server/block-page";
import { budgetConfig } from "@/lib/server/config";
import { db } from "@/lib/server/runtime";
import { worldStats } from "@/lib/server/world-stats";
import { SPLASH } from "@/lib/splash";
import { TAIPEI_101, blockKey, blockOf } from "@/lib/world/grid";
import { formatTwd } from "@/lib/world/ledger";
import { MODEL_PROFILES, isProviderId } from "@/lib/world/pricing";

/**
 * 開場畫面：從象山俯視荒廢的臺北 101，按「進入城市」進到世界地圖。
 *
 * 背景是 `pnpm splash:paint` 畫的那張（與區塊同一份正典與擬真規格，見 `lib/splash.ts`）；
 * 上面疊一層毛玻璃 HUD（`components/SplashHud.tsx`），數字都是即時的。
 * 還沒畫之前背景只有天色漸層 —— 畫面必須擬真，所以不拿插畫或示範圖頂替。
 */
export const dynamic = "force-dynamic";

async function hudData(): Promise<SplashHudData> {
  const twdPerUsd = budgetConfig().twdPerUsd;
  const [stats, origin] = await Promise.all([
    worldStats(db()).catch((e: unknown) => {
      console.error("[splash] 讀不到世界進度", e);
      return null;
    }),
    getBlockPage(blockKey(blockOf(TAIPEI_101)), null).catch((e: unknown) => {
      console.error("[splash] 讀不到臺北 101 那一塊", e);
      return null;
    }),
  ]);
  return {
    stats: stats && {
      completed: stats.completed,
      underway: stats.underway,
      raised: formatTwd(stats.raisedMicros, twdPerUsd),
      donors: stats.donors,
      archived: stats.archived,
    },
    origin: origin && {
      statusLabel: origin.view.statusLabel,
      complete: origin.view.status === "COMPLETE",
      progress: origin.view.funding.progress,
      received: origin.view.funding.received.twd,
      needed: origin.view.meters.moneyNeeded.twd,
    },
  };
}

export default async function Splash() {
  const s = SPLASH;
  const painter = s && isProviderId(s.provider) ? MODEL_PROFILES[s.provider].displayName : s?.model;
  const data = await hudData();
  return (
    <main data-testid="splash" className="relative isolate flex flex-1 flex-col overflow-x-clip">
      {s ? (
        <Image
          src={s.src}
          alt="從象山山頂俯視人類離開一千年後的臺北：森林吞沒了信義區，荒廢的臺北 101 矗立在晨霧中"
          fill
          priority
          sizes="100vw"
          className="-z-20 object-cover"
          style={{ objectPosition: `${s.focusX * 100}% 50%` }}
        />
      ) : (
        <div
          aria-hidden
          className="absolute inset-0 -z-20"
          style={{
            // 天色：上方深藍 → 中段灰藍 → 地平線一抹霧白與微暖 → 下方墨綠（森林）
            background:
              "radial-gradient(60% 18% at 62% 66%, rgba(255,214,170,0.28), transparent 70%), linear-gradient(180deg, #0d1a2b 0%, #1d3046 32%, #4a6378 56%, #b7c2c4 66%, #3b4a3e 74%, #141c16 100%)",
          }}
        />
      )}
      {/* 卡片下方的對比：上下壓暗一點，中間讓景色透出來 */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10"
        style={{ background: "linear-gradient(180deg, rgba(5,10,18,0.45) 0%, rgba(5,10,18,0.05) 40%, rgba(5,10,18,0.05) 60%, rgba(5,10,18,0.55) 100%)" }}
      />

      <SplashHud data={data} />

      <footer className="mx-auto w-full max-w-6xl px-4 pb-4 text-xs text-white/55">
        {s ? (
          <>
            從象山望向臺北 101 · {painter} 繪製
            {s.referenceDate ? ` · 構圖參考 ${s.referenceDate} 的街景` : ""} · CC0 1.0
          </>
        ) : process.env.NODE_ENV !== "production" ? (
          <span data-testid="splash-missing">
            開場圖尚未繪製：設定 GEMINI_API_KEY 或 OPENAI_API_KEY 後執行 <code>pnpm splash:paint</code>
          </span>
        ) : null}
      </footer>
    </main>
  );
}
