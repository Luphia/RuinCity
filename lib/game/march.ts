/**
 * 行軍時間與來襲預警。純函式，無 I/O。
 * 對應 docs/04-military-combat.md §2。
 */

import {
  MARCH,
  MOUNTAIN_PATH_PENALTY,
  TERRAIN,
  WARNING,
  type SeasonModifiers,
  type Terrain,
  type Unit,
} from "./balance";
import { armySpeed } from "./formulas";

export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * 沿起訖直線等距取樣，回傳平均行軍係數。
 *
 * 山脈以 ×2.5 計，抽象表示繞路 —— **v1 不做真實 A\* 尋路**。
 * 這是刻意的簡化：250,000 格的路徑計算太貴，而地形係數的平均值
 * 已經足以讓「穿越山區很慢」這件事在遊戲裡成立。
 */
export function sampleTerrainFactor(
  from: Point,
  to: Point,
  terrainAt: (x: number, y: number) => Terrain,
): number {
  const d = distance(from, to);
  const samples = Math.max(1, Math.min(MARCH.terrainSampleCap, Math.ceil(d)));

  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const t = (i + 0.5) / samples;
    const x = Math.round(from.x + (to.x - from.x) * t);
    const y = Math.round(from.y + (to.y - from.y) * t);
    const terrain = terrainAt(x, y);
    const factor = TERRAIN[terrain].marchFactor;
    sum += factor ?? MOUNTAIN_PATH_PENALTY;
  }
  return sum / samples;
}

export interface MarchTimeInput {
  from: Point;
  to: Point;
  army: Partial<Record<Unit, number>>;
  terrainFactor?: number;
  season?: SeasonModifiers;
  speedBonus?: { techBonus?: number; stableBonus?: number; ruinBonus?: number };
}

export interface MarchTime {
  seconds: number;
  distance: number;
  speed: number;
  terrainFactor: number;
  /** 超過 8 小時上限 → 不可派遣，UI 直接禁用 */
  exceedsLimit: boolean;
}

/**
 * 行軍時間（真實秒數）。
 *
 * 最大 8 小時的上限是刻意的地圖設計約束：**跨陣營的攻城遠征
 * 在物理上不可能直達**，主力必須先行軍至前哨營再重新出發。
 * 這讓「建立通往敵方遺跡的補給線」成為秋季大會戰前的核心任務。
 */
export function marchTime(input: MarchTimeInput): MarchTime {
  const d = distance(input.from, input.to);
  const speed = armySpeed(input.army, input.speedBonus ?? {});
  const terrainFactor = input.terrainFactor ?? 1;

  if (speed <= 0) {
    return { seconds: Infinity, distance: d, speed: 0, terrainFactor, exceedsLimit: true };
  }

  const raw =
    (3600 * d) / speed * terrainFactor * (input.season?.marchTime ?? 1);
  const seconds = Math.max(MARCH.minSeconds, raw);

  return {
    seconds,
    distance: d,
    speed,
    terrainFactor,
    exceedsLimit: seconds > MARCH.maxSeconds,
  };
}

/**
 * 來襲預警窗口（真實秒數）。
 *
 * 固定 30 分鐘在短程行軍下不可能成立（隔壁鄰居總行軍只有 15 分鐘），
 * 因此改為按比例計算。
 *
 * 副作用是強化了地理意義：遠方來的敵人你看得早，隔壁鄰居的突襲幾乎是瞬間的 ——
 * 這讓「跟鄰居維持關係」比「築牆」更重要，也讓哨塔在前線成為必需品。
 */
export function warningWindow(marchSeconds: number, hasWatchtower = false): number {
  const [ratio, min, max] = hasWatchtower
    ? [WARNING.watchtowerRatio, WARNING.watchtowerMinSeconds, WARNING.watchtowerMaxSeconds]
    : [WARNING.ratio, WARNING.minSeconds, WARNING.maxSeconds];

  const window = Math.min(max, Math.max(min, marchSeconds * ratio));

  // ★ 預警永遠不能長於行軍本身，否則會在敵人出發前就顯示。
  // 最短行軍是 180 秒，而哨塔的預警下限是 300 秒 —— 沒有這個 clamp
  // 就會出現「敵人還沒出發，你已經看到來襲警報」的荒謬狀況。
  return Math.min(window, marchSeconds);
}

/** 預警在抵達前多久出現（絕對時間戳） */
export function warningVisibleAt(
  departedAt: number,
  arrivesAt: number,
  hasWatchtower = false,
): number {
  const window = warningWindow((arrivesAt - departedAt) / 1000, hasWatchtower) * 1000;
  return Math.max(departedAt, arrivesAt - window);
}
