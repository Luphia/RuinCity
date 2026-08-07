/**
 * 由世界推導出每位玩家的**空間事實**。純函式，無 I/O。
 *
 * 賽季模擬在 M1 之前是非空間的：它假設每個人的地形都是平原、
 * 領土要多少有多少、沒有鄰居、也沒有行軍距離。
 * 這個模組把那些假設換成地圖上真正的數字。
 */

import {
  MAP,
  ROSTER,
  SPAWN_BAND,
  TERRAIN,
  TERRAIN_YIELD,
  type SpawnBand,
  type Terrain,
} from "../balance";
import { marchTime, sampleTerrainFactor, type Point } from "../march";
import { CODE_TERRAIN, TERRAIN_CODE, idx, terrainAt, type TerrainMap } from "./terrain";
import { inNoBuildZone, type RuinSite } from "./ruins";
import { regionOf, type FactionId } from "./regions";
import type { World } from "./world";

/** 玩家會在自己周圍多遠的範圍內拓荒 —— 主堡 Lv30 也只有 90 塊領土 */
export const EXPANSION_RADIUS = 14;

/** 掠奪的搜尋半徑（格）。超過這個距離的鄰居在 12 天內基本上互不相干 */
export const RAID_RADIUS = 55;

export type ProdFacility = "FARM" | "SAWMILL" | "QUARRY" | "MINE";
export const PROD_FACILITIES: readonly ProdFacility[] = ["FARM", "SAWMILL", "QUARRY", "MINE"];

export interface Neighbour {
  /** 對方在 `profiles` 中的索引 */
  readonly index: number;
  readonly distance: number;
  /** 以劍士速度計的行軍秒數（真實秒） */
  readonly marchSeconds: number;
  readonly sameFaction: boolean;
  readonly sameAlliance: boolean;
}

export interface PlayerProfile {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly faction: FactionId;
  /** 0–4，陣營內的聯盟編號 */
  readonly alliance: number;
  readonly band: SpawnBand;
  readonly region: number;
  readonly squad: number | null;
  /** 主堡所在格的地形 —— 守方的地形防禦加成看這個 */
  readonly homeTerrain: Terrain;

  /** 周圍實際可用（可建設、且與鄰居分攤過）的格數 —— 領土的真正天花板 */
  readonly availableTiles: number;

  /**
   * 每種產出設施的「前 n 塊最適地形」的平均產出倍率。
   * `terrainMultiplier(f, n)` 用它插值。
   */
  readonly terrainPrefix: Record<ProdFacility, Float32Array>;

  readonly neighbours: readonly Neighbour[];
  /** 到自家遺跡的直線距離與行軍秒數 */
  readonly ruinDistance: number;
  readonly ruinMarchSeconds: number;
  /** 帶攻城單位能否在 8 小時上限內直達自家遺跡 */
  readonly ruinReachableWithSiege: boolean;
}

export interface SpatialProfiles {
  readonly players: readonly PlayerProfile[];
  /** 每個陣營的遺跡座標 */
  readonly ruins: Record<FactionId, RuinSite>;
}

/**
 * 設施在某地形上的產出倍率。`TERRAIN_YIELD` 沒列到的組合為 1.0。
 */
function yieldMultiplier(facility: ProdFacility, terrain: Terrain): number {
  return TERRAIN_YIELD[facility]?.[terrain] ?? 1;
}

/**
 * 拿前 n 塊地時的平均地形倍率。
 *
 * 真實玩家會**挑地形**：伐木場蓋森林（×1.25）、礦坑蓋礦脈（×1.4）。
 * 但好地是有限的，蓋到第 30 座伐木場時就只剩平原甚至荒地了。
 * 所以這裡回傳的是「前 n 塊最適地」的平均，而不是最好的那一塊。
 */
export function terrainMultiplier(
  profile: PlayerProfile,
  facility: ProdFacility,
  count: number,
): number {
  const prefix = profile.terrainPrefix[facility];
  if (count <= 0 || prefix.length <= 1) return 1;
  const n = Math.min(prefix.length - 1, Math.max(1, Math.round(count)));
  return prefix[n]! / n;
}

/**
 * 把一個陣營的 200 人切成 5 個各 40 人的聯盟。
 *
 * 以遺跡為心的**扇形**切分，而不是隨機分組 ——
 * 聯盟必須在地理上連續，否則 `docs/16` 的「區域軍隊容量」
 * （聯盟在某區域的基礎建設決定它能在那裡投入多少兵）完全失去意義。
 */
function assignAlliances(
  points: readonly { x: number; y: number; faction: FactionId }[],
  ruins: Record<FactionId, RuinSite>,
): number[] {
  const alliance = new Array<number>(points.length).fill(0);

  for (const f of [1, 2, 3] as const) {
    const home = ruins[f];
    const members = points
      .map((p, i) => ({ i, p }))
      .filter(({ p }) => p.faction === f)
      .map(({ i, p }) => ({
        i,
        angle: Math.atan2(p.y - home.y, p.x - home.x),
      }))
      .sort((a, b) => a.angle - b.angle);

    const per = Math.ceil(members.length / ROSTER.alliancesPerFaction);
    members.forEach((m, k) => {
      alliance[m.i] = Math.min(ROSTER.alliancesPerFaction - 1, Math.floor(k / per));
    });
  }
  return alliance;
}

/** 半徑內、扣掉山脈與禁建圈之後的格索引 */
function discTiles(
  map: TerrainMap,
  sites: readonly RuinSite[],
  cx: number,
  cy: number,
  radius: number,
): number[] {
  const out: number[] = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= MAP.height) continue;
    const span = Math.floor(Math.sqrt(r2 - dy * dy));
    for (let dx = -span; dx <= span; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= MAP.width) continue;
      const i = idx(x, y, MAP.width);
      if (map.cells[i] === TERRAIN_CODE.MOUNTAIN) continue;
      if (inNoBuildZone(sites, x, y)) continue;
      out.push(i);
    }
  }
  return out;
}

export function buildProfiles(world: World): SpatialProfiles {
  const { map, ruins: sites, spawns } = world;
  const points = spawns.points;

  const ruins = {} as Record<FactionId, RuinSite>;
  for (const s of sites) ruins[s.id as FactionId] = s;

  const alliance = assignAlliances(points, ruins);

  // ── 每人的可拓荒範圍，以及被幾個人同時盯上 ──────────────
  const discs = points.map((p) => discTiles(map, sites, p.x, p.y, EXPANSION_RADIUS));
  const claimants = new Int32Array(MAP.width * MAP.height);
  for (const disc of discs) for (const i of disc) claimants[i]!++;

  const players: PlayerProfile[] = points.map((p, index) => {
    const disc = discs[index]!;

    // 與鄰居分攤重疊的格 —— 兩個人搶同一塊地，各得一半
    let availableTiles = 0;
    for (const i of disc) availableTiles += 1 / claimants[i]!;

    // 每種設施：把範圍內的地依「該設施的產出倍率」由高到低排序，
    // 再做前綴和，之後查「前 n 塊的平均倍率」就是 O(1)
    const terrainPrefix = {} as Record<ProdFacility, Float32Array>;
    for (const f of PROD_FACILITIES) {
      const mults = disc
        .map((i) => yieldMultiplier(f, CODE_TERRAIN[map.cells[i]!]!))
        .sort((a, b) => b - a);
      const prefix = new Float32Array(mults.length + 1);
      for (let k = 0; k < mults.length; k++) prefix[k + 1] = prefix[k]! + mults[k]!;
      terrainPrefix[f] = prefix;
    }

    const home = ruins[p.faction];
    const terrainFactor = sampleTerrainFactor({ x: p.x, y: p.y }, home, (x, y) =>
      terrainAt(map, x, y),
    );
    const toRuin = marchTime({
      from: { x: p.x, y: p.y },
      to: home,
      army: { SWORDSMAN: 1 },
      terrainFactor,
    });
    const withSiege = marchTime({
      from: { x: p.x, y: p.y },
      to: home,
      army: { SWORDSMAN: 1, CATAPULT: 1 },
      terrainFactor,
    });

    return {
      index,
      x: p.x,
      y: p.y,
      faction: p.faction,
      alliance: alliance[index]!,
      band: p.band,
      region: regionOf(p.x, p.y),
      squad: p.squad,
      homeTerrain: terrainAt(map, p.x, p.y),
      availableTiles,
      terrainPrefix,
      neighbours: [],
      ruinDistance: p.ruinDistance,
      ruinMarchSeconds: toRuin.seconds,
      ruinReachableWithSiege: !withSiege.exceedsLimit,
    };
  });

  // ── 鄰居表 ───────────────────────────────────────────────
  // 600² = 360,000 對，直接算就好；行軍時間只對真的在射程內的算。
  const neighbours: Neighbour[][] = points.map(() => []);
  for (let a = 0; a < players.length; a++) {
    for (let b = a + 1; b < players.length; b++) {
      const pa = players[a]!;
      const pb = players[b]!;
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (d > RAID_RADIUS) continue;

      const tf = sampleTerrainFactor({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }, (x, y) =>
        terrainAt(map, x, y),
      );
      const seconds = marchTime({
        from: { x: pa.x, y: pa.y },
        to: { x: pb.x, y: pb.y },
        army: { SWORDSMAN: 1 },
        terrainFactor: tf,
      }).seconds;

      const sameFaction = pa.faction === pb.faction;
      const sameAlliance = sameFaction && pa.alliance === pb.alliance;
      neighbours[a]!.push({ index: b, distance: d, marchSeconds: seconds, sameFaction, sameAlliance });
      neighbours[b]!.push({ index: a, distance: d, marchSeconds: seconds, sameFaction, sameAlliance });
    }
  }

  const withNeighbours = players.map((p, i) => ({
    ...p,
    neighbours: neighbours[i]!.sort((x, y) => x.distance - y.distance),
  }));

  return { players: withNeighbours, ruins };
}

/** 出生帶給的起始加成（`docs/01` §5.4） */
export function bandBonus(band: SpawnBand) {
  const spec = SPAWN_BAND[band];
  return {
    resourceMultiplier: spec.startingResourceMultiplier,
    bonusTerritoryCapacity: spec.bonusTerritoryCapacity,
    campLevelBonus: spec.campLevelBonus,
  };
}

/** 供模擬計算行軍用：整張地圖的地形查詢 */
export function terrainLookup(map: TerrainMap) {
  return (x: number, y: number): Terrain => terrainAt(map, x, y);
}

export function marchFactorBetween(map: TerrainMap, a: Point, b: Point): number {
  return sampleTerrainFactor(a, b, (x, y) => terrainAt(map, x, y));
}

export const TERRAIN_LABELS = TERRAIN;
