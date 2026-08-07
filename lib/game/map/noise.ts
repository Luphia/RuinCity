/**
 * 決定性 Perlin 雜訊與 fBm。純函式，無 I/O。
 *
 * 只需要 2D，而且只在賽季生成時跑一次 500×500 × 3 層 ——
 * 所以優先選**看得懂、可重現**的實作，而不是最快的那一種。
 */

import { mulberry32, shuffle, type Rng } from "../rng";

const GRAD = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export interface Noise2D {
  (x: number, y: number): number;
}

function fade(t: number): number {
  // 6t^5 − 15t^4 + 10t^3，一階與二階導數在端點皆為 0
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 建立一張 Perlin 雜訊，輸出範圍約 [-1, 1] */
export function perlin2D(seed: number): Noise2D {
  const rng: Rng = mulberry32(seed);
  const perm = shuffle(
    rng,
    Array.from({ length: 256 }, (_, i) => i),
  );
  // 複製一份避免每次取值都要 % 256
  const p = new Uint8Array(512);
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255]!;

  const dot = (hash: number, x: number, y: number) => {
    const g = GRAD[hash & 7]!;
    return g[0] * x + g[1] * y;
  };

  return (x, y) => {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const aa = p[p[xi]! + yi]!;
    const ab = p[p[xi]! + yi + 1]!;
    const ba = p[p[xi + 1]! + yi]!;
    const bb = p[p[xi + 1]! + yi + 1]!;

    const x1 = lerp(dot(aa, xf, yf), dot(ba, xf - 1, yf), u);
    const x2 = lerp(dot(ab, xf, yf - 1), dot(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  };
}

export interface FbmOptions {
  octaves?: number;
  /** 每一層的頻率倍率 */
  lacunarity?: number;
  /** 每一層的振幅倍率 */
  gain?: number;
  /** 基礎頻率（格 → 雜訊座標的縮放） */
  frequency?: number;
}

/** 疊加多層 Perlin。地形需要「大塊的山脈 + 細碎的邊緣」，單層做不到 */
export function fbm2D(seed: number, opts: FbmOptions = {}): Noise2D {
  const octaves = opts.octaves ?? 5;
  const lacunarity = opts.lacunarity ?? 2;
  const gain = opts.gain ?? 0.5;
  const frequency = opts.frequency ?? 1 / 90;

  // 每一層用不同的 seed，否則各層會完全對齊
  const layers = Array.from({ length: octaves }, (_, i) => perlin2D(seed + i * 7919));

  let norm = 0;
  let amp = 1;
  for (let i = 0; i < octaves; i++) {
    norm += amp;
    amp *= gain;
  }

  return (x, y) => {
    let total = 0;
    let a = 1;
    let f = frequency;
    for (let i = 0; i < octaves; i++) {
      total += layers[i]!(x * f, y * f) * a;
      f *= lacunarity;
      a *= gain;
    }
    return total / norm;
  };
}

/**
 * 依**分位數**求門檻值，而不是硬寫一個雜訊值。
 *
 * ★ 這是地形佔比能精準命中 `docs/01` §2 的關鍵。
 *   Perlin 的輸出分布會隨 octave 設定漂移，硬寫門檻的話
 *   「山脈 2%」實際可能跑出 0.4% 或 5%。取分位數則與分布無關。
 */
export function quantile(values: Float32Array, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx]!;
}
