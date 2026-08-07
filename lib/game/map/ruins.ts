/**
 * 三座遺跡的放置與約束驗證。純函式，無 I/O。
 * 對應 docs/01-world-map.md §4。
 */

import { MAP, RUIN, RUIN_PLACEMENT, type RuinId } from "../balance";
import { deriveSeed, mulberry32, randInt } from "../rng";
import { TERRAIN_CODE, idx, type TerrainMap } from "./terrain";

export interface RuinSite {
  readonly id: RuinId;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface RuinCandidate {
  readonly sites: readonly RuinSite[];
  readonly pairDistances: readonly number[];
  readonly triangleAnglesDeg: readonly number[];
  /** 三角形重心離地圖中心的距離 */
  readonly centroidOffset: number;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/** 三角形三個內角（度） */
export function triangleAngles(p: readonly { x: number; y: number }[]): number[] {
  const [a, b, c] = [p[0]!, p[1]!, p[2]!];
  const ab = dist(a, b);
  const bc = dist(b, c);
  const ca = dist(c, a);
  const angle = (opposite: number, s1: number, s2: number) =>
    (Math.acos(
      Math.min(1, Math.max(-1, (s1 * s1 + s2 * s2 - opposite * opposite) / (2 * s1 * s2))),
    ) *
      180) /
    Math.PI;
  return [angle(bc, ab, ca), angle(ca, ab, bc), angle(ab, bc, ca)];
}

/**
 * ★ `docs/01` §4 沒有的第四條約束：三角形重心必須靠近地圖中心。
 *
 * 只用文件上的三條約束（離邊界 ≥90、兩兩 170–240、最小內角 ≥35°）做拒絕採樣，
 * 40 次擺放的陣營面積差異中位數是 **48.7%**，最好的一次也有 12.6% ——
 * 沒有任何一次通過公平性檢查 (e) 的 5%。原因是隨機三角形通常偏心，
 * 於是某個陣營獨得地圖的一整個遠側。
 *
 * 加上重心約束後中位數降到 8% 上下；再由 `generateWorld` 在候選中
 * 直接挑面積最平衡的那一組，才穩定進得了 5%。
 */
const MAX_CENTROID_OFFSET = 30;

/**
 * 產生**滿足所有約束**的候選擺放。
 *
 * 這裡刻意不碰地圖也不評估面積 —— 面積平衡要跑 Voronoi，
 * 由 `generateWorld` 統一決定，才不會讓這一層依賴 `regions.ts`。
 */
export function ruinCandidates(seed: number, count: number): RuinCandidate[] {
  const rng = mulberry32(deriveSeed(seed, "ruins"));
  const lo = RUIN_PLACEMENT.minDistanceToEdge;
  const hiX = MAP.width - 1 - RUIN_PLACEMENT.minDistanceToEdge;
  const hiY = MAP.height - 1 - RUIN_PLACEMENT.minDistanceToEdge;
  const cx = (MAP.width - 1) / 2;
  const cy = (MAP.height - 1) / 2;

  const out: RuinCandidate[] = [];
  for (let attempt = 0; attempt < 2_000_000 && out.length < count; attempt++) {
    const pts = [0, 1, 2].map(() => ({
      x: randInt(rng, lo, hiX),
      y: randInt(rng, lo, hiY),
    }));

    const pairs = [dist(pts[0]!, pts[1]!), dist(pts[1]!, pts[2]!), dist(pts[2]!, pts[0]!)];
    if (
      pairs.some((d) => d < RUIN_PLACEMENT.minPairDistance || d > RUIN_PLACEMENT.maxPairDistance)
    ) {
      continue;
    }

    const angles = triangleAngles(pts);
    if (angles.some((a) => a < RUIN_PLACEMENT.minTriangleAngleDeg)) continue;

    const gx = (pts[0]!.x + pts[1]!.x + pts[2]!.x) / 3;
    const gy = (pts[0]!.y + pts[1]!.y + pts[2]!.y) / 3;
    const centroidOffset = Math.hypot(gx - cx, gy - cy);
    if (centroidOffset > MAX_CENTROID_OFFSET) continue;

    // 依 x 排序，讓同一個 seed 的 ruinId 對應也固定
    const ordered = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const sites: RuinSite[] = ([1, 2, 3] as const).map((id, i) => ({
      id,
      name: RUIN[id].name,
      x: ordered[i]!.x,
      y: ordered[i]!.y,
    }));

    out.push({
      sites,
      pairDistances: [
        dist(sites[0]!, sites[1]!),
        dist(sites[1]!, sites[2]!),
        dist(sites[2]!, sites[0]!),
      ],
      triangleAnglesDeg: triangleAngles(sites),
      centroidOffset,
    });
  }

  if (out.length === 0) {
    throw new Error(`找不到滿足遺跡約束的擺放（seed ${seed}）`);
  }
  return out;
}

/** 遺跡本體 3×3 強制改為 PLAIN，周圍 2 格清除 MOUNTAIN */
export function stampRuins(map: TerrainMap, sites: readonly RuinSite[]) {
  const half = (RUIN_PLACEMENT.footprint - 1) / 2;
  const clear = half + 2;
  for (const site of sites) {
    for (let dy = -clear; dy <= clear; dy++) {
      for (let dx = -clear; dx <= clear; dx++) {
        const x = site.x + dx;
        const y = site.y + dy;
        if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
        const i = idx(x, y, map.width);
        const inFootprint = Math.abs(dx) <= half && Math.abs(dy) <= half;
        if (inFootprint || map.cells[i] === TERRAIN_CODE.MOUNTAIN) {
          map.cells[i] = TERRAIN_CODE.PLAIN;
        }
      }
    }
  }
}

/** 是否落在任一座遺跡的禁建圈（半徑 12）內 */
export function inNoBuildZone(sites: readonly RuinSite[], x: number, y: number): boolean {
  for (const s of sites) {
    if (Math.hypot(x - s.x, y - s.y) <= RUIN_PLACEMENT.noBuildRadius) return true;
  }
  return false;
}
