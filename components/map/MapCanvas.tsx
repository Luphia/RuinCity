"use client";

/**
 * 地圖畫布。PixiJS 場景 + 手勢。
 * 對應 docs/09-art-ux.md §5.2。
 *
 * React 只持有**相機狀態**與手勢，實際的繪製全在 `lib/render/scene.ts`。
 * 這條界線很重要：相機是純運算（可測），繪製需要 GPU（測不了）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { MAP } from "@/lib/game/balance";
import type { MapScene, SceneData, SceneStats } from "@/lib/render/scene";
import {
  centerOn,
  clampViewport,
  panBy,
  screenToWorld,
  snapTilePixels,
  stepZoom,
  zoomAt,
  zoomSpecFor,
  type Viewport,
} from "@/lib/render/viewport";

export interface MapCanvasProps {
  data: SceneData | null;
  /** 初始相機位置（通常是玩家自己的據點） */
  focus?: { x: number; y: number };
  /** 每 +1 一次就把相機拉回 focus —— 「回家」按鈕的訊號線 */
  recenterNonce?: number;
  onSelectTile?: (tile: { x: number; y: number }) => void;
  onStats?: (stats: SceneStats) => void;
}

/** 手指移動超過這個距離就算拖曳，不算點擊 */
const TAP_SLOP_PX = 8;
const DOUBLE_TAP_MS = 280;

export function MapCanvas({ data, focus, recenterNonce, onSelectTile, onStats }: MapCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<MapScene | null>(null);

  // 相機放在 ref 而不是 state：它每幀都會變，用 state 會觸發 React 重繪
  const viewportRef = useRef<Viewport>({
    centerX: MAP.width / 2,
    centerY: MAP.height / 2,
    tilePixels: 8,
    screenWidth: 1,
    screenHeight: 1,
  });

  const [ready, setReady] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [zoomLabel, setZoomLabel] = useState("區域");

  // ── 場景建立 ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    const wrap = wrapRef.current;
    if (!host || !wrap) return;

    /**
     * ★ 每一次 effect 都用**自己新建的 canvas**，不共用一個 ref。
     *
     *   PixiJS 的 `app.destroy(true, …)` 會連 WebGL context 一起銷毀，
     *   而 context 是綁在那個 `<canvas>` 元素上的。
     *
     *   React 19 的 StrictMode 在開發模式會把 effect 跑兩次
     *   （mount → cleanup → mount）。共用同一個 canvas 時的順序是：
     *
     *     1. effect#1 開始建立場景（非同步）
     *     2. cleanup#1 執行，但此時場景還沒建好，`sceneRef` 是 null
     *     3. effect#2 開始在**同一個 canvas** 上建立第二個場景
     *     4. 場景#1 建好了，發現 cancelled → destroy → **context 沒了**
     *     5. 場景#2 拿到一個已死的 context
     *
     *   症狀就是 `Could not retrieve shader source (WebGL context may be
     *   lost)` 加上一串 `Attribute aPosition is not present in the shader`
     *   —— 看起來像 PixiJS 壞了，其實是兩個 Application 搶同一個畫布。
     *
     *   各自持有一個 canvas 之後，#1 銷毀的是自己的那一塊，#2 全新。
     *   這同時也修好「離開地圖頁再回來」的情況，那條路在正式環境也會走到。
     */
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full";
    host.replaceChildren(canvas);

    const width = wrap.clientWidth || 360;
    const height = wrap.clientHeight || 640;
    viewportRef.current = clampViewport({
      ...viewportRef.current,
      screenWidth: width,
      screenHeight: height,
    });

    /**
     * PixiJS 只能在瀏覽器跑，所以動態載入 —— 也讓 server bundle 不含它。
     *
     * ★ 這個 promise **一定要接 catch**。它會失敗的方式不只一種：
     *   chunk 載不到（dev cache 壞掉、CDN 掉一個檔）、WebGL 不可用
     *   （虛擬機、關掉硬體加速的瀏覽器）、GPU context 被系統回收。
     *
     *   沒有 catch 的話，rejection 被吞掉、`ready` 永遠是 false，
     *   畫面就停在「載入中…」——**沒有錯誤、沒有提示、沒有重試**。
     *   使用者看到的是「地圖打不開」，而 console 以外沒有任何線索。
     */
    const pending = (async () => {
      const { MapScene } = await import("@/lib/render/scene");
      return MapScene.create(canvas, width, height);
    })();

    void pending
      .then((scene) => {
        if (cancelled) {
          scene.destroy();
          return;
        }
        sceneRef.current = scene;
        setReady(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        console.error("[map] 場景建立失敗", e);
        setSceneError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      sceneRef.current = null;
      /**
       * ★ 要等**建立中**的那個 promise 收斂再銷毀。
       *   直接讀 `sceneRef.current` 的話，在還沒建好時它是 null ——
       *   於是那個場景永遠不會被銷毀，WebGL context 就漏掉了。
       */
      void pending.then((scene) => scene.destroy()).catch(() => undefined);
      canvas.remove();
    };
  }, []);

  // ── 資料與初始對焦 ──────────────────────────────────────────
  /**
   * ★ 依賴要用 focus 的**座標**，不能用物件本身。
   *   MapView 每秒因 stats 重繪一次，每次都建一個內容相同的新 focus 物件 ——
   *   拿物件當依賴，這個 effect 就每秒重跑一次 `centerOn`，
   *   玩家平移到哪裡都會在一秒內被拉回出生點。
   */
  const focusX = focus?.x;
  const focusY = focus?.y;
  useEffect(() => {
    if (!ready || !data) return;
    sceneRef.current?.setData(data);
    if (focusX !== undefined && focusY !== undefined) {
      viewportRef.current = centerOn(viewportRef.current, focusX, focusY);
    }
    // recenterNonce 每 +1 就重跑一次 —— 這就是「回家」按鈕的實作
  }, [ready, data, focusX, focusY, recenterNonce]);

  // ── 繪製迴圈 ────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    let raf = 0;
    let lastLabel = "";
    const tick = () => {
      const scene = sceneRef.current;
      if (scene) {
        scene.render(viewportRef.current);
        onStats?.(scene.stats);
        const label = zoomSpecFor(viewportRef.current.tilePixels).label;
        if (label !== lastLabel) {
          lastLabel = label;
          setZoomLabel(label);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, onStats]);

  // ── 視窗尺寸 ────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      viewportRef.current = clampViewport({
        ...viewportRef.current,
        screenWidth: w,
        screenHeight: h,
      });
      sceneRef.current?.resize(w, h);
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  // ── 手勢 ────────────────────────────────────────────────────
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({
    startX: 0,
    startY: 0,
    moved: 0,
    pinchDistance: 0,
    pinchTilePixels: 0,
    lastTapAt: 0,
  });

  const localPoint = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);
    gesture.current.startX = p.x;
    gesture.current.startY = p.y;
    gesture.current.moved = 0;

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      gesture.current.pinchTilePixels = viewportRef.current.tilePixels;
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = localPoint(e);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size >= 2) {
      // 雙指縮放，錨點在兩指中間 —— 手指之間那一點不該移動
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const start = gesture.current.pinchDistance;
      if (start > 0) {
        const anchorX = (a!.x + b!.x) / 2;
        const anchorY = (a!.y + b!.y) / 2;
        viewportRef.current = zoomAt(
          viewportRef.current,
          gesture.current.pinchTilePixels * (distance / start),
          anchorX,
          anchorY,
        );
      }
      return;
    }

    const dx = p.x - prev.x;
    const dy = p.y - prev.y;
    gesture.current.moved += Math.abs(dx) + Math.abs(dy);
    viewportRef.current = panBy(viewportRef.current, dx, dy);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const p = localPoint(e);
      const wasPinching = pointers.current.size >= 2;
      pointers.current.delete(e.pointerId);

      if (wasPinching) {
        // 放開後吸附到最近的層級（`docs/09` §5.2 的「有回彈動畫」）
        viewportRef.current = zoomAt(
          viewportRef.current,
          snapTilePixels(viewportRef.current.tilePixels),
          viewportRef.current.screenWidth / 2,
          viewportRef.current.screenHeight / 2,
        );
        return;
      }

      if (gesture.current.moved > TAP_SLOP_PX) return;

      const now = performance.now();
      if (now - gesture.current.lastTapAt < DOUBLE_TAP_MS) {
        // 雙擊放大一級，以手指位置為錨點
        gesture.current.lastTapAt = 0;
        viewportRef.current = zoomAt(
          viewportRef.current,
          stepZoom(viewportRef.current.tilePixels, 1),
          p.x,
          p.y,
        );
        return;
      }
      gesture.current.lastTapAt = now;

      const tile = screenToWorld(viewportRef.current, p.x, p.y);
      sceneRef.current?.setSelection(tile);
      onSelectTile?.(tile);
    },
    [onSelectTile],
  );

  const onWheel = useCallback((e: React.WheelEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    viewportRef.current = zoomAt(
      viewportRef.current,
      viewportRef.current.tilePixels * factor,
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
  }, []);

  return (
    /**
     * ★ 手勢掛在**外層 div** 而不是 canvas 上：canvas 現在是 effect
     *   自己建的，每次重掛都會換一個元素，React 的事件綁不上去。
     *   外層的 bounding box 與 canvas 完全重合，座標換算不受影響。
     */
    <div
      ref={wrapRef}
      data-testid="map-canvas"
      className="relative h-full w-full touch-none select-none overflow-hidden bg-[#1a1614]"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <div ref={hostRef} className="absolute inset-0" />
      <div
        data-testid="zoom-label"
        className="pointer-events-none absolute right-2 top-2 rounded border border-[#4a413a] bg-[#2e2723]/80 px-2 py-1 text-xs text-[#e8dcc0]"
      >
        {zoomLabel}
      </div>

      {/* ★ 場景起不來時要說話，而不是無限「載入中…」 */}
      {sceneError ? (
        <div
          data-testid="map-scene-error"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#1a1614]/95 p-6 text-center text-[#e8dcc0]"
        >
          <p className="font-bold text-[#c4442f]">地圖畫布起不來</p>
          <p className="max-w-xs text-xs leading-relaxed opacity-80">
            地圖用 WebGL 繪製。瀏覽器關掉硬體加速、或開發時 <code>.next</code>{" "}
            快取壞掉，都會卡在這裡。
          </p>
          <code className="max-w-xs break-all rounded bg-[#2e2723] px-2 py-1 text-[11px] opacity-70">
            {sceneError}
          </code>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded border border-[#8a6b3a] px-4 py-2 text-sm text-[#d9a441]"
          >
            重新載入
          </button>
        </div>
      ) : null}
    </div>
  );
}
