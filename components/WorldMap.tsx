"use client";

/**
 * 世界地圖。MapLibre + 經緯度網格 + 區塊狀態。
 *
 * - zoom ≥ 12 才畫 0.01° 的格線（再遠的話一個畫面幾萬條線，什麼也看不清）
 * - **已完成**的區塊：把它的正射底圖貼回原位（縮圖 → 放大後換全尺寸）
 * - **施工中**的區塊：只塗鏽橘色 —— 完成前看不到圖，只能點進去看數字
 * - 點任何一個地方 → 那一塊的資訊 → 進入區塊頁
 *
 * ★ 底圖（OpenFreeMap）載不到時退回一張純色的底：
 *   區塊與格線是我們自己的資料，不該因為第三方圖磚掛了就整張地圖空白。
 *
 * 地圖上的控制項是與開場畫面同一套毛玻璃 HUD（`hud.tsx`）：搜尋、目前視野、圖例、區塊卡。
 * 「目前視野」的數字都是即時的（中心座標、所在區塊、縮放、畫面裡的區塊狀態）。
 */

import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type StyleSpecification } from "maplibre-gl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { formatTwd } from "@/lib/world/ledger";
import {
  TAIPEI_101,
  blockBounds,
  blockKey,
  blockOf,
  blockShortLabel,
  blocksInBounds,
  type BlockBounds,
} from "@/lib/world/grid";

import { IconArrowRight, IconClose, IconCrosshair, IconMountain, IconPin, IconSearch, glassDark, label } from "./hud";

interface Summary {
  key: string;
  completed: boolean;
  paused: boolean;
  grossMicros: number;
  bounds: BlockBounds;
}

const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#0f1b29" } }],
};

/** `N25.0340° E121.5645°`；南半球、西半球寫 S、W，不寫負號 */
function coordLabel(lat: number, lng: number): string {
  const hemi = (v: number, pos: string, neg: string) => `${v < 0 ? neg : pos}${Math.abs(v).toFixed(4)}°`;
  return `${hemi(lat, "N", "S")} ${hemi(lng, "E", "W")}`;
}

const GRID_MIN_ZOOM = 12;
/** 同時貼在地圖上的完成區塊上限（每一塊是一個 image source） */
const MAX_IMAGE_SOURCES = 250;

function polygon(b: BlockBounds): { type: "Polygon"; coordinates: number[][][] } {
  return {
    type: "Polygon",
    coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
  };
}

interface ViewState {
  readonly lat: number;
  readonly lng: number;
  readonly zoom: number;
  readonly key: string;
  readonly completed: number;
  readonly underway: number;
}

export function WorldMap({ styleUrl, twdPerUsd }: { styleUrl: string; twdPerUsd: number }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const router = useRouter();
  const [selected, setSelected] = useState<{ key: string; label: string; summary: Summary | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [coords, setCoords] = useState("");
  const [view, setView] = useState<ViewState | null>(null);
  const summaries = useRef(new Map<string, Summary>());

  useEffect(() => {
    if (!host.current) return;
    const map = new maplibregl.Map({
      container: host.current,
      style: styleUrl,
      center: [TAIPEI_101.lng, TAIPEI_101.lat],
      zoom: 14,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    let loaded = false;
    let fellBack = false;
    const fallback = () => {
      if (fellBack) return;
      fellBack = true;
      setNote("底圖載入失敗，改用純色底圖（區塊資料不受影響）");
      map.setStyle(BLANK_STYLE);
    };
    const timer = setTimeout(() => {
      if (!loaded) fallback();
    }, 8000);
    map.on("error", () => {
      if (!loaded) fallback();
    });

    const imageSources = new Set<string>();
    let fetchSeq = 0;

    const install = () => {
      if (map.getSource("grid")) return;
      map.addSource("grid", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("blocks", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addSource("origin", { type: "geojson", data: { type: "Feature", properties: {}, geometry: polygon(blockBounds(blockOf(TAIPEI_101))) } });
      map.addLayer({
        id: "blocks-fill",
        type: "fill",
        source: "blocks",
        filter: ["!=", ["get", "completed"], true],
        paint: {
          "fill-color": ["case", ["get", "paused"], "#94a3b8", "#fbbf24"],
          "fill-opacity": 0.38,
        },
      });
      map.addLayer({
        id: "grid-line",
        type: "line",
        source: "grid",
        paint: { "line-color": "#ffffff", "line-opacity": 0.18, "line-width": 1 },
      });
      map.addLayer({
        id: "origin-line",
        type: "line",
        source: "origin",
        paint: { "line-color": "#bae6fd", "line-width": 2.5, "line-dasharray": [2, 1.5] },
      });
    };

    const refresh = async () => {
      if (!map.getSource("grid")) return;
      const z = map.getZoom();
      const b = map.getBounds();
      const bounds: BlockBounds = { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };

      // 格線
      const grid = z >= GRID_MIN_ZOOM ? blocksInBounds(bounds, 8000) : null;
      (map.getSource("grid") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: (grid ?? []).map((id) => ({ type: "Feature", properties: {}, geometry: polygon(blockBounds(id)) })),
      });

      // 狀態
      const seq = ++fetchSeq;
      const q = new URLSearchParams({
        south: String(bounds.south),
        north: String(bounds.north),
        west: String(bounds.west),
        east: String(bounds.east),
      });
      try {
        const res = await fetch(`/api/blocks?${q}`);
        const json = (await res.json()) as { blocks?: Summary[]; tooWide?: boolean; error?: string };
        if (seq !== fetchSeq) return;
        if (!res.ok) {
          setNote(json.error ?? `HTTP ${res.status}`);
          return;
        }
        for (const s of json.blocks ?? []) summaries.current.set(s.key, s);
        // 資料還沒回來就點了某一塊：回來之後補上它的狀態，不要停在「還沒有人捐款」
        setSelected((sel) => (sel && !sel.summary && summaries.current.has(sel.key) ? { ...sel, summary: summaries.current.get(sel.key)! } : sel));
        const c = map.getCenter();
        setView({
          lat: c.lat,
          lng: c.lng,
          zoom: z,
          key: blockKey(blockOf({ lat: c.lat, lng: c.lng })),
          completed: (json.blocks ?? []).filter((x) => x.completed).length,
          underway: (json.blocks ?? []).filter((x) => !x.completed).length,
        });
        (map.getSource("blocks") as GeoJSONSource).setData({
          type: "FeatureCollection",
          features: (json.blocks ?? []).map((s) => ({
            type: "Feature",
            properties: { key: s.key, completed: s.completed, paused: s.paused },
            geometry: polygon(s.bounds),
          })),
        });
        // 完成的區塊：把底圖貼回原位
        const size = z >= 15 ? "full" : "thumb";
        for (const s of json.blocks ?? []) {
          if (!s.completed) continue;
          const id = `tile-${s.key}-${size}`;
          if (imageSources.has(id) || imageSources.size >= MAX_IMAGE_SOURCES) continue;
          const { west, east, north, south } = s.bounds;
          map.addSource(id, {
            type: "image",
            url: `/api/blocks/${s.key}/art/TILE/0?size=${size}`,
            coordinates: [[west, north], [east, north], [east, south], [west, south]],
          });
          map.addLayer({ id, type: "raster", source: id, paint: { "raster-opacity": 0.95 } }, "grid-line");
          imageSources.add(id);
        }
      } catch {
        if (seq === fetchSeq) setNote("區塊資料載入失敗");
      }
    };

    map.on("load", () => {
      loaded = true;
      clearTimeout(timer);
    });
    // 每次換樣式（含退回純色底）都要重新裝上我們的圖層
    map.on("style.load", () => {
      imageSources.clear();
      install();
      void refresh();
    });
    map.on("moveend", () => void refresh());
    map.on("click", (e) => {
      const id = blockOf({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      const key = blockKey(id);
      setSelected({ key, label: blockShortLabel(id), summary: summaries.current.get(key) ?? null });
    });

    return () => {
      clearTimeout(timer);
      map.remove();
      mapRef.current = null;
    };
  }, [styleUrl]);

  const goto = () => {
    const m = /(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/.exec(coords);
    if (!m) {
      setNote("輸入格式：緯度, 經度（例如 25.0340, 121.5645）");
      return;
    }
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) > 85 || Math.abs(lng) > 180) {
      setNote("座標超出範圍");
      return;
    }
    const b = blockBounds(blockOf({ lat, lng }));
    mapRef.current?.fitBounds([[b.west - 0.01, b.south - 0.01], [b.east + 0.01, b.north + 0.01]] as LngLatBoundsLike);
  };

  const status = selected?.summary
    ? selected.summary.completed
      ? { text: "已完成 —— 可以進入", tone: "text-emerald-200" }
      : selected.summary.paused
        ? { text: "施工暫停", tone: "text-slate-300" }
        : { text: "施工中 —— 完成前只看得到經費與進度", tone: "text-amber-200" }
    : { text: "還沒有人捐款 —— 第一筆捐款就會開始勘查", tone: "text-white/70" };

  return (
    <div className="relative min-h-0 flex-1 bg-[#0f1b29]" data-testid="world-map">
      {/* ★ inline style：MapLibre 的 CSS 會把容器設成 position: relative，
          蓋掉 class 上的 absolute —— 畫布就縮成預設的 300px 高 */}
      <div ref={host} style={{ position: "absolute", inset: 0 }} />

      {/* HUD 疊在地圖上：容器不吃滑鼠，卡片本身才吃 —— 拖曳地圖不會被透明的空白擋住 */}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col gap-2 pr-12 sm:pr-14">
        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              goto();
            }}
            className={`${glassDark} pointer-events-auto flex items-center gap-2 py-1.5 pl-3 pr-1.5`}
          >
            <span className="text-white/60">
              <IconSearch />
            </span>
            <input
              value={coords}
              onChange={(e) => setCoords(e.target.value)}
              placeholder="緯度, 經度"
              aria-label="前往座標（緯度, 經度）"
              className="w-32 bg-transparent text-sm text-white outline-none placeholder:text-white/40 sm:w-40"
            />
            <button
              type="submit"
              className="rounded-full bg-gradient-to-r from-sky-300/90 to-sky-100/90 px-3 py-1 text-sm font-semibold text-slate-900"
            >
              前往
            </button>
          </form>
          <button
            type="button"
            onClick={() => mapRef.current?.flyTo({ center: [TAIPEI_101.lng, TAIPEI_101.lat], zoom: 14 })}
            className={`${glassDark} pointer-events-auto flex items-center gap-2 px-3 py-2 text-sm text-white`}
          >
            <span className="text-sky-200">
              <IconMountain />
            </span>
            臺北 101
          </button>
        </div>

        {view ? (
          <section className={`${glassDark} pointer-events-auto hidden w-72 p-4 md:block`} aria-label="目前視野">
            <div className={`${label} flex items-center gap-2`}>
              <IconCrosshair className="h-4 w-4" /> 目前視野
            </div>
            <div className="mt-2 text-lg font-semibold text-white">
              {coordLabel(view.lat, view.lng)}
            </div>
            <div className="text-xs text-white/60">中心所在區塊 {view.key}</div>
            <div className="mt-3 grid grid-cols-3 border-t border-white/15 pt-2 text-sm">
              <div>
                <div className="text-[11px] text-white/55">縮放</div>
                <div className="text-white">{view.zoom.toFixed(1)}</div>
              </div>
              <div className="border-l border-white/15 pl-2">
                <div className="text-[11px] text-white/55">已完成</div>
                <div className="text-white">{view.completed}</div>
              </div>
              <div className="border-l border-white/15 pl-2">
                <div className="text-[11px] text-white/55">施工中</div>
                <div className="text-white">{view.underway}</div>
              </div>
            </div>
            {view.zoom < GRID_MIN_ZOOM ? (
              <p className="mt-2 text-[11px] text-white/50">放大到 {GRID_MIN_ZOOM} 以上才畫 0.01° 格線</p>
            ) : null}
          </section>
        ) : null}
      </div>

      <div
        className={`${glassDark} pointer-events-none absolute bottom-6 left-3 flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-[11px] text-white/80`}
      >
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-300/80" />
          已完成（可進入，貼著它的地圖）
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400/70" />
          有捐款、施工中
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-dashed border-sky-200" />
          原點 · 臺北 101
        </span>
      </div>

      {note ? (
        <button
          type="button"
          onClick={() => setNote(null)}
          className={`${glassDark} absolute right-3 top-28 max-w-xs border-red-300/40 px-3 py-2 text-left text-xs text-red-200`}
        >
          {note}
        </button>
      ) : null}

      {selected ? (
        <section
          data-testid="block-popup"
          className={`${glassDark} absolute bottom-20 left-1/2 w-[min(24rem,calc(100%-1.5rem))] -translate-x-1/2 p-4`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className={`${label} flex items-center gap-2`}>
              <IconPin /> 區塊 {selected.key}
            </div>
            <button type="button" onClick={() => setSelected(null)} className="text-white/60 hover:text-white" aria-label="關閉">
              <IconClose />
            </button>
          </div>
          <div className="mt-1 text-2xl font-semibold text-white">{selected.label}</div>
          <p className={`mt-0.5 text-sm ${status.tone}`}>{status.text}</p>
          {selected.summary && !selected.summary.completed ? (
            <p className="mt-1 text-xs text-white/60">已募得 {formatTwd(selected.summary.grossMicros, twdPerUsd)}</p>
          ) : null}
          <button
            type="button"
            onClick={() => router.push(`/b/${selected.key}`)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-full border border-white/40 bg-gradient-to-r from-sky-300/90 to-sky-100/90 px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-[0_0_20px_rgba(186,230,253,0.35)]"
          >
            {selected.summary?.completed ? "進入這一塊" : "看經費、捐款、投票"} <IconArrowRight className="h-4 w-4" />
          </button>
        </section>
      ) : null}
    </div>
  );
}
