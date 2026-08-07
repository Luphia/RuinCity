/**
 * 三分天下：以**行軍成本距離**做 Voronoi 分割。純函式，無 I/O。
 * 對應 docs/01-world-map.md §5.2 與 docs/13 §3 步驟 2。
 *
 * ★ 用成本距離而非直線距離是刻意的：山脈不可通行，所以山脈自然成為
 *   陣營邊界，三塊版圖從一開始就不對稱。這是「地緣」的來源 ——
 *   直線 Voronoi 只會切出三塊無聊的扇形。
 */

import { MAP, TERRAIN } from "../balance";
import { CODE_TERRAIN, TERRAIN_CODE, idx, type TerrainMap } from "./terrain";
import type { RuinSite } from "./ruins";

/** 每格所屬陣營（1/2/3），−1 = 不可通行或無法抵達 */
export type FactionId = 1 | 2 | 3;

export interface RegionSplit {
  /** `width × height`，值為 FactionId 或 −1 */
  readonly owner: Int8Array;
  /** 每格到「自己陣營遺跡」的行軍成本距離；Infinity = 無法抵達 */
  readonly costDistance: Float64Array;
  /** 每格到最近遺跡的直線距離（出生環帶用） */
  readonly ruinDistance: Float32Array;
  /** 三個陣營的可用（可通行）格數 */
  readonly areas: Record<FactionId, number>;
  /** 最大與最小陣營面積的相對差 */
  readonly areaDiff: number;
}

const N8: readonly (readonly [number, number, number])[] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

/** 每種地形碼的行軍係數，山脈為 Infinity */
function marchCostTable(): Float64Array {
  const t = new Float64Array(CODE_TERRAIN.length);
  for (let c = 0; c < CODE_TERRAIN.length; c++) {
    const f = TERRAIN[CODE_TERRAIN[c]!].marchFactor;
    t[c] = f ?? Infinity;
  }
  return t;
}

/**
 * 多源 Dijkstra。
 *
 * 250,000 格 × 8 鄰居用二元堆積約 30–60 ms，不需要更複雜的結構。
 * 堆積用兩個平行的 typed array 手寫，避免每個節點都配置一個物件。
 */
export function splitRegions(map: TerrainMap, sites: readonly RuinSite[]): RegionSplit {
  const { width, height, cells } = map;
  const n = width * height;
  const cost = marchCostTable();

  const owner = new Int8Array(n).fill(-1);
  // ★ 必須是 Float64。用 Float32 存的話，`dist[ni] = nd` 會捨入到最接近的
  //   float32，而捨入後的值可能**大於** nd —— 於是同一條邊下次比較
  //   `nd < dist[ni]` 又成立，無限重複鬆弛，整個 Dijkstra 不會結束。
  const dist = new Float64Array(n).fill(Infinity);

  // ── 手寫二元最小堆 ────────────────────────────────────────
  let heapKey = new Float64Array(1024);
  let heapVal = new Int32Array(1024);
  let heapSize = 0;

  const grow = () => {
    if (heapSize < heapKey.length) return;
    const k = new Float64Array(heapKey.length * 2);
    const v = new Int32Array(heapVal.length * 2);
    k.set(heapKey);
    v.set(heapVal);
    heapKey = k;
    heapVal = v;
  };

  const push = (key: number, val: number) => {
    grow();
    let i = heapSize++;
    heapKey[i] = key;
    heapVal[i] = val;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapKey[p]! <= heapKey[i]!) break;
      const tk = heapKey[p]!;
      const tv = heapVal[p]!;
      heapKey[p] = heapKey[i]!;
      heapVal[p] = heapVal[i]!;
      heapKey[i] = tk;
      heapVal[i] = tv;
      i = p;
    }
  };

  let poppedKey = 0;
  const pop = (): number => {
    const top = heapVal[0]!;
    poppedKey = heapKey[0]!;
    heapSize--;
    if (heapSize > 0) {
      heapKey[0] = heapKey[heapSize]!;
      heapVal[0] = heapVal[heapSize]!;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapSize && heapKey[l]! < heapKey[m]!) m = l;
        if (r < heapSize && heapKey[r]! < heapKey[m]!) m = r;
        if (m === i) break;
        const tk = heapKey[m]!;
        const tv = heapVal[m]!;
        heapKey[m] = heapKey[i]!;
        heapVal[m] = heapVal[i]!;
        heapKey[i] = tk;
        heapVal[i] = tv;
        i = m;
      }
    }
    return top;
  };

  for (const site of sites) {
    const i = idx(site.x, site.y, width);
    dist[i] = 0;
    owner[i] = site.id;
    push(0, i);
  }

  while (heapSize > 0) {
    const cur = pop();
    // 惰性刪除：同一個節點可能被推入多次，只處理最新的那一筆
    if (poppedKey > dist[cur]!) continue;
    const d = dist[cur]!;
    const cx = cur % width;
    const cy = (cur / width) | 0;

    for (const [dx, dy, diag] of N8) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = idx(nx, ny, width);
      if (cells[ni] === TERRAIN_CODE.MOUNTAIN) continue;
      const step = cost[cells[ni]!]! * diag;
      const nd = d + step;
      if (nd < dist[ni]!) {
        dist[ni] = nd;
        owner[ni] = owner[cur]!;
        push(nd, ni);
      }
    }
  }

  // ── 到最近遺跡的直線距離（出生環帶依此劃分）────────────────
  const ruinDistance = new Float32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let best = Infinity;
      for (const s of sites) best = Math.min(best, Math.hypot(x - s.x, y - s.y));
      ruinDistance[idx(x, y, width)] = best;
    }
  }

  const areas: Record<FactionId, number> = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < n; i++) {
    const o = owner[i]!;
    if (o >= 1 && o <= 3) areas[o as FactionId]++;
  }
  const values = [areas[1], areas[2], areas[3]];
  const areaDiff = (Math.max(...values) - Math.min(...values)) / Math.max(...values);

  return { owner, costDistance: dist, ruinDistance, areas, areaDiff };
}

/** 該格屬於哪個 50×50 區域（`R{列}{行}`） */
export function regionOf(x: number, y: number): number {
  const col = Math.min(9, Math.floor(x / 50));
  const row = Math.min(9, Math.floor(y / 50));
  return row * 10 + col;
}

export function regionLabel(regionIndex: number): string {
  return `R${Math.floor(regionIndex / 10)}${regionIndex % 10}`;
}

export const MAP_CELLS = MAP.width * MAP.height;
