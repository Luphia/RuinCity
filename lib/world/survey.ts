/**
 * 勘查：從 Street View 的探針結果選出**標記座標**。純函式，無 I/O。
 *
 * 探針是塊內 10×10 個點（`grid.surveyProbes`），每個點問一次 metadata，
 * 回來的是「離那個點最近的全景」—— 可能在塊外、可能好幾個點都指到同一個全景。
 *
 * 選法：
 *   1. 只留**在這一塊裡面**的全景（塊外的全景畫出來的是隔壁的景）
 *   2. 同一個全景只留一次
 *   3. 從最靠近中心的那個開始，每次挑**離已選者最遠**的（farthest-point）——
 *      標記散在塊內各處，而不是擠在同一個路口
 *   4. 鏡頭朝向塊的中心：從邊上往裡看，看到的是這一塊，不是隔壁
 *   5. 全景不到 100 個時，同一個全景**轉 90°、180°、270°** 再取一張，
 *      直到湊滿或四個方向都用完（一條死巷四面看出去本來就是四個不同的景）
 */

import {
  bearingDeg,
  blockCenter,
  blockOf,
  haversineM,
  sameBlock,
  type BlockId,
  type LatLng,
} from "./grid";
import { MAX_SCENES } from "./plan";
import type { Viewpoint } from "./prompts";

export interface PanoCandidate {
  readonly panoId: string;
  readonly location: LatLng;
  readonly date: string | null;
}

/** 離中心這麼近的全景，朝向中心沒有意義 —— 改朝北 */
const CENTER_RADIUS_M = 60;

export const DEFAULT_PITCH = 0;
export const DEFAULT_FOV = 90;
/** 同一個全景最多取幾個方向 */
export const HEADINGS_PER_PANO = 4;

export function chooseViewpoints(
  block: BlockId,
  candidates: readonly PanoCandidate[],
  max = MAX_SCENES,
): Viewpoint[] {
  const center = blockCenter(block);
  const unique = new Map<string, PanoCandidate>();
  for (const c of candidates) {
    if (!sameBlock(blockOf(c.location), block)) continue;
    if (!unique.has(c.panoId)) unique.set(c.panoId, c);
  }
  const pool = [...unique.values()].sort(
    (a, b) =>
      haversineM(a.location, center) - haversineM(b.location, center) ||
      a.panoId.localeCompare(b.panoId),
  );

  // farthest-point，維護每個候選到已選集合的最短距離（O(k·n)）
  const chosen: PanoCandidate[] = [];
  const minDist = pool.map(() => Infinity);
  const taken = pool.map(() => false);
  for (let step = 0; step < Math.min(max, pool.length); step++) {
    let pick = -1;
    if (step === 0) pick = 0;
    else {
      let best = -1;
      for (let i = 0; i < pool.length; i++) {
        if (!taken[i] && minDist[i]! > best) {
          best = minDist[i]!;
          pick = i;
        }
      }
    }
    taken[pick] = true;
    const p = pool[pick]!;
    chosen.push(p);
    for (let i = 0; i < pool.length; i++) {
      if (!taken[i]) minDist[i] = Math.min(minDist[i]!, haversineM(p.location, pool[i]!.location));
    }
  }

  const base = chosen.map((c) => ({
    pano: c,
    heading:
      haversineM(c.location, center) < CENTER_RADIUS_M ? 0 : Math.round(bearingDeg(c.location, center)),
  }));

  const out: Viewpoint[] = [];
  for (let turn = 0; turn < HEADINGS_PER_PANO && out.length < max; turn++) {
    for (const b of base) {
      if (out.length >= max) break;
      out.push({
        panoId: b.pano.panoId,
        location: b.pano.location,
        date: b.pano.date,
        heading: (b.heading + turn * 90) % 360,
        pitch: DEFAULT_PITCH,
        fov: DEFAULT_FOV,
      });
    }
  }
  return out;
}
