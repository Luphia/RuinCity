import Image from "next/image";
import Link from "next/link";

import { SPLASH } from "@/lib/splash";
import { MODEL_PROFILES, isProviderId } from "@/lib/world/pricing";

/**
 * 開場畫面：從象山俯視荒廢的臺北 101，按「進入城市」進到世界地圖。
 *
 * 圖由 `pnpm splash:paint` 畫（與區塊同一份正典與擬真規格，見 `lib/splash.ts`）。
 * 還沒畫之前只有霧色的底與文字 —— 畫面必須擬真，所以不拿插畫或示範圖頂替。
 */
export default function Splash() {
  const s = SPLASH;
  const painter = s && isProviderId(s.provider) ? MODEL_PROFILES[s.provider].displayName : s?.model;
  return (
    <main data-testid="splash" className="relative isolate flex flex-1 flex-col justify-end overflow-hidden">
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
          className="-z-20 absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 70% at 45% 35%, rgba(143,176,122,0.18), transparent 60%), radial-gradient(90% 60% at 50% 100%, rgba(20,19,17,0.9), transparent 70%), linear-gradient(180deg, #2b2f2a 0%, #1d1f1b 45%, #141311 100%)",
          }}
        />
      )}
      {/* 讓文字在任何一張圖上都讀得清楚：底部與左側壓暗 */}
      <div
        aria-hidden
        className="-z-10 absolute inset-0"
        style={{ background: "linear-gradient(0deg, rgba(20,19,17,0.92) 0%, rgba(20,19,17,0.55) 35%, rgba(20,19,17,0) 65%)" }}
      />

      <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pb-10 pt-24 sm:pb-14">
        <p className="text-ash text-xs tracking-[0.2em]">象山 · N25.03° E121.57° · 西北望 1.4 公里</p>
        <h1 className="text-4xl font-bold tracking-wide sm:text-6xl">RuinCity</h1>
        <p className="text-parchment max-w-xl text-lg leading-relaxed sm:text-xl">
          千年之後。人類離開了，臺北還在 —— 只是換了主人。
        </p>
        <p className="text-ash max-w-xl text-sm leading-relaxed">
          地球被切成 0.01° 的區塊，每一塊由捐款請 AI 畫出它一千年後的樣子。從臺北 101 開始。
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <Link
            href="/world"
            data-testid="enter-city"
            className="bg-rust text-ink hover:bg-parchment rounded px-6 py-3 text-base font-bold tracking-wide shadow-lg transition-colors"
          >
            進入城市
          </Link>
          <Link href="/about" className="text-ash hover:text-parchment text-sm underline-offset-4 hover:underline">
            怎麼運作
          </Link>
        </div>
        {s ? (
          <p className="text-ash-deep mt-4 text-xs">
            從象山望向臺北 101 · {painter} 繪製
            {s.referenceDate ? ` · 構圖參考 ${s.referenceDate} 的街景` : ""} · CC0 1.0
          </p>
        ) : process.env.NODE_ENV !== "production" ? (
          <p className="text-ash-deep mt-4 text-xs" data-testid="splash-missing">
            開場圖尚未繪製：設定 GEMINI_API_KEY 或 OPENAI_API_KEY 後執行 <code>pnpm splash:paint</code>
          </p>
        ) : null}
      </section>
    </main>
  );
}
