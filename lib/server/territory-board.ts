import "server-only";

/**
 * 領土畫面要的資料：已有的地、以及**現在可以拓荒的候選格**。
 *
 * ★ 候選格在伺服器算。客戶端算的話，玩家就能自己編一組座標送上來 ——
 *   Server Action 當然會再驗一次（`planClaim`），但讓 UI 顯示
 *   一份跟驗證邏輯不同源的清單，遲早會出現「按了才說不行」。
 */

import { and, eq, gte, isNotNull, lte } from "drizzle-orm";

import { TERRAIN, type Terrain } from "@/lib/game/balance";
import { freeTerritoryQueue } from "@/lib/game/build";
import { territoryCapacity, territoryQueues } from "@/lib/game/formulas";
import { claimCost, claimMilitia, claimSeconds, coreTiles } from "@/lib/game/territory";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import type { settleWithin } from "@/lib/server/player-state";
import { loadRuins, loadTerrainAround, terrainDirFor } from "@/lib/server/terrain";

export interface OwnedTileView {
  readonly x: number;
  readonly y: number;
  readonly terrain: Terrain;
  readonly terrainLabel: string;
  readonly facility: string | null;
  readonly facilityLevel: number;
  readonly isolated: boolean;
}

export interface ClaimCandidate {
  readonly x: number;
  readonly y: number;
  readonly terrain: Terrain;
  readonly terrainLabel: string;
  readonly cost: { readonly grain: number; readonly timber: number };
  readonly militia: number;
  readonly seconds: number;
  /**
   * ★ 以下三項是給執政官用的地理事實。
   *   執政官與玩家看**同一份候選清單** —— 兩份清單遲早會有一份先過期，
   *   而「按了才說不行」是最糟的手感。
   */
  readonly distanceToBase: number;
  readonly distanceToRuin: number;
  readonly hostileNeighbours: number;
}

export interface TerritoryBoard {
  readonly owned: readonly OwnedTileView[];
  readonly candidates: readonly ClaimCandidate[];
  readonly capacity: number;
  readonly queuesFree: boolean;
  /** 閒置的領土佇列數。執政官用它決定這一輪能排幾件事 */
  readonly queuesFreeCount: number;
  readonly baseX: number;
  readonly baseY: number;
}

const N4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** 一次列出的候選格上限。地圖上相鄰的空地可能很多，UI 不需要全部 */
const MAX_CANDIDATES = 40;

/** 幾條領土佇列是閒著的 */
function countFreeQueues(
  state: Awaited<ReturnType<typeof settleWithin>>,
  now: number,
): number {
  const total = territoryQueues(state.build.citadel);
  let free = 0;
  for (let i = 0; i < total; i++) {
    const q = state.build.territoryQueue[i];
    if (!q || q.doneAt <= now) free++;
  }
  return free;
}

export async function buildTerritoryBoard(
  tx: TxDb,
  state: Awaited<ReturnType<typeof settleWithin>>,
  now: number,
): Promise<TerritoryBoard> {
  const key = (x: number, y: number) => `${x},${y}`;
  const ownedKeys = new Set(state.tiles.map((t) => key(t.x, t.y)));
  const core = coreTiles(state.baseX, state.baseY);
  for (const c of core) ownedKeys.add(key(c.x, c.y));

  // 跳板：核心 2×2 與**非孤立**的領土（`docs/02` §2.4 —— 切細頸才有意義）
  const springboards = [...core, ...state.tiles.filter((t) => t.state !== "ISOLATED")];

  const raw = new Map<string, { x: number; y: number }>();
  for (const s of springboards) {
    for (const [dx, dy] of N4) {
      const x = s.x + dx;
      const y = s.y + dy;
      if (x < 0 || y < 0) continue;
      if (ownedKeys.has(key(x, y))) continue;
      raw.set(key(x, y), { x, y });
    }
  }

  const points = [...raw.values()];
  const terrainMap = await loadTerrainAround(terrainDirFor(state.seasonId), [
    ...points,
    ...state.tiles,
  ]);

  /**
   * 別人已經佔走的格排掉。
   *
   * 候選格一定貼著自己的領土，所以它們全部落在一個很小的包圍盒裡 ——
   * 用範圍查詢一次撈完，比 40 條 `OR (x=? AND y=?)` 好讀也好走索引。
   */
  const takenKeys = new Set<string>();
  if (points.length > 0) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const rows = await tx
      .select({ x: schema.tiles.x, y: schema.tiles.y })
      .from(schema.tiles)
      .where(
        and(
          eq(schema.tiles.seasonId, state.seasonId),
          isNotNull(schema.tiles.playerId),
          gte(schema.tiles.x, Math.min(...xs)),
          lte(schema.tiles.x, Math.max(...xs)),
          gte(schema.tiles.y, Math.min(...ys)),
          lte(schema.tiles.y, Math.max(...ys)),
        ),
      );
    for (const r of rows) takenKeys.add(key(r.x, r.y));
  }

  const ruins = await loadRuins(terrainDirFor(state.seasonId));
  const distanceToRuin = (x: number, y: number) =>
    ruins.length === 0
      ? Infinity
      : Math.min(...ruins.map((r) => Math.abs(r.x - x) + Math.abs(r.y - y)));

  const ownedCount = state.tiles.length;
  const candidates: ClaimCandidate[] = [];
  for (const p of points) {
    if (takenKeys.has(key(p.x, p.y))) continue;
    const terrain = terrainMap.at(p.x, p.y);
    if (TERRAIN[terrain].marchFactor === null) continue;

    // 相鄰有幾格是**別人的**。takenKeys 已經排除了自己的地
    let hostile = 0;
    for (const [dx, dy] of N4) {
      if (takenKeys.has(key(p.x + dx, p.y + dy))) hostile++;
    }

    candidates.push({
      x: p.x,
      y: p.y,
      terrain,
      terrainLabel: TERRAIN[terrain].label,
      cost: claimCost(ownedCount),
      militia: claimMilitia(ownedCount),
      seconds: claimSeconds(ownedCount, terrain),
      distanceToBase: Math.abs(p.x - state.baseX) + Math.abs(p.y - state.baseY),
      distanceToRuin: distanceToRuin(p.x, p.y),
      hostileNeighbours: hostile,
    });
  }

  // 好地優先：拓荒成本一樣，差別只在地形，所以把快的排前面
  candidates.sort((a, b) => a.seconds - b.seconds || a.x - b.x || a.y - b.y);

  return {
    owned: state.tiles.map((t) => ({
      x: t.x,
      y: t.y,
      terrain: t.terrain,
      terrainLabel: TERRAIN[t.terrain].label,
      facility: t.facility,
      facilityLevel: t.facilityLevel,
      isolated: t.state === "ISOLATED",
    })),
    candidates: candidates.slice(0, MAX_CANDIDATES),
    capacity: territoryCapacity(state.build.citadel),
    queuesFree: freeTerritoryQueue(state.build, now) >= 0,
    queuesFreeCount: countFreeQueues(state, now),
    baseX: state.baseX,
    baseY: state.baseY,
  };
}
