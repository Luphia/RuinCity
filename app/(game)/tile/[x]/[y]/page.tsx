import Link from "next/link";

import { loadTileScene } from "@/app/actions/tile";
import { loadBattleReplay } from "@/app/actions/war";
import { BattlefieldView } from "@/components/battle/BattlefieldView";

export const metadata = { title: "戰場 · RuinCity" };
export const dynamic = "force-dynamic";

/**
 * 一格的展開視圖：50×50 的戰場。
 *
 * 三種樣子，依這一格上有什麼：
 * 1. 這裡打過仗（而且我是當事人）→ 即時戰略式重播
 * 2. 我的據點 → 城 + 駐軍在牆外自主巡邏（idle）
 * 3. 別人的據點或空地 → 只有城殼或地形 —— 守軍是迷霧，要知道就派偵查
 */
export default async function TilePage({
  params,
}: {
  params: Promise<{ x: string; y: string }>;
}) {
  const p = await params;
  const x = Number(p.x);
  const y = Number(p.y);
  const valid = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 500 && y < 500;

  let scene: Awaited<ReturnType<typeof loadTileScene>> = null;
  let error: string | null = null;
  try {
    scene = valid ? await loadTileScene(x, y) : null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!scene) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">戰場</h1>
        <p className="mt-3 text-sm opacity-80">
          {valid ? "你還沒有進行中的賽季。" : "座標超出地圖範圍。"}
        </p>
        {error ? <p className="mt-3 rounded bg-[#2e2723] p-3 text-xs opacity-70">{error}</p> : null}
        <Link href="/map" className="mt-4 block text-sm text-[#d9a441]">
          ← 回地圖
        </Link>
      </main>
    );
  }

  // 這一格打過仗 → 直接演那一場
  const replay = scene.latestBattleId ? await loadBattleReplay(scene.latestBattleId) : null;

  return (
    <main className="mx-auto max-w-md px-4 py-6 text-[#e8dcc0]">
      <header className="mb-3 flex items-baseline justify-between">
        <h1 className="text-xl font-bold">
          ({x}, {y})
        </h1>
        <span className="rounded bg-[#4a413a] px-2 py-0.5 text-xs">
          {replay ? "最近一戰" : scene.isMine ? "我的據點" : scene.hasBase ? "敵方據點" : "曠野"}
        </span>
      </header>

      {replay ? (
        <BattlefieldView
          input={{
            seed: replay.reportId,
            attacker: replay.attacker,
            defender: replay.defender,
            hasBase: scene.hasBase,
          }}
          attackerLabel={replay.viewerIsAttacker ? "我方（攻）" : "敵方（攻）"}
          defenderLabel={replay.viewerIsAttacker ? "敵方（守）" : "我方（守）"}
          slots={scene.slots ?? undefined}
        />
      ) : (
        <BattlefieldView
          input={{
            // 沒有戰鬥 → idle：守軍（只有自己的看得到）在牆外自主巡邏
            seed: x * 1000 + y,
            attacker: { army: {}, losses: {} },
            defender: { army: scene.garrison, losses: {} },
            hasBase: scene.hasBase,
          }}
          attackerLabel="—"
          defenderLabel={scene.isMine ? "我方駐軍" : "守軍不明"}
          slots={scene.slots ?? undefined}
        />
      )}

      {!scene.isMine && scene.hasBase && !replay ? (
        <p className="mt-3 rounded border border-[#4a413a] bg-[#2e2723] p-3 text-xs opacity-80">
          敵方守軍不可見 —— 想知道城裡有多少人，從{" "}
          <Link href="/war" className="text-[#d9a441]">
            軍事
          </Link>{" "}
          派一隊偵查兵。
        </p>
      ) : null}

      <Link href="/map" className="mt-4 block text-sm text-[#d9a441]">
        ← 回地圖
      </Link>
    </main>
  );
}
