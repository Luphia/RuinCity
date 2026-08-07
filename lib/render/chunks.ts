/**
 * Chunk 幾何與貼圖建構。純函式，無 I/O。
 * 對應 docs/01-world-map.md §3.2。
 *
 * ## ★ 為什麼地形不是「一格一個 sprite」
 *
 * 500×500 = 250,000 格。L3（2px/格）時整張圖都在畫面上，
 * 250,000 個 sprite 在手機上是不可能的 —— 光是遍歷就掉到個位數 FPS。
 *
 * 解法是把**每個 64×64 chunk 烘成一張 64×64 的貼圖**（一格一像素），
 * 再用一個 sprite 畫出來、放大 `tilePixels` 倍。
 * 配上 `NEAREST` 取樣，放大後每格就是一個銳利的色塊 —— 正是像素風要的效果。
 *
 * 於是整張地圖**永遠只有 64 個 sprite**，而且還能視野剔除到只剩 1–9 個。
 * 這是整個渲染層唯一真正重要的決定。
 */

import { MAP } from "../game/balance";
import { TERRAIN_RGB } from "./palette";
import type { TileRect } from "./viewport";

/** `docs/01` §3.2：切成 64×64 的 chunk */
export const CHUNK_SIZE = 64;
export const CHUNK_COLS = Math.ceil(MAP.width / CHUNK_SIZE);
export const CHUNK_ROWS = Math.ceil(MAP.height / CHUNK_SIZE);
export const CHUNK_COUNT = CHUNK_COLS * CHUNK_ROWS;

export interface ChunkId {
  readonly cx: number;
  readonly cy: number;
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx}_${cy}`;
}

export function chunkOfTile(x: number, y: number): ChunkId {
  return { cx: Math.floor(x / CHUNK_SIZE), cy: Math.floor(y / CHUNK_SIZE) };
}

/** 視野剔除：目前的世界格範圍需要哪些 chunk */
export function visibleChunks(rect: TileRect): ChunkId[] {
  const out: ChunkId[] = [];
  const cx0 = Math.max(0, Math.floor(rect.minX / CHUNK_SIZE));
  const cx1 = Math.min(CHUNK_COLS - 1, Math.floor(rect.maxX / CHUNK_SIZE));
  const cy0 = Math.max(0, Math.floor(rect.minY / CHUNK_SIZE));
  const cy1 = Math.min(CHUNK_ROWS - 1, Math.floor(rect.maxY / CHUNK_SIZE));
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) out.push({ cx, cy });
  }
  return out;
}

/**
 * 把一個 chunk 的地形碼烘成 RGBA。
 *
 * 每種地形有兩個明度，依 `(x + y) % 2` 交錯 ——
 * 純色塊在 L1（32px/格）下會像沒貼圖的佔位符，
 * 交錯之後即使還沒有美術資源也讀得出地表的顆粒感。
 *
 * 超出地圖範圍的部分畫成全透明（邊界是「深淵」）。
 */
export function chunkToRGBA(codes: Uint8Array, cx: number, cy: number): Uint8Array {
  const out = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 4);
  for (let y = 0; y < CHUNK_SIZE; y++) {
    const worldY = cy * CHUNK_SIZE + y;
    for (let x = 0; x < CHUNK_SIZE; x++) {
      const worldX = cx * CHUNK_SIZE + x;
      const i = (y * CHUNK_SIZE + x) * 4;
      if (worldX >= MAP.width || worldY >= MAP.height) {
        out[i + 3] = 0;
        continue;
      }
      const shades = TERRAIN_RGB[codes[y * CHUNK_SIZE + x]!] ?? TERRAIN_RGB[0]!;
      const [r, g, b] = shades[(worldX + worldY) % 2]!;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * 領土層：把「哪一格屬於哪個聯盟」烘成半透明的色塊貼圖。
 *
 * 跟地形同樣一格一像素，所以整個領土層也只要 64 個 sprite。
 * `owners` 是 0 = 無主，其餘為 `聯盟色索引 + 1`。
 */
export function territoryToRGBA(
  owners: Uint8Array,
  colors: readonly number[],
  alpha = 150,
): Uint8Array {
  const out = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 4);
  for (let i = 0, p = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++, p += 4) {
    const owner = owners[i] ?? 0;
    if (owner === 0) {
      out[p + 3] = 0;
      continue;
    }
    const color = colors[owner - 1] ?? 0x888888;
    out[p] = (color >> 16) & 0xff;
    out[p + 1] = (color >> 8) & 0xff;
    out[p + 2] = color & 0xff;
    out[p + 3] = alpha;
  }
  return out;
}

/** chunk 在世界座標中的左上角格座標 */
export function chunkOrigin(cx: number, cy: number) {
  return { x: cx * CHUNK_SIZE, y: cy * CHUNK_SIZE };
}

/** 依「離畫面中心的遠近」排序，讓最重要的 chunk 先載入 */
export function sortByDistanceToCenter(
  chunks: readonly ChunkId[],
  centerTileX: number,
  centerTileY: number,
): ChunkId[] {
  const ccx = centerTileX / CHUNK_SIZE;
  const ccy = centerTileY / CHUNK_SIZE;
  return chunks
    .slice()
    .sort(
      (a, b) =>
        (a.cx - ccx) ** 2 + (a.cy - ccy) ** 2 - ((b.cx - ccx) ** 2 + (b.cy - ccy) ** 2),
    );
}
