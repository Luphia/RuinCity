import Link from "next/link";

import { BALANCE_VERSION, ROSTER, SEASON_LIFECYCLE } from "@/lib/game/balance";
import {
  SEASON_LABEL,
  formatGameDate,
  seasonModifiersAt,
  toGameDate,
} from "@/lib/game/calendar";
import { serverNow } from "@/lib/time";

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

      <div className="flex flex-col gap-2">
        <Link
          href="/seasons"
          className="bg-relic text-ink rounded px-5 py-3 text-center font-medium transition-opacity hover:opacity-90"
        >
          賽季登記
        </Link>
        <Link
          href="/signin"
          className="border-relic text-relic hover:bg-relic hover:text-ink rounded border px-5 py-3 text-center font-medium transition-colors"
        >
          登入
        </Link>
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
