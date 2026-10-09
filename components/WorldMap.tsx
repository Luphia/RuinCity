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
 */

import maplibregl, { type GeoJSONSource, type LngLatBoundsLike, type StyleSpecification } from "maplibre-gl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  TAIPEI_101,
  blockBounds,
  blockKey,
  blockOf,
  blockShortLabel,
  blocksInBounds,
  type BlockBounds,
} from "@/lib/world/grid";

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
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#1f1d1a" } }],
};

const GRID_MIN_ZOOM = 12;
/** 同時貼在地圖上的完成區塊上限（每一塊是一個 image source） */
const MAX_IMAGE_SOURCES = 250;

function polygon(b: BlockBounds): { type: "Polygon"; coordinates: number[][][] } {
  return {
    type: "Polygon",
    coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
  };
}

export function WorldMap({ styleUrl }: { styleUrl: string }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const router = useRouter();
  const [selected, setSelected] = useState<{ key: string; label: string; summary: Summary | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [coords, setCoords] = useState("");
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
          "fill-color": ["case", ["get", "paused"], "#6f6a62", "#c8794a"],
          "fill-opacity": 0.45,
        },
      });
      map.addLayer({
        id: "grid-line",
        type: "line",
        source: "grid",
        paint: { "line-color": "#ece3cf", "line-opacity": 0.22, "line-width": 1 },
      });
      map.addLayer({
        id: "origin-line",
        type: "line",
        source: "origin",
        paint: { "line-color": "#7f9a5a", "line-width": 3 },
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

  return (
    <div className="relative min-h-0 flex-1" data-testid="world-map">
      {/* ★ inline style：MapLibre 的 CSS 會把容器設成 position: relative，
          蓋掉 class 上的 absolute —— 畫布就縮成預設的 300px 高 */}
      <div ref={host} style={{ position: "absolute", inset: 0 }} />

      <div className="absolute left-3 top-3 flex max-w-[calc(100%-4rem)] flex-wrap items-center gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            goto();
          }}
          className="bg-ink/85 border-ink-mid flex items-center gap-1 rounded border px-2 py-1"
        >
          <input
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
            placeholder="緯度, 經度"
            className="text-parchment placeholder:text-ash-deep w-36 bg-transparent text-sm outline-none"
          />
          <button type="submit" className="text-rust text-sm">
            前往
          </button>
        </form>
        <button
          type="button"
          onClick={() => mapRef.current?.flyTo({ center: [TAIPEI_101.lng, TAIPEI_101.lat], zoom: 14 })}
          className="bg-ink/85 border-ink-mid text-moss rounded border px-2 py-1 text-sm"
        >
          臺北 101
        </button>
      </div>

      <div className="bg-ink/85 border-ink-mid text-ash absolute bottom-6 left-3 flex flex-wrap gap-x-3 gap-y-1 rounded border px-2 py-1 text-[11px]">
        <span>
          <span className="bg-moss mr-1 inline-block h-2 w-2 align-middle" />
          已完成（可進入）
        </span>
        <span>
          <span className="bg-rust mr-1 inline-block h-2 w-2 align-middle" />
          有捐款、施工中
        </span>
        <span>
          <span className="border-moss mr-1 inline-block h-2 w-2 border-2 align-middle" />
          原點 · 臺北 101
        </span>
      </div>

      {note ? (
        <button
          type="button"
          onClick={() => setNote(null)}
          className="bg-ink/90 border-alarm text-alarm absolute right-3 top-14 max-w-xs rounded border px-2 py-1 text-left text-xs"
        >
          {note}
        </button>
      ) : null}

      {selected ? (
        <div
          data-testid="block-popup"
          className="bg-ink border-ink-mid absolute bottom-16 left-1/2 w-[min(22rem,calc(100%-1.5rem))] -translate-x-1/2 rounded border p-3 shadow-lg"
        >
          <div className="flex items-baseline justify-between gap-2">
            <b>{selected.label}</b>
            <button type="button" onClick={() => setSelected(null)} className="text-ash text-xs">
              關閉
            </button>
          </div>
          <p className="text-ash mt-1 text-xs">
            {selected.summary?.completed
              ? "已完成 —— 可以進入"
              : selected.summary?.paused
                ? "施工暫停"
                : selected.summary
                  ? "施工中 —— 完成前只看得到經費與進度"
                  : "還沒有人捐款 —— 第一筆捐款就會開始勘查"}
          </p>
          <button
            type="button"
            onClick={() => router.push(`/b/${selected.key}`)}
            className="bg-rust text-ink mt-2 w-full rounded px-3 py-2 text-sm font-bold"
          >
            {selected.summary?.completed ? "進入這一塊" : "看經費、捐款、投票"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
