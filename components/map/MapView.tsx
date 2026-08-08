"use client";

import Link from "next/link";

/**
 * 地圖頁面外殼：抓總覽資料、掛上畫布、顯示選取資訊。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { MapCanvas } from "./MapCanvas";
import type { SceneData, SceneStats } from "@/lib/render/scene";

interface Overview {
  seasonId: string;
  /** 這不是目前這一場的地形，是開發用的替代品 */
  isFallback?: boolean;
  requestedSeason?: string;
  seed: number;
  chunkBaseUrl: string;
  ruins: { id: number; name: string; x: number; y: number }[];
  areas: Record<string, number>;
  fairness: { key: string; label: string; pass: boolean; actual: number; format: string }[];
  spawns: { x: number; y: number; faction: 1 | 2 | 3; band: string }[];
  /** 觀戰窗口內的交戰地點 —— 點那一格可以進去看 */
  battles?: { id: number; x: number; y: number }[];
}

export function MapView() {
  const [data, setData] = useState<SceneData | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const statsRef = useRef<SceneStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/map/overview");
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        const json = (await res.json()) as Overview;
        if (cancelled) return;
        setOverview(json);
        setData({
          source: { seasonId: json.seasonId, baseUrl: json.chunkBaseUrl },
          ruins: json.ruins,
          spawns: json.spawns.map((s, i) => ({ ...s, alliance: i % 5 })),
          battles: json.battles ?? [],
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 每秒才把 stats 推進 React —— 每幀 setState 會讓整個頁面重繪
  const onStats = useCallback((s: SceneStats) => {
    statsRef.current = s;
  }, []);
  useEffect(() => {
    const id = setInterval(() => setStats(statsRef.current), 1000);
    return () => clearInterval(id);
  }, []);

  if (error) {
    return (
      <main className="flex h-dvh flex-col items-center justify-center gap-2 bg-[#1a1614] p-6 text-center text-[#e8dcc0]">
        <p className="text-[#c4442f]">地圖載入失敗</p>
        <p className="text-sm opacity-80">{error}</p>
        <code className="mt-2 rounded bg-[#2e2723] px-2 py-1 text-xs">pnpm map:generate</code>
      </main>
    );
  }

  const home = overview?.spawns[0];

  return (
    <main className="flex h-dvh flex-col bg-[#1a1614] text-[#e8dcc0]">
      {/**
       * ★ 拿到的不是這一場的地圖時要講出來。
       *   靜默地換一張圖比顯示錯誤更糟 —— 玩家會照著一張錯的地圖規劃行軍。
       */}
      {overview?.isFallback ? (
        <div className="shrink-0 border-b border-[#8a6b3a] bg-[#2e2723] px-3 py-2 text-xs text-[#d9a441]">
          這是開發用的示範地形，<b>不是賽季 {overview.requestedSeason} 的地圖</b> ——
          該場的地形檔還沒產生（封盤時會自動寫出）。
        </div>
      ) : null}

      <div className="relative flex-1">
        <MapCanvas
          data={data}
          focus={home ? { x: home.x, y: home.y } : undefined}
          onSelectTile={setSelected}
          onStats={onStats}
        />
      </div>

      <footer className="shrink-0 border-t border-[#4a413a] bg-[#2e2723] px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span data-testid="selected-tile">
            {selected ? `(${selected.x}, ${selected.y})` : "點選格子查看"}
          </span>
          {/* ★ 點了格子就給出口：展開成 50×50 的戰場視圖。
              交戰中的格子（地圖上脈動的紅 ✕）出口變成「觀戰」 */}
          {selected ? (
            <Link
              href={`/tile/${selected.x}/${selected.y}`}
              data-testid="expand-tile"
              className={`rounded border px-2 py-0.5 ${
                overview?.battles?.some((b) => b.x === selected.x && b.y === selected.y)
                  ? "border-[#c4442f] text-[#c4442f]"
                  : "border-[#8a6b3a] text-[#d9a441]"
              }`}
            >
              {overview?.battles?.some((b) => b.x === selected.x && b.y === selected.y)
                ? "觀戰 🔥"
                : "展開此格 ⚔"}
            </Link>
          ) : null}
          {overview ? (
            <span className="opacity-70">
              賽季 {overview.seasonId} · seed {overview.seed} · 遺跡{" "}
              {overview.ruins.map((r) => r.name).join("、")}
            </span>
          ) : (
            <span className="opacity-70">載入中…</span>
          )}
          {stats ? (
            <span data-testid="sprite-count" className="ml-auto opacity-70">
              {stats.fps} fps · sprite {stats.spriteCount} · chunk {stats.chunksVisible}/
              {stats.chunksLoaded}
            </span>
          ) : null}
        </div>
      </footer>
    </main>
  );
}
