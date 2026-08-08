"use client";

import Link from "next/link";

/**
 * 地圖頁面外殼：抓總覽資料、掛上畫布、顯示選取資訊。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { MapCanvas } from "./MapCanvas";
import { GameHud } from "@/components/hud/GameHud";
import { GameNav } from "@/components/nav/GameNav";
import { loadMyMapOverlay, type MapOverlay } from "@/app/actions/map";
import { TERRAIN, TILE_RESOURCE } from "@/lib/game/balance";
import { CODE_TERRAIN } from "@/lib/game/map/terrain";
import { needsConquest, wildLevelAt } from "@/lib/game/wilds";
import { peekChunk } from "@/lib/render/chunk-cache";
import { CHUNK_SIZE } from "@/lib/render/chunks";
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
  /** 交戰地點 —— fresh = 觀戰窗口內（點那一格可以進去看） */
  battles?: { id: number; x: number; y: number; fresh: boolean; live?: boolean }[];
}

const RESOURCE_LABEL = { grain: "糧", timber: "木", stone: "石", iron: "鐵" } as const;

/**
 * 選取格的地形情報。**只供顯示** —— 佔領與戰鬥的判定永遠在伺服器重算。
 * chunk 還沒載到就回 null（footer 只顯示座標），載到後下一次點擊就有了。
 */
function tileInfoAt(
  data: SceneData,
  seed: number,
  x: number,
  y: number,
  mine?: MapOverlay | null,
): {
  label: string;
  resource?: string;
  level: number;
  guarded: boolean;
  /** 這一格是我的什麼（沒有就是別人的地或無主野地）*/
  owned: "BASE" | "TERRITORY" | null;
} | null {
  if (x < 0 || y < 0) return null;
  const codes = peekChunk(data.source, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
  if (!codes) return null;
  const terrain = CODE_TERRAIN[codes[(y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE)] ?? 0];
  if (!terrain) return null;
  const res = TILE_RESOURCE[terrain];
  const level = wildLevelAt(seed, x, y, terrain);
  /**
   * ★ 「這是不是我的地」要先講。
   *   只報地形的話，點自己的據點會看到「有守衛」—— 那是**野地**的屬性，
   *   對一格已經插著自己旗子的地來說完全是誤導。
   */
  const isBase =
    !!mine && x >= mine.base.x && x <= mine.base.x + 1 && y >= mine.base.y && y <= mine.base.y + 1;
  const isTerritory = !!mine?.tiles.some((t) => t.x === x && t.y === y);
  return {
    label: TERRAIN[terrain].label,
    resource: res ? RESOURCE_LABEL[res.resource] : undefined,
    level,
    guarded: needsConquest(level),
    owned: isBase ? "BASE" : isTerritory ? "TERRITORY" : null,
  };
}

export function MapView() {
  const [data, setData] = useState<SceneData | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number } | null>(null);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const statsRef = useRef<SceneStats | null>(null);

  const [overlay, setOverlay] = useState<MapOverlay | null>(null);
  const [overlayNote, setOverlayNote] = useState<string | null>(null);
  const [recenterNonce, setRecenterNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // 個人圖層失敗不擋地圖 —— 但要講出來（失敗要看得見）
      const mine = await loadMyMapOverlay().catch(() => {
        if (!cancelled) setOverlayNote("個人圖層載入失敗");
        return null;
      });
      try {
        const res = await fetch("/api/map/overview");
        if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
        const json = (await res.json()) as Overview;
        if (cancelled) return;
        setOverview(json);
        setOverlay(mine);
        setData({
          source: { seasonId: json.seasonId, baseUrl: json.chunkBaseUrl },
          ruins: json.ruins,
          spawns: json.spawns.map((s, i) => ({ ...s, alliance: i % 5 })),
          battles: json.battles ?? [],
          mine: mine ?? undefined,
          seed: json.seed,
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

  /**
   * ★ 開圖聚焦在**我的據點**，不是第一個出生點。
   *   spawns[0] 是別人的家 —— 玩家打開地圖第一眼要看到的是自己的疆界。
   *   沒登入（或沒賽季）才退回 spawns[0]，至少讓地圖有個有東西的起點。
   */
  const home = overlay?.base ?? overview?.spawns[0];

  const selectedInfo =
    selected && data && overview
      ? tileInfoAt(data, overview.seed, selected.x, selected.y, overlay)
      : null;
  const selectedBattle = selected
    ? overview?.battles?.find((b) => b.x === selected.x && b.y === selected.y)
    : undefined;

  return (
    <main className="flex h-dvh flex-col bg-[#1a1614] pb-11 text-[#e8dcc0]">
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
          recenterNonce={recenterNonce}
          onSelectTile={setSelected}
          onStats={onStats}
        />
        {/* 常駐 HUD 浮在地圖上緣（docs/09 §5.1）—— 沒登入時它什麼都不畫 */}
        <GameHud floating />
        {/* ★ 回家鍵：平移迷路是廢土地圖的日常，一鍵回到自己的據點 */}
        {home ? (
          <button
            type="button"
            data-testid="recenter-home"
            onClick={() => setRecenterNonce((n) => n + 1)}
            className="absolute bottom-3 right-2 rounded border border-[#8a6b3a] bg-[#2e2723]/90 px-3 py-2 text-sm text-[#d9a441]"
          >
            ⌂ 回家
          </button>
        ) : null}
      </div>

      <footer className="shrink-0 border-t border-[#4a413a] bg-[#2e2723] px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span data-testid="selected-tile">
            {selected ? `(${selected.x}, ${selected.y})` : "點選格子查看"}
          </span>
          {/* ★ 選了格子就講出它是什麼：地形、資源與等級、有沒有守衛。
              「哪些位置是資源地」不能要玩家用色塊猜 */}
          {selectedInfo ? (
            <span data-testid="tile-info" className="text-[#d9a441]">
              {selectedInfo.owned === "BASE" ? (
                <b className="text-[#4a8fa8]">我的據點 · </b>
              ) : selectedInfo.owned === "TERRITORY" ? (
                <b className="text-[#4a8fa8]">我的領地 · </b>
              ) : null}
              {selectedInfo.label}
              {selectedInfo.resource
                ? ` · ${selectedInfo.resource} Lv${selectedInfo.level}` +
                  // 守衛是**無主野地**的屬性 —— 已經是誰的地就不該再講
                  (selectedInfo.guarded && !selectedInfo.owned ? "（有守衛）" : "")
                : ""}
            </span>
          ) : null}
          {/* ★ 點了格子就給出口：展開成 50×50 的戰場視圖。
              觀戰窗口內的格子（地圖上脈動的紅 ✕）出口變成「觀戰」 */}
          {selected ? (
            <Link
              href={`/tile/${selected.x}/${selected.y}`}
              data-testid="expand-tile"
              className={`rounded border px-2 py-0.5 ${
                selectedBattle?.fresh
                  ? "border-[#c4442f] text-[#c4442f]"
                  : "border-[#8a6b3a] text-[#d9a441]"
              }`}
            >
              {selectedBattle?.live ? "交戰中 ⚔" : selectedBattle?.fresh ? "觀戰 🔥" : "展開此格 ⚔"}
            </Link>
          ) : null}
          {overview && !selected ? (
            <span className="opacity-70">
              賽季 {overview.seasonId} · 遺跡 {overview.ruins.map((r) => r.name).join("、")}
            </span>
          ) : null}
          {!overview ? <span className="opacity-70">載入中…</span> : null}
          {overlayNote ? <span className="text-[#c4442f]">{overlayNote}</span> : null}
          {stats ? (
            <span data-testid="sprite-count" className="ml-auto opacity-70">
              {stats.fps} fps · sprite {stats.spriteCount} · chunk {stats.chunksVisible}/
              {stats.chunksLoaded}
            </span>
          ) : null}
        </div>
        {/* ★ 圖例:地圖上每一種記號一句話。看不懂的地圖等於沒有地圖 */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] opacity-80">
          <span>
            <span className="mr-1 inline-block h-2 w-2 border border-[#d9a441] align-middle" />
            我的據點
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 bg-[#c4442f] align-middle" />
            <span className="mr-1 inline-block h-2 w-2 bg-[#3f9aa3] align-middle" />
            <span className="mr-1 inline-block h-2 w-2 bg-[#7fa832] align-middle" />
            各勢力據點
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 bg-[#d9a441] align-middle" />
            遺跡
          </span>
          <span className="text-[#c4442f]">✕ 交戰</span>
          {/* ★ 打完的與正在打的要分得開：後者還來得及派兵加入 */}
          <span className="text-[#c4442f]">
            <span className="mr-0.5 inline-block h-2 w-2 rounded-full border border-[#e8dcc0] align-middle" />
            進行中
          </span>
          <span>
            <span className="mr-0.5 inline-block h-1.5 w-1.5 bg-[#e8dcc0] align-middle" />
            <span className="mr-1 inline-block h-1.5 w-1.5 bg-[#e8dcc0] align-middle" />
            資源等級
          </span>
          <span className="text-[#4a8fa8]">─ 我的疆界</span>
        </div>
      </footer>
      <GameNav />
    </main>
  );
}
