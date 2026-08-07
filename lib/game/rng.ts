/**
 * 決定性亂數。純函式，無 I/O。
 *
 * 同一個 seed 必須在任何機器、任何時間產生完全相同的序列 ——
 * 地圖生成、出生點分配與賽季模擬都靠這一點才能重現。
 * 所以這裡**不使用** `Math.random()`，也不依賴任何平台特性。
 */

export interface Rng {
  /** [0, 1) */
  (): number;
}

/** mulberry32 —— 32 bit 狀態、週期 2^32，對地圖生成綽綽有餘 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 由字串產生 32 bit 種子（FNV-1a）。
 * 讓賽季 seed 可以是人看得懂的字串，例如 `"S01-2026-08"`。
 */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 從同一個母 seed 衍生出互不相關的子 seed，讓各階段的亂數彼此獨立 */
export function deriveSeed(seed: number, label: string): number {
  return (hashSeed(label) ^ Math.imul(seed, 0x9e3779b1)) >>> 0;
}

/** [min, max] 之間的整數 */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** [min, max) 之間的浮點數 */
export function randRange(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Fisher–Yates，原地洗牌 */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i]!;
    const b = items[j]!;
    items[i] = b;
    items[j] = a;
  }
  return items;
}
