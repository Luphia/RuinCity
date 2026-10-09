"use client";

/**
 * 漫遊：全螢幕，第三人稱操作一個人物在完成的區塊裡走動。
 *
 * 畫面在 `lib/scene/walk-gl.ts`（WebGL，沒有相依套件），移動與鏡頭的數學在 `lib/scene/walk.ts`。
 * 這裡是 HUD：指南針、座標、小地圖、最近的標記座標，以及走到標記旁邊時看 AI 在那裡畫的場景圖。
 * 地景只有正射底圖與高度圖那麼細 —— 每一個標記座標的場景圖才是「站在那裡看到的樣子」。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { RenderSpec } from "@/lib/scene/format";
import { mountWalk, type WalkFrame, type WalkHandle } from "@/lib/scene/walk-gl";
import { WALK_V1, compassLabel, type Bounds } from "@/lib/scene/walk";

import { IconArrowRight, IconClose, IconImage, IconPin, alarm, cta, ghost, glassDark, label } from "./hud";

export interface WalkMarkerInfo {
  readonly index: number;
  readonly lat: number;
  readonly lng: number;
  readonly heading: number;
  readonly caption: string | null;
  /** 這個標記座標的場景圖；沒有就是 null */
  readonly sceneUrl: string | null;
}

const fmt = (v: number, pos: string, neg: string) => `${v < 0 ? neg : pos}${Math.abs(v).toFixed(5)}°`;
const deg = (rad: number) => Math.round(((rad * 180) / Math.PI + 360) % 360);

export function WalkMode({
  blockKey,
  title,
  tileUrl,
  dsmUrl,
  detailUrls,
  aspect,
  bounds,
  markers,
  render,
  onClose,
}: {
  blockKey: string;
  title: string;
  tileUrl: string;
  dsmUrl: string;
  detailUrls: { hard: string | null; green: string | null };
  aspect: number;
  bounds: Bounds;
  markers: readonly WalkMarkerInfo[];
  render: RenderSpec;
  onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<WalkHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [frame, setFrame] = useState<WalkFrame | null>(null);
  const [viewing, setViewing] = useState<WalkMarkerInfo | null>(null);
  const [run, setRun] = useState(false);

  // 互動鍵與 Esc 要讀「現在」的狀態：放在 ref，給 GL 的回呼與鍵盤事件用
  const live = useRef({ frame: null as WalkFrame | null, viewing: null as WalkMarkerInfo | null });
  const close = useRef(onClose);
  useEffect(() => {
    live.current.frame = frame;
    live.current.viewing = viewing;
    close.current = onClose;
    handle.current?.setPaused(viewing !== null);
  });

  const byIndex = useMemo(() => new Map(markers.map((m) => [m.index, m])), [markers]);
  const nearMarker = (f: WalkFrame | null) =>
    f?.nearest && f.nearest.distanceM <= WALK_V1.markerRadiusM ? (byIndex.get(f.nearest.index) ?? null) : null;

  const interact = useRef(() => {
    if (live.current.viewing) {
      setViewing(null);
      return;
    }
    const m = nearMarker(live.current.frame);
    if (m?.sceneUrl) setViewing(m);
  });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const h = mountWalk(el, {
      tileUrl,
      dsmUrl,
      detailUrls,
      aspect,
      bounds,
      markers: markers.map((m) => ({ index: m.index, lat: m.lat, lng: m.lng, heading: m.heading })),
      startMarker: markers[0]?.index ?? null,
      render,
      spec: WALK_V1,
      onReady: () => setReady(true),
      onError: (msg) => setError(msg),
      onFrame: (f) => setFrame(f),
      onInteract: () => interact.current(),
    });
    handle.current = h;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (live.current.viewing) setViewing(null);
      else close.current();
    };
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      h.dispose();
      handle.current = null;
    };
    // 掛載一次：這些值在漫遊期間不會變（換一塊就是重新打開）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const near = nearMarker(frame);
  const nearest = frame?.nearest ? byIndex.get(frame.nearest.index) : undefined;
  // 最近的標記相對於鏡頭的方向（指示箭頭用）
  const relative = frame?.nearest ? frame.nearest.bearing - frame.cameraYaw : 0;

  return (
    <div className="fixed inset-0 z-50 bg-[#0b1420]" data-testid="walk-mode" role="dialog" aria-label={`漫遊 ${title}`}>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />

      {!ready && !error ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className={`${glassDark} px-5 py-4 text-sm text-white/80`}>載入地形與材質…</div>
        </div>
      ) : null}
      {error ? (
        <div className="absolute inset-0 grid place-items-center p-4">
          <div className={`${glassDark} flex max-w-sm flex-col gap-3 p-5`}>
            <p className={alarm}>{error}</p>
            <button type="button" className={ghost} onClick={onClose}>
              返回
            </button>
          </div>
        </div>
      ) : null}

      {/* 左上：位置與方向 */}
      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-5rem)] flex-col gap-2">
        <div className={`${glassDark} px-4 py-3`}>
          <div className={`${label} flex items-center gap-2`}>
            <IconPin /> 漫遊 · 區塊 {blockKey}
          </div>
          <div className="mt-1 text-lg font-semibold text-white">{title}</div>
          {frame ? (
            <div
              className="mt-1 flex flex-wrap items-center gap-x-3 text-xs tabular-nums text-white/65"
              data-testid="walk-position"
              data-u={frame.u.toFixed(5)}
              data-t={frame.t.toFixed(5)}
              data-blocked={frame.blocked ?? ""}
            >
              <span>
                {fmt(frame.lat, "N", "S")} {fmt(frame.lng, "E", "W")}
              </span>
              <span className="flex items-center gap-1 text-sky-100">
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden style={{ transform: `rotate(${deg(frame.facing)}deg)` }}>
                  <path d="M12 3 17 19 12 15 7 19Z" fill="currentColor" />
                </svg>
                {compassLabel(frame.facing)} {deg(frame.facing)}°
              </span>
              {frame.speedMps > 0.1 ? <span>{frame.speedMps.toFixed(1)} m/s</span> : null}
            </div>
          ) : null}
        </div>
        {frame?.blocked === "EDGE" ? (
          <div className={`${glassDark} px-3 py-2 text-xs text-amber-100`}>這一塊的邊界 —— 相鄰的區塊不在這個場景裡</div>
        ) : null}
      </div>

      {/* 右上：離開 */}
      <button
        type="button"
        onClick={onClose}
        className={`${glassDark} absolute right-3 top-3 flex items-center gap-2 px-3 py-2 text-sm text-white/85 hover:text-white`}
        data-testid="walk-close"
      >
        <IconClose /> <span className="hidden sm:inline">離開漫遊（Esc）</span>
      </button>

      {/* 下方中央：最近的標記座標 */}
      {ready && nearest && frame?.nearest ? (
        <div className="absolute inset-x-0 bottom-28 flex justify-center px-3 sm:bottom-6">
          {near ? (
            <button
              type="button"
              onClick={() => interact.current()}
              disabled={!near.sceneUrl}
              data-testid="walk-interact"
              className={`${glassDark} flex max-w-md items-center gap-3 px-4 py-3 text-left text-sm text-white`}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-sky-200/60 text-sky-100">
                <IconImage className="h-5 w-5" />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">標記 #{near.index + 1}{near.caption ? ` · ${near.caption}` : ""}</span>
                <span className="block text-xs text-white/60">
                  {near.sceneUrl ? "查看 AI 在這裡畫的景象" : "這個標記沒有場景圖"}
                  <kbd className="ml-2 hidden rounded border border-white/30 px-1.5 text-[10px] text-white/80 pointer-fine:inline">E</kbd>
                </span>
              </span>
            </button>
          ) : (
            <div className={`${glassDark} flex items-center gap-2 px-3 py-2 text-xs text-white/75`}>
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-sky-200" aria-hidden style={{ transform: `rotate(${(relative * 180) / Math.PI}deg)` }}>
                <path d="M12 3 18 15H6Z" fill="currentColor" />
              </svg>
              最近的標記 #{nearest.index + 1} · {Math.round(frame.nearest.distanceM)} m
            </div>
          )}
        </div>
      ) : null}

      {/* 右下：小地圖 */}
      {ready && frame ? (
        <div className={`${glassDark} pointer-events-none absolute bottom-3 right-3 hidden overflow-hidden p-1.5 sm:block`}>
          <div className="relative w-40 overflow-hidden rounded-xl" style={{ aspectRatio: `1 / ${aspect}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- 區塊圖從自己的 API 出 */}
            <img src={`${tileUrl}${tileUrl.includes("?") ? "&" : "?"}size=thumb`} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" />
            {markers.map((m) => (
              <span
                key={m.index}
                className={`absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${near?.index === m.index ? "bg-sky-200" : "bg-amber-300/80"}`}
                style={{
                  left: `${((m.lng - bounds.west) / (bounds.east - bounds.west)) * 100}%`,
                  top: `${((bounds.north - m.lat) / (bounds.north - bounds.south)) * 100}%`,
                }}
              />
            ))}
            <svg
              viewBox="0 0 24 24"
              className="absolute h-4 w-4 text-white drop-shadow"
              style={{ left: `${frame.u * 100}%`, top: `${frame.t * 100}%`, transform: `translate(-50%, -50%) rotate(${deg(frame.facing)}deg)` }}
              aria-hidden
            >
              <path d="M12 2 19 21 12 16 5 21Z" fill="currentColor" stroke="#0b1420" strokeWidth="1.5" />
            </svg>
          </div>
        </div>
      ) : null}

      {/* 左下：操作說明（鍵盤） */}
      {ready ? (
        <div className={`${glassDark} pointer-events-none absolute bottom-3 left-3 hidden px-3 py-2 text-xs text-white/70 pointer-fine:block`}>
          <Kbd>W A S D</Kbd> 移動 · <Kbd>Shift</Kbd> 跑 · 拖曳 轉視角 · 滾輪 拉近 · <Kbd>E</Kbd> 查看
        </div>
      ) : null}

      {/* 觸控：搖桿、跑步、查看 */}
      {ready ? (
        <div className="absolute inset-x-3 bottom-3 hidden items-end justify-between pointer-coarse:flex">
          <Joystick onChange={(f, r) => handle.current?.setStick(f, r)} />
          <button
            type="button"
            onClick={() => {
              setRun((v) => !v);
              handle.current?.setRun(!run);
            }}
            className={`${glassDark} h-14 w-14 text-xs ${run ? "text-amber-200" : "text-white/80"}`}
            aria-pressed={run}
          >
            {run ? "跑步" : "走路"}
          </button>
        </div>
      ) : null}

      {/* 場景圖：走到標記旁邊按 E */}
      {viewing ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/80 p-3 backdrop-blur-sm" data-testid="walk-scene">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={viewing.sceneUrl!} alt={viewing.caption ?? `標記 ${viewing.index + 1}`} className="max-h-[78vh] w-auto max-w-full rounded-xl shadow-2xl" />
          <div className={`${glassDark} flex max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm text-white`}>
            <span className="font-semibold">
              標記 #{viewing.index + 1} · 朝向 {Math.round(viewing.heading)}°
            </span>
            {viewing.caption ? <span className="text-white/70">{viewing.caption}</span> : null}
            <button type="button" className={`${cta} px-4 py-1.5 text-sm`} onClick={() => setViewing(null)}>
              繼續走 <IconArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-white/25 px-1 text-[10px] text-white/85">{children}</kbd>;
}

/** 觸控搖桿：拖離中心的方向與距離 → 前後、左右（-1..1） */
function Joystick({ onChange }: { onChange: (forward: number, right: number) => void }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const base = useRef<HTMLDivElement>(null);
  const R = 44;
  const move = (e: React.PointerEvent) => {
    const el = base.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx = (dx / d) * R;
      dy = (dy / d) * R;
    }
    setKnob({ x: dx, y: dy });
    onChange(-dy / R, dx / R);
  };
  const end = () => {
    setKnob({ x: 0, y: 0 });
    onChange(0, 0);
  };
  return (
    <div
      ref={base}
      data-testid="walk-joystick"
      className={`${glassDark} relative h-28 w-28 touch-none rounded-full`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <span
        className="absolute left-1/2 top-1/2 h-12 w-12 rounded-full border border-white/40 bg-white/20"
        style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
      />
    </div>
  );
}
