import Link from "next/link";

import { loadBattleReplay } from "@/app/actions/war";
import { BattlefieldView } from "@/components/battle/BattlefieldView";

export const metadata = { title: "戰場重播 · RuinCity" };
export const dynamic = "force-dynamic";

const OUTCOME_LABEL: Record<string, string> = {
  ATTACKER_WIN: "攻方獲勝",
  DEFENDER_WIN: "守方守住",
  DRAW: "僵持",
};

/**
 * 戰場重播：把一份戰報演成 50×50 的即時戰略。
 *
 * ★ 士兵的移動與交戰是自主的（`lib/game/battlefield.ts` 的規則），
 *   但誰死、死多少由戰報決定 —— 這是重播，不是第二個戰鬥引擎。
 *   帳目以 `/war` 的戰報數字為準。
 */
export default async function BattlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reportId = Number(id);

  let replay: Awaited<ReturnType<typeof loadBattleReplay>> = null;
  let error: string | null = null;
  try {
    replay = Number.isInteger(reportId) ? await loadBattleReplay(reportId) : null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!replay) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">戰場重播</h1>
        <p className="mt-3 text-sm opacity-80">
          找不到這份戰報，或它不是一場戰鬥（偵查報告沒有戰場）。
        </p>
        {error ? <p className="mt-3 rounded bg-[#2e2723] p-3 text-xs opacity-70">{error}</p> : null}
        <Link href="/war" className="mt-4 block text-sm text-[#d9a441]">
          ← 回軍事
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-6 text-[#e8dcc0]">
      <header className="mb-3 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">
          ({replay.atX}, {replay.atY}) 的戰鬥
        </h1>
        <span className="rounded bg-[#4a413a] px-2 py-0.5 text-xs">
          {OUTCOME_LABEL[replay.outcome] ?? replay.outcome}
        </span>
      </header>

      <BattlefieldView
        input={{
          // seed = 戰報 id：兩位當事人看到同一場戲
          seed: replay.reportId,
          attacker: replay.attacker,
          defender: replay.defender,
          hasBase: true,
        }}
        attackerLabel={
          replay.isSpectator ? "攻方" : replay.viewerIsAttacker ? "我方（攻）" : "敵方（攻）"
        }
        defenderLabel={
          replay.isSpectator ? "守方" : replay.viewerIsAttacker ? "敵方（守）" : "我方（守）"
        }
      />

      <p className="mt-3 text-[11px] leading-relaxed opacity-60">
        重播是戰報的戲劇化：士兵的走位是自主的，傷亡照戰報收斂。
        精確的數字與計算過程在 <Link href="/war" className="text-[#d9a441]">戰報詳情</Link>。
      </p>
    </main>
  );
}
