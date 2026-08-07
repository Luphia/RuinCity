/**
 * 領土佔領與連通性。純函式，無 I/O。
 * 對應 docs/02-base-territory.md §2。
 *
 * ## ★ 連通性是這一節唯一的難點
 *
 * 領土必須跟核心據點**連在一起**。被切斷的格子進入 `ISOLATED` 狀態：
 * 產出減半、時限內沒接回來就自動放棄。
 *
 * 這讓「切細頸」成為真正的戰術 —— 打掉對方領土鏈上的一格，
 * 後面一整串全部失效，而不需要一格一格拔。
 */

import { CLAIM, MAP, TERRAIN, type Terrain } from "./balance";
import { TIME_SCALE } from "./balance";

export interface OwnedTile {
  readonly x: number;
  readonly y: number;
  readonly state: "NORMAL" | "ISOLATED" | "CONTESTED";
}

export interface ClaimContext {
  /** 核心據點左上角（2×2） */
  readonly baseX: number;
  readonly baseY: number;
  readonly owned: readonly OwnedTile[];
  readonly territoryCapacity: number;
  readonly terrainAt: (x: number, y: number) => Terrain;
  readonly isBlocked: (x: number, y: number) => boolean;
}

export type ClaimRejection =
  | "OUT_OF_BOUNDS"
  | "IMPASSABLE"
  | "BLOCKED"
  | "ALREADY_OWNED"
  | "NOT_ADJACENT"
  | "AT_CAPACITY";

export interface ClaimPlan {
  readonly x: number;
  readonly y: number;
  readonly cost: { readonly grain: number; readonly timber: number };
  /** 拓荒隊要帶的民兵（人口）*/
  readonly militia: number;
  readonly seconds: number;
}

/** 核心據點佔的 2×2 格 */
export function coreTiles(baseX: number, baseY: number): { x: number; y: number }[] {
  return [
    { x: baseX, y: baseY },
    { x: baseX + 1, y: baseY },
    { x: baseX, y: baseY + 1 },
    { x: baseX + 1, y: baseY + 1 },
  ];
}

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function key(x: number, y: number) {
  return `${x},${y}`;
}

/**
 * 拓荒成本**三重遞增**（`docs/02` §2.2）：資源、民兵、時間都隨已有領土上升。
 *
 * 三條一起漲，所以「無限擴張」在任何一個維度上都走不通 ——
 * 不是資源不夠，就是人口不夠，再不然就是慢到來不及。
 */
export function claimCost(ownedCount: number) {
  const growth = 1 + ownedCount / CLAIM.costGrowthDivisor;
  return {
    grain: Math.round(CLAIM.cost.grain * growth),
    timber: Math.round(CLAIM.cost.timber * growth),
  };
}

export function claimMilitia(ownedCount: number): number {
  return 5 + Math.floor(ownedCount / 10);
}

export function claimSeconds(ownedCount: number, terrain: Terrain): number {
  const terrainFactor = TERRAIN[terrain].marchFactor ?? 1;
  return (
    (CLAIM.baseSeconds * terrainFactor * (1 + ownedCount / CLAIM.timeGrowthDivisor)) / TIME_SCALE
  );
}

/** 這一格是否與已擁有的領土（或核心據點）相鄰 */
export function isAdjacentToOwned(ctx: ClaimContext, x: number, y: number): boolean {
  const set = new Set<string>();
  for (const t of coreTiles(ctx.baseX, ctx.baseY)) set.add(key(t.x, t.y));
  // ISOLATED 的格子不能當作擴張的跳板 —— 否則切細頸就沒有意義
  for (const t of ctx.owned) if (t.state !== "ISOLATED") set.add(key(t.x, t.y));

  for (const [dx, dy] of N4) if (set.has(key(x + dx, y + dy))) return true;
  return false;
}

export function planClaim(
  ctx: ClaimContext,
  x: number,
  y: number,
): ClaimPlan | { readonly reason: ClaimRejection } {
  if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return { reason: "OUT_OF_BOUNDS" };

  const terrain = ctx.terrainAt(x, y);
  if (TERRAIN[terrain].marchFactor === null) return { reason: "IMPASSABLE" };
  if (ctx.isBlocked(x, y)) return { reason: "BLOCKED" };

  if (ctx.owned.some((t) => t.x === x && t.y === y)) return { reason: "ALREADY_OWNED" };
  if (coreTiles(ctx.baseX, ctx.baseY).some((t) => t.x === x && t.y === y)) {
    return { reason: "ALREADY_OWNED" };
  }

  if (ctx.owned.length >= ctx.territoryCapacity) return { reason: "AT_CAPACITY" };
  if (!isAdjacentToOwned(ctx, x, y)) return { reason: "NOT_ADJACENT" };

  const n = ctx.owned.length;
  return {
    x,
    y,
    cost: claimCost(n),
    militia: claimMilitia(n),
    seconds: claimSeconds(n, terrain),
  };
}

/**
 * 從核心據點做 BFS，找出哪些格子還連得上。
 *
 * 回傳「被切斷」的格子 —— 它們要進入 `ISOLATED`。
 * 已經是 ISOLATED 的格子不參與連通（見 `isAdjacentToOwned` 的理由）。
 */
export function findDisconnected(
  baseX: number,
  baseY: number,
  owned: readonly OwnedTile[],
): OwnedTile[] {
  const alive = new Map<string, OwnedTile>();
  for (const t of owned) alive.set(key(t.x, t.y), t);

  const reached = new Set<string>();
  const stack: { x: number; y: number }[] = [];
  for (const t of coreTiles(baseX, baseY)) {
    reached.add(key(t.x, t.y));
    stack.push(t);
  }

  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const [dx, dy] of N4) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      const k = key(nx, ny);
      if (reached.has(k)) continue;
      const tile = alive.get(k);
      if (!tile) continue;
      reached.add(k);
      stack.push({ x: nx, y: ny });
    }
  }

  return owned.filter((t) => !reached.has(key(t.x, t.y)));
}

/**
 * 重新計算領土狀態。
 *
 * 接回來的格子從 ISOLATED 回到 NORMAL，被切斷的反過來。
 * `expireAt` 是這一批新孤立的格子的自動放棄時間。
 */
export interface IsolationUpdate {
  readonly tiles: readonly OwnedTile[];
  readonly newlyIsolated: readonly OwnedTile[];
  readonly reconnected: readonly OwnedTile[];
  readonly expireAt: number;
}

/** 孤立多久後自動放棄（`docs/02` §2.4，已套用 TIME_SCALE） */
export const ISOLATION_GRACE_MS = (12 * 60 * 60 * 1000) / TIME_SCALE;

export function recomputeIsolation(
  baseX: number,
  baseY: number,
  owned: readonly OwnedTile[],
  now: number,
): IsolationUpdate {
  const cut = new Set(findDisconnected(baseX, baseY, owned).map((t) => key(t.x, t.y)));

  const tiles: OwnedTile[] = [];
  const newlyIsolated: OwnedTile[] = [];
  const reconnected: OwnedTile[] = [];

  for (const t of owned) {
    const isCut = cut.has(key(t.x, t.y));
    if (isCut && t.state !== "ISOLATED") {
      const next = { ...t, state: "ISOLATED" as const };
      tiles.push(next);
      newlyIsolated.push(next);
    } else if (!isCut && t.state === "ISOLATED") {
      const next = { ...t, state: "NORMAL" as const };
      tiles.push(next);
      reconnected.push(next);
    } else {
      tiles.push(t);
    }
  }

  return { tiles, newlyIsolated, reconnected, expireAt: now + ISOLATION_GRACE_MS };
}

/** 孤立領土的產出減半（`docs/02` §2.4） */
export const ISOLATED_YIELD_MULTIPLIER = 0.5;

export function yieldMultiplierFor(state: OwnedTile["state"]): number {
  return state === "ISOLATED" ? ISOLATED_YIELD_MULTIPLIER : 1;
}
