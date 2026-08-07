/**
 * 地形層生成。純函式，無 I/O。
 * 對應 docs/01-world-map.md §3.1。
 *
 * 地形在賽季內**永不改變**，所以整層可以一次算完、序列化成靜態檔。
 */

import { MAP, TERRAIN, TERRAINS, type Terrain } from "../balance";
import { deriveSeed, mulberry32, randInt, randRange } from "../rng";
import { fbm2D, quantile } from "./noise";

/** 地形碼：陣列索引即 `TERRAINS` 的索引，序列化時每格 1 byte */
export type TerrainCode = number;

export const TERRAIN_CODE: Record<Terrain, TerrainCode> = Object.fromEntries(
  TERRAINS.map((t, i) => [t, i]),
) as Record<Terrain, TerrainCode>;

export const CODE_TERRAIN: readonly Terrain[] = TERRAINS;

export interface TerrainMap {
  readonly width: number;
  readonly height: number;
  /** `width × height`，row-major。值為 `TERRAIN_CODE` */
  readonly cells: Uint8Array;
}

export const idx = (x: number, y: number, width: number = MAP.width): number =>
  y * width + x;

export function terrainAt(map: TerrainMap, x: number, y: number): Terrain {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return "MOUNTAIN";
  return CODE_TERRAIN[map.cells[idx(x, y, map.width)]!]!;
}

export function isPassable(map: TerrainMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  return map.cells[idx(x, y, map.width)] !== TERRAIN_CODE.MOUNTAIN;
}

const N8: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const N4: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** 山塊小於這個面積就抹平 —— 散落一格的障礙只會讓玩家困惑，不會產生地緣 */
const MIN_MOUNTAIN_BLOB = 6;

/** RUBBLE 的「古城遺址」中心點數量 */
const RUBBLE_CENTRES: readonly [number, number] = [40, 60];

/**
 * ★ 半徑 18–42，而不是 `docs/01` §3.1 寫的 3–8。
 *
 * 3–8 格的半徑配 50 個中心點只覆蓋約 4,750 格（1.9% 的地圖），
 * 而同一份文件的 §2 表格要求 RUBBLE 佔 **18%**。兩者相差近十倍。
 * 這裡取能命中 18% 的半徑，並在最後取前 18% 把佔比鎖死。
 */
const RUBBLE_RADIUS: readonly [number, number] = [18, 42];

export interface TerrainStats {
  /** 每種地形的實際佔比 */
  readonly share: Record<Terrain, number>;
  /** 移除的孤立山塊數 */
  readonly prunedBlobs: number;
  /** 為了打通連通性而抹平的山脈格數 */
  readonly carvedForConnectivity: number;
  /** 最大可通行連通區佔全部可通行格的比例（應為 1） */
  readonly largestPassableShare: number;
}

export interface GeneratedTerrain {
  readonly map: TerrainMap;
  readonly stats: TerrainStats;
}

/**
 * 生成地形層。
 *
 * 兩層雜訊（高度、濕度）決定地形，門檻值一律取**分位數**，
 * 所以 `docs/01` §2 的佔比是被保證的，不是碰運氣碰到的。
 */
export function generateTerrain(seed: number): GeneratedTerrain {
  const { width, height } = MAP;
  const n = width * height;

  const elevationNoise = fbm2D(deriveSeed(seed, "elevation"), {
    octaves: 5,
    frequency: 1 / 110,
  });
  const moistureNoise = fbm2D(deriveSeed(seed, "moisture"), {
    octaves: 4,
    frequency: 1 / 70,
  });

  const elevation = new Float32Array(n);
  const moisture = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y, width);
      elevation[i] = elevationNoise(x, y);
      moisture[i] = moistureNoise(x, y);
    }
  }

  const cells = new Uint8Array(n).fill(TERRAIN_CODE.PLAIN);

  // ── 高度層：山脈（最高 2%）與礦脈（次高 6%）──────────────
  const mountainShare = TERRAIN.MOUNTAIN.share;
  const lodeShare = TERRAIN.LODE.share;
  const mountainCut = quantile(elevation, 1 - mountainShare);
  const lodeCut = quantile(elevation, 1 - mountainShare - lodeShare);
  for (let i = 0; i < n; i++) {
    const e = elevation[i]!;
    if (e >= mountainCut) cells[i] = TERRAIN_CODE.MOUNTAIN;
    else if (e >= lodeCut) cells[i] = TERRAIN_CODE.LODE;
  }

  // ── 濕度層：只作用在剩下的格子上 ─────────────────────────
  // 毒沼要「濕且低」，所以用 moisture − elevation 排序而不是純濕度。
  const rest: number[] = [];
  for (let i = 0; i < n; i++) if (cells[i] === TERRAIN_CODE.PLAIN) rest.push(i);

  const restCount = rest.length;
  const marshCount = Math.round((TERRAIN.MARSH.share / (1 - mountainShare - lodeShare)) * restCount);
  const forestCount = Math.round(
    (TERRAIN.FOREST.share / (1 - mountainShare - lodeShare)) * restCount,
  );
  const wasteCount = Math.round(
    (TERRAIN.WASTE.share / (1 - mountainShare - lodeShare)) * restCount,
  );

  const wetness = rest.map((i) => moisture[i]! - elevation[i]! * 0.5);
  const byWetnessDesc = rest
    .map((i, k) => [wetness[k]!, i] as const)
    .sort((a, b) => b[0] - a[0]);

  for (let k = 0; k < marshCount; k++) cells[byWetnessDesc[k]![1]] = TERRAIN_CODE.MARSH;
  for (let k = marshCount; k < marshCount + forestCount; k++) {
    cells[byWetnessDesc[k]![1]] = TERRAIN_CODE.FOREST;
  }
  for (let k = byWetnessDesc.length - wasteCount; k < byWetnessDesc.length; k++) {
    cells[byWetnessDesc[k]![1]] = TERRAIN_CODE.WASTE;
  }

  // ── 廢墟：以古城遺址為中心散佈 ───────────────────────────
  scatterRubble(cells, seed);

  const map: TerrainMap = { width, height, cells };

  // ── 山脈整理與連通性 ─────────────────────────────────────
  const prunedBlobs = pruneSmallMountainBlobs(map);
  const carvedForConnectivity = ensurePassableConnectivity(map);

  return { map, stats: measure(map, prunedBlobs, carvedForConnectivity) };
}

/**
 * 廢墟散佈。
 *
 * 用「中心點的衰減場」而不是直接畫圓：先算出每格的廢墟傾向，
 * 再取前 18% —— 這樣既保留了「一片一片的古城」的視覺，
 * 佔比又不會隨中心點的隨機半徑漂移。
 */
function scatterRubble(cells: Uint8Array, seed: number) {
  const { width, height } = MAP;
  const rng = mulberry32(deriveSeed(seed, "rubble"));
  const centres = randInt(rng, RUBBLE_CENTRES[0], RUBBLE_CENTRES[1]);

  const field = new Float32Array(width * height);
  const jitter = fbm2D(deriveSeed(seed, "rubble-jitter"), { octaves: 3, frequency: 1 / 25 });

  for (let c = 0; c < centres; c++) {
    const cx = randInt(rng, 0, width - 1);
    const cy = randInt(rng, 0, height - 1);
    const radius = randRange(rng, RUBBLE_RADIUS[0], RUBBLE_RADIUS[1]);
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(width - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(height - 1, Math.ceil(cy + radius));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius) continue;
        // 線性衰減 + 雜訊擾動，讓邊緣破碎而不是完美的圓
        const strength = (1 - d / radius) ** 1.5;
        const i = idx(x, y, width);
        field[i] = Math.max(field[i]!, strength);
      }
    }
  }

  // 只有原本是 PLAIN 的格子會變廢墟 —— 森林與礦脈不該被古城覆蓋。
  //
  // 場外的 PLAIN 也算候選，但分數以 jitter 為主 ——
  // 這樣萬一遺址圈覆蓋不足（邊界裁切、圈與圈重疊），
  // 佔比仍然命中 18%，補上的格子也還是成片而不是雜訊般散落。
  const candidates: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === TERRAIN_CODE.PLAIN) candidates.push(i);
  }

  const want = Math.round(TERRAIN.RUBBLE.share * width * height);
  const scored = candidates
    .map((i) => {
      const x = i % width;
      const y = (i / width) | 0;
      return [field[i]! * 2 + jitter(x, y) * 0.5, i] as const;
    })
    .sort((a, b) => b[0] - a[0]);

  for (let k = 0; k < Math.min(want, scored.length); k++) {
    cells[scored[k]![1]] = TERRAIN_CODE.RUBBLE;
  }
}

/** 抹掉面積小於 `MIN_MOUNTAIN_BLOB` 的山塊，回傳抹掉的塊數 */
function pruneSmallMountainBlobs(map: TerrainMap): number {
  const { width, height, cells } = map;
  const seen = new Uint8Array(width * height);
  let pruned = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = idx(x, y, width);
      if (seen[start] || cells[start] !== TERRAIN_CODE.MOUNTAIN) continue;

      const blob: number[] = [];
      const stack = [start];
      seen[start] = 1;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        blob.push(cur);
        const cx = cur % width;
        const cy = (cur / width) | 0;
        for (const [dx, dy] of N8) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny, width);
          if (seen[ni] || cells[ni] !== TERRAIN_CODE.MOUNTAIN) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }

      if (blob.length < MIN_MOUNTAIN_BLOB) {
        for (const i of blob) cells[i] = TERRAIN_CODE.PLAIN;
        pruned++;
      }
    }
  }
  return pruned;
}

/** 找出所有可通行連通區（4 連通 —— 行軍不能斜穿兩座山之間的縫） */
function passableComponents(map: TerrainMap): { label: Int32Array; sizes: number[] } {
  const { width, height, cells } = map;
  const label = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = idx(x, y, width);
      if (label[start] !== -1 || cells[start] === TERRAIN_CODE.MOUNTAIN) continue;
      const id = sizes.length;
      let size = 0;
      const stack = [start];
      label[start] = id;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        size++;
        const cx = cur % width;
        const cy = (cur / width) | 0;
        for (const [dx, dy] of N4) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny, width);
          if (label[ni] !== -1 || cells[ni] === TERRAIN_CODE.MOUNTAIN) continue;
          label[ni] = id;
          stack.push(ni);
        }
      }
      sizes.push(size);
    }
  }
  return { label, sizes };
}

/**
 * 確保任意兩個可通行格皆連通。
 *
 * `docs/01` §3.1 說「否則重新生成」，但重生成很浪費 ——
 * 被圍死的通常只是幾塊小口袋，把封住它的那一圈山抹平就好，
 * 而且這樣產生的「隘口」正是聯盟劃分勢力範圍需要的地形。
 */
function ensurePassableConnectivity(map: TerrainMap): number {
  const { width, height, cells } = map;
  let carved = 0;

  for (let pass = 0; pass < 12; pass++) {
    const { label, sizes } = passableComponents(map);
    if (sizes.length <= 1) break;

    let largest = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i]! > sizes[largest]!) largest = i;

    // 把每個非最大連通區的邊界山脈鑿開一層
    const toCarve = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, width);
        if (label[i] === -1 || label[i] === largest) continue;
        for (const [dx, dy] of N4) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = idx(nx, ny, width);
          if (cells[ni] === TERRAIN_CODE.MOUNTAIN) toCarve.add(ni);
        }
      }
    }
    if (toCarve.size === 0) break;
    for (const i of toCarve) cells[i] = TERRAIN_CODE.PLAIN;
    carved += toCarve.size;
  }
  return carved;
}

function measure(map: TerrainMap, prunedBlobs: number, carved: number): TerrainStats {
  const counts = new Map<Terrain, number>();
  for (const t of TERRAINS) counts.set(t, 0);
  for (const c of map.cells) {
    const t = CODE_TERRAIN[c]!;
    counts.set(t, counts.get(t)! + 1);
  }
  const total = map.cells.length;
  const share = Object.fromEntries(
    TERRAINS.map((t) => [t, counts.get(t)! / total]),
  ) as Record<Terrain, number>;

  const { sizes } = passableComponents(map);
  const passable = sizes.reduce((s, v) => s + v, 0);
  const largest = sizes.length > 0 ? Math.max(...sizes) : 0;

  return {
    share,
    prunedBlobs,
    carvedForConnectivity: carved,
    largestPassableShare: passable > 0 ? largest / passable : 0,
  };
}
