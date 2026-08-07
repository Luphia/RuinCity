import Link from "next/link";

import { BALANCE_VERSION, ROSTER, SEASON_LIFECYCLE } from "@/lib/game/balance";
import {
  SEASON_LABEL,
  formatGameDate,
  seasonModifiersAt,
  toGameDate,
} from "@/lib/game/calendar";
import { serverNow } from "@/lib/time";
import { signOut } from "@/auth";
import { loadEntryPoint } from "@/app/actions/season";

export const dynamic = "force-dynamic";

/**
 * 首頁。M0 階段用一場「示範賽季」把曆法與數值表跑起來 ——
 * 這一頁能正確顯示廢曆日期與季節係數，就代表 /lib/game 的
 * 純函式層是通的。真正的賽季狀態要等 M5b 的賽季生命週期。
 */
export default async function Home() {
  // 時間權威一律來自伺服器，見 lib/time.ts
  const now = await serverNow();
  // 示範用：假設有一場賽季在 4 天前開打
  const startedAt = now - 4 * 24 * 60 * 60 * 1000;
  const date = toGameDate(startedAt, now);
  const mods = seasonModifiersAt(startedAt, now);

  // 沒有資料庫的環境（E2E、預覽）不該讓首頁 500
  let entry: Awaited<ReturnType<typeof loadEntryPoint>> = {
    signedIn: false,
    hasPlayer: false,
    email: null,
    registered: false,
  };
  try {
    entry = await loadEntryPoint();
  } catch {
    // 保持未登入的樣子
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <p className="text-relic font-mono text-xs tracking-[0.3em] uppercase">
          ruincity.com
        </p>
        <h1 className="text-parchment text-4xl font-bold tracking-tight">
          RuinCity
          <span className="text-ash block text-xl font-normal">廢墟之城</span>
        </h1>
        <p className="text-ash text-sm leading-relaxed">
          500 × 500 的廢土地圖上，{ROSTER.playersTotal} 名領主分屬{" "}
          {ROSTER.factions} 大陣營、{ROSTER.alliancesTotal} 個聯盟。
          一場戰役 12 天，每一天是遊戲裡的一個月。
        </p>
      </header>

      <section className="border-ink-mid bg-ink-soft rounded border p-5">
        <h2 className="text-ash-deep mb-3 font-mono text-xs tracking-widest uppercase">
          示範賽季 · 當前時間
        </h2>
        <p className="text-parchment text-lg">{formatGameDate(date)}</p>
        <p className="text-relic mt-1 text-sm">{SEASON_LABEL[date.season]}</p>

        <dl className="text-ash mt-4 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs">
          <Stat label="產出" value={`×${mods.production.toFixed(2)}`} />
          <Stat label="糧耗" value={`×${mods.upkeep.toFixed(2)}`} />
          <Stat label="行軍" value={`×${mods.marchTime.toFixed(2)}`} />
          <Stat label="區域容量" value={`×${mods.regionCapacity.toFixed(2)}`} />
        </dl>
      </section>

      <section className="text-ash flex flex-col gap-2 text-sm">
        <Fact label="賽季長度" value="12 真實日 = 12 遊戲月" />
        <Fact
          label="輪替"
          value={`每 ${SEASON_LIFECYCLE.cadenceMs / 86_400_000} 天開新的一場`}
        />
        <Fact label="每場人數" value={`${ROSTER.playersTotal}（真人不足由 AI 補足）`} />
        <Fact label="勝利條件" value="單一聯盟同時控制三座遺跡滿 6 小時" />
      </section>

      {/**
       * ★ 入口要反映狀態。已經登入了還顯示「登入」，或是已經有據點了
       *   還要玩家自己想辦法找到 `/base`，都是同一個問題：
       *   這一頁沒有在回答「我現在該按哪裡」。
       */}
      <div className="flex flex-col gap-2">
        {entry.hasPlayer ? (
          <>
            <Link
              href="/base"
              className="bg-relic text-ink rounded px-5 py-3 text-center font-medium transition-opacity hover:opacity-90"
            >
              進入遊戲
            </Link>
            <Link
              href="/seasons"
              className="border-relic text-relic hover:bg-relic hover:text-ink rounded border px-5 py-3 text-center font-medium transition-colors"
            >
              賽季資訊
            </Link>
          </>
        ) : (
          <>
            {/**
             * ★ 「登入了卻沒有進入遊戲的按鈕」是一個看起來很像故障的正常狀態。
             *   要說出是**哪一個帳號**沒有據點 —— 最常見的原因就是登錯帳號，
             *   而那件事只有把 email 印出來才看得見。
             */}
            {entry.signedIn ? (
              <p className="border-ink-mid bg-ink-soft text-ash rounded border p-4 text-sm leading-relaxed">
                你以 <b className="text-parchment">{entry.email}</b> 登入
                {entry.registered
                  ? "，已完成登記 —— 賽季開打時據點就會出現。"
                  : "，但這個帳號在進行中的賽季裡沒有據點。去登記下一場，或換一個帳號登入。"}
              </p>
            ) : null}
            <Link
              href="/seasons"
              className="bg-relic text-ink rounded px-5 py-3 text-center font-medium transition-opacity hover:opacity-90"
            >
              賽季登記
            </Link>
            {entry.signedIn ? null : (
              <Link
                href="/signin"
                className="border-relic text-relic hover:bg-relic hover:text-ink rounded border px-5 py-3 text-center font-medium transition-colors"
              >
                登入
              </Link>
            )}
          </>
        )}

        {/**
         * ★ 登入之後如果沒有任何登出的出口，用錯帳號的人就出不來了。
         *   這與「登入後還顯示登入按鈕」是同一個缺口的另一半。
         */}
        {entry.signedIn ? (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="text-ash-deep hover:text-ash w-full py-2 text-center text-sm"
            >
              登出
            </button>
          </form>
        ) : null}
      </div>

      <footer className="text-ink-mid mt-auto font-mono text-[10px]">
        balance {BALANCE_VERSION}
      </footer>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="text-parchment">{value}</dd>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-ink-soft flex justify-between border-b pb-2">
      <span className="text-ash-deep">{label}</span>
      <span className="text-parchment text-right">{value}</span>
    </div>
  );
}
