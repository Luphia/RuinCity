/**
 * 調色盤。純資料，無 I/O。
 * 對應 docs/09-art-ux.md §3。
 *
 * 24 色廢土色調 + 15 個聯盟色。所有顏色以 0xRRGGBB 的數字形式存放，
 * 因為 PixiJS 的 tint 與 Graphics 都吃這個格式。
 */

import { TERRAINS, type Terrain } from "../game/balance";

/** 24 色主色盤 */
export const PALETTE = {
  // ── 地形 ──
  sandLight: 0xb8a07e,
  sandDark: 0x8c7758,
  mossLight: 0x6b7f4a,
  mossDark: 0x47562f,
  stoneLight: 0x9a958c,
  stoneDark: 0x6b6862,
  marsh: 0x5c6b4a,
  marshBright: 0x7d9159,
  waterDeep: 0x33454f,

  // ── 結構 ──
  rust: 0xa35a3a,
  rustDark: 0x6e3a26,
  metal: 0x7d8087,
  metalBright: 0xa8aab0,
  wood: 0x7a5a3c,
  woodDark: 0x4d3826,

  // ── 陰影與描邊 ──
  darkest: 0x1a1614,
  dark: 0x2e2723,
  mid: 0x4a413a,

  // ── UI 與強調 ──
  parchment: 0xe8dcc0,
  alert: 0xc4442f,
  /** 整個遊戲最稀有的顏色，只用於遺跡、遺物與勝利相關元素 */
  relicGold: 0xd9a441,
  vitalBlue: 0x4a8fa8,
} as const;

/**
 * 地形色。
 *
 * 每種地形給**兩個**明度，依格子座標的棋盤格交錯 ——
 * 純色塊在 L1（32px/格）下會像沒貼圖的佔位符，
 * 交錯之後即使沒有美術資源也讀得出地表的顆粒感。
 */
export const TERRAIN_COLOR: Record<Terrain, readonly [number, number]> = {
  PLAIN: [PALETTE.sandLight, PALETTE.sandDark],
  RUBBLE: [PALETTE.stoneLight, PALETTE.stoneDark],
  FOREST: [PALETTE.mossLight, PALETTE.mossDark],
  WASTE: [PALETTE.sandDark, PALETTE.mid],
  LODE: [PALETTE.metalBright, PALETTE.metal],
  MARSH: [PALETTE.marshBright, PALETTE.marsh],
  MOUNTAIN: [PALETTE.darkest, PALETTE.dark],
} as const;

/**
 * 聯盟 15 色（docs/09 §3）。
 *
 * **同陣營的 5 色刻意屬於同一色系**，所以 L3 戰略視圖上
 * 一眼就看得出三大勢力範圍，放大之後才分得出是哪一個聯盟。
 */
export const ALLIANCE_COLORS: Record<1 | 2 | 3, readonly number[]> = {
  1: [0xc4442f, 0xe07a3f, 0xa8563a, 0xd96c8a, 0x8c3d2e], // 灰燼氏族：鏽紅／橙
  2: [0x3f9aa3, 0x4a72c4, 0x2f7f8c, 0x4f5fa8, 0x6fa8b8], // 穹窖商會：青／藍
  3: [0x7fa832, 0x3fa36b, 0x9c9c4a, 0xd9a441, 0x5c8a45], // 鐵搖籃盟：綠／黃
} as const;

/** 無聯盟者為中性灰 */
export const NEUTRAL_TERRITORY = PALETTE.mid;

export function allianceColor(faction: 1 | 2 | 3, alliance: number): number {
  const list = ALLIANCE_COLORS[faction];
  return list[alliance % list.length]!;
}

/**
 * 把 0xRRGGBB 拆成 RGB 位元組。建 chunk 貼圖時每格都要用，
 * 所以刻意不配置物件。
 */
export function rgb(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

export function toCss(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** 地形碼 → 兩個明度的 RGB，建貼圖時查表用 */
export const TERRAIN_RGB: readonly (readonly [
  readonly [number, number, number],
  readonly [number, number, number],
])[] = TERRAINS.map((t) => {
  const [a, b] = TERRAIN_COLOR[t];
  return [rgb(a), rgb(b)] as const;
});
