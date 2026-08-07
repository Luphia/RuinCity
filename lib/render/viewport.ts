/**
 * 相機與縮放。純函式，無 I/O。
 * 對應 docs/01-world-map.md §6 與 docs/09-art-ux.md §5.2。
 *
 * 這一層完全不碰 PixiJS —— 它只是座標運算，因此可以在 node 環境下測試。
 * 渲染層負責把 `Viewport` 的結果套到 container 的 position/scale 上。
 */

import { MAP } from "../game/balance";

export type ZoomLevel = "L1" | "L2" | "L3";

export interface ZoomSpec {
  readonly level: ZoomLevel;
  readonly label: string;
  /** 每格像素 */
  readonly tilePixels: number;
  /** 這個層級要不要畫結構圖示 */
  readonly showStructures: boolean;
  /** 要不要畫聯盟代碼 */
  readonly showAllianceCode: boolean;
  /** 要不要畫名牌 */
  readonly showNameplates: boolean;
  /** 要不要畫區域格線 */
  readonly showRegionGrid: boolean;
}

/** L3 → L1，由遠到近。順序即縮放階梯 */
export const ZOOM_LEVELS: readonly ZoomSpec[] = [
  {
    level: "L3",
    label: "戰略",
    tilePixels: 2,
    showStructures: false,
    showAllianceCode: false,
    showNameplates: false,
    showRegionGrid: true,
  },
  {
    level: "L2",
    label: "區域",
    tilePixels: 8,
    showStructures: true,
    showAllianceCode: true,
    showNameplates: false,
    showRegionGrid: true,
  },
  {
    level: "L1",
    label: "局部",
    tilePixels: 32,
    showStructures: true,
    showAllianceCode: true,
    showNameplates: true,
    showRegionGrid: false,
  },
];

export const MIN_TILE_PX = ZOOM_LEVELS[0]!.tilePixels;
export const MAX_TILE_PX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]!.tilePixels;

/** 目前的每格像素落在哪一個層級。取「不超過它的最大級」 */
export function zoomSpecFor(tilePixels: number): ZoomSpec {
  let spec = ZOOM_LEVELS[0]!;
  for (const z of ZOOM_LEVELS) if (tilePixels >= z.tilePixels) spec = z;
  return spec;
}

/** 縮放吸附：雙指放開後回彈到最近的層級（docs/09 §5.2） */
export function snapTilePixels(tilePixels: number): number {
  let best = ZOOM_LEVELS[0]!;
  let bestDist = Infinity;
  for (const z of ZOOM_LEVELS) {
    // 以 log 距離比較，否則 2→8 與 8→32 的「中點」會偏得離譜
    const d = Math.abs(Math.log(tilePixels / z.tilePixels));
    if (d < bestDist) {
      bestDist = d;
      best = z;
    }
  }
  return best.tilePixels;
}

/** 下一／上一個層級（雙擊放大用） */
export function stepZoom(tilePixels: number, direction: 1 | -1): number {
  const current = zoomSpecFor(tilePixels);
  const i = ZOOM_LEVELS.findIndex((z) => z.level === current.level);
  const next = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i + direction))]!;
  return next.tilePixels;
}

export interface Viewport {
  /** 畫面中心對應的世界座標（格，可為小數） */
  readonly centerX: number;
  readonly centerY: number;
  readonly tilePixels: number;
  /** 畫布尺寸（CSS 像素） */
  readonly screenWidth: number;
  readonly screenHeight: number;
}

export interface TileRect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * 相機能到的中心點範圍。
 *
 * 地圖比畫面小的時候（L3 全圖 1000×1000 可能比手機寬），
 * 中心就鎖在地圖中央 —— 否則使用者可以把地圖拖出畫面外，
 * 那是最常見也最惱人的地圖 bug。
 */
export function clampViewport(v: Viewport): Viewport {
  const halfW = v.screenWidth / 2 / v.tilePixels;
  const halfH = v.screenHeight / 2 / v.tilePixels;

  const clampAxis = (center: number, half: number, extent: number) => {
    if (half * 2 >= extent) return extent / 2;
    return Math.min(extent - half, Math.max(half, center));
  };

  return {
    ...v,
    centerX: clampAxis(v.centerX, halfW, MAP.width),
    centerY: clampAxis(v.centerY, halfH, MAP.height),
  };
}

/** 目前看得到的世界格範圍（含邊緣的半格，所以往外多取一格） */
export function visibleTiles(v: Viewport): TileRect {
  const halfW = v.screenWidth / 2 / v.tilePixels;
  const halfH = v.screenHeight / 2 / v.tilePixels;
  return {
    minX: Math.max(0, Math.floor(v.centerX - halfW) - 1),
    minY: Math.max(0, Math.floor(v.centerY - halfH) - 1),
    maxX: Math.min(MAP.width - 1, Math.ceil(v.centerX + halfW) + 1),
    maxY: Math.min(MAP.height - 1, Math.ceil(v.centerY + halfH) + 1),
  };
}

/** 世界格 → 螢幕像素（格的左上角） */
export function worldToScreen(v: Viewport, tileX: number, tileY: number) {
  return {
    x: (tileX - v.centerX) * v.tilePixels + v.screenWidth / 2,
    y: (tileY - v.centerY) * v.tilePixels + v.screenHeight / 2,
  };
}

/** 螢幕像素 → 世界格（取整，落在哪一格） */
export function screenToWorld(v: Viewport, screenX: number, screenY: number) {
  return {
    x: Math.floor((screenX - v.screenWidth / 2) / v.tilePixels + v.centerX),
    y: Math.floor((screenY - v.screenHeight / 2) / v.tilePixels + v.centerY),
  };
}

/**
 * 以某個螢幕點為錨點縮放（雙指縮放時手指之間那一點不該移動）。
 *
 * 少了這個，兩指縮放時地圖會從畫面中心脹縮，
 * 使用者想放大的東西會滑走 —— 是手機地圖最明顯的手感缺陷。
 */
export function zoomAt(v: Viewport, nextTilePixels: number, anchorX: number, anchorY: number) {
  const t = Math.min(MAX_TILE_PX, Math.max(MIN_TILE_PX, nextTilePixels));
  // 錨點在縮放前後對應同一個世界座標
  const worldX = (anchorX - v.screenWidth / 2) / v.tilePixels + v.centerX;
  const worldY = (anchorY - v.screenHeight / 2) / v.tilePixels + v.centerY;
  return clampViewport({
    ...v,
    tilePixels: t,
    centerX: worldX - (anchorX - v.screenWidth / 2) / t,
    centerY: worldY - (anchorY - v.screenHeight / 2) / t,
  });
}

/** 平移（螢幕像素） */
export function panBy(v: Viewport, dxPixels: number, dyPixels: number) {
  return clampViewport({
    ...v,
    centerX: v.centerX - dxPixels / v.tilePixels,
    centerY: v.centerY - dyPixels / v.tilePixels,
  });
}

/** 把相機移到某一格（例如「回到我的據點」） */
export function centerOn(v: Viewport, tileX: number, tileY: number) {
  return clampViewport({ ...v, centerX: tileX + 0.5, centerY: tileY + 0.5 });
}
