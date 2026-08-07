/**
 * 出生點批次分配。純函式，無 I/O。
 * 對應 docs/13-season-registration.md §3 步驟 3–5。
 *
 * 所有人同時進入，所以任何不公平都會在第一天被攤在論壇上比較 ——
 * 分配必須是可驗證公平的，不能靠隨機祈禱。
 */

import { MAP, SPAWN_BAND, SPAWN_BANDS, SQUAD, type SpawnBand } from "../balance";
import { deriveSeed, mulberry32, randRange, shuffle, type Rng } from "../rng";
import { TERRAIN_CODE, idx, type TerrainMap } from "./terrain";
import { inNoBuildZone, type RuinSite } from "./ruins";
import { discCountField, median } from "./field";
import type { FactionId, RegionSplit } from "./regions";
import { regionOf } from "./regions";

export interface SpawnPoint {
  readonly x: number;
  readonly y: number;
  readonly faction: FactionId;
  readonly band: SpawnBand;
  /** 到自家遺跡的直線距離 */
  readonly ruinDistance: number;
  readonly region: number;
  /** 同行小隊代碼；null = 散客 */
  readonly squad: number | null;
}

export interface SquadRequest {
  readonly faction: FactionId;
  readonly band: SpawnBand;
  readonly size: number;
}

export interface SpawnAllocation {
  readonly points: readonly SpawnPoint[];
  /** 每個 (陣營, 環帶) 實際配到的人數與名額 */
  readonly fill: { faction: FactionId; band: SpawnBand; placed: number; quota: number }[];
  /** 有多少小隊沒能整組放在一起 */
  readonly brokenSquads: number;
}

/**
 * 合法出生點（`docs/01` §5.1）：該格與其右下三格構成的 2×2 核心皆需
 * 非山脈、不在禁建圈內、離邊界 ≥ 10。
 */
export function isLegalSpawn(
  map: TerrainMap,
  sites: readonly RuinSite[],
  x: number,
  y: number,
): boolean {
  const m = MAP.edgeMargin;
  if (x < m || y < m || x + 1 >= MAP.width - m || y + 1 >= MAP.height - m) return false;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const cx = x + dx;
      const cy = y + dy;
      if (map.cells[idx(cx, cy, map.width)] === TERRAIN_CODE.MOUNTAIN) return false;
      if (inNoBuildZone(sites, cx, cy)) return false;
    }
  }
  return true;
}

interface BandCell {
  x: number;
  y: number;
  d: number;
  /** 15 格內的可建設格數（公平性檢查 a） */
  buildable: number;
  /** 20 格內的高價值地形格數（公平性檢查 d） */
  valuable: number;
}

/**
 * ★ 分配器必須看得見公平性檢查，否則 (a) 與 (d) 永遠過不了。
 *
 * 檢查 (d) 要求「每位玩家 20 格內的高價值地形格數，全服標準差 < 12%」。
 * 但 LODE 與 FOREST 是雜訊的高分位數，天生**成群出現** ——
 * 盲目取樣時，住在林區的人有 600 格、住在平原的人只有 20 格，
 * 實測標準差 87%。換再多 seed 也沒用，因為問題不在地形而在選點。
 *
 * 這兩項檢查管的本來就是**玩家被放在哪裡**，不是地形長什麼樣。
 * 所以分配器先把候選格篩到「鄰域統計接近全服中位數」的那一批，
 * 再做 Poisson-disk —— 地形依舊成群，但沒有人因為出生點而先贏一步。
 */
const NEIGHBOURHOOD_TOLERANCE = 0.1;

/**
 * Poisson-disk sampling（Bridson）在一組離散候選格上。
 *
 * 標準 Bridson 在連續空間取樣，但這裡的合法格是離散且形狀不規則的
 * （環帶被 Voronoi 邊界與山脈裁切），所以改成「洗牌後貪婪挑選 +
 * 空間雜湊做最小間距檢查」—— 結果同樣是藍雜訊分佈，而且不會卡在
 * 找不到候選點的無限重試裡。
 */
function poissonPick(
  rng: Rng,
  cells: BandCell[],
  count: number,
  minSpacing: number,
): BandCell[] {
  if (count <= 0) return [];
  const picked: BandCell[] = [];

  // 空間雜湊：格寬 = 最小間距，只需檢查 3×3 個桶
  const bucketSize = Math.max(1, minSpacing);
  const buckets = new Map<number, BandCell[]>();
  const key = (x: number, y: number) =>
    Math.floor(y / bucketSize) * 100000 + Math.floor(x / bucketSize);

  const farEnough = (c: BandCell, spacing: number) => {
    const bx = Math.floor(c.x / bucketSize);
    const by = Math.floor(c.y / bucketSize);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get((by + dy) * 100000 + (bx + dx));
        if (!list) continue;
        for (const p of list) {
          if (Math.hypot(p.x - c.x, p.y - c.y) < spacing) return false;
        }
      }
    }
    return true;
  };

  const add = (c: BandCell) => {
    picked.push(c);
    const k = key(c.x, c.y);
    const list = buckets.get(k);
    if (list) list.push(c);
    else buckets.set(k, [c]);
  };

  const pool = shuffle(rng, cells.slice());
  const used = new Set<number>();

  // 逐步放寬間距：先用理想間距鋪滿，不夠再降低要求。
  // 這比「取樣失敗就整個重來」穩定得多。
  for (let spacing = minSpacing; spacing >= 1 && picked.length < count; spacing *= 0.8) {
    for (const c of pool) {
      if (picked.length >= count) break;
      const k = c.y * 100000 + c.x;
      if (used.has(k)) continue;
      if (!farEnough(c, spacing)) continue;
      used.add(k);
      add(c);
    }
  }

  // 最後保底：只要還有沒用過的格子就填 —— 名額不能少人
  for (const c of pool) {
    if (picked.length >= count) break;
    const k = c.y * 100000 + c.x;
    if (used.has(k)) continue;
    used.add(k);
    add(c);
  }
  return picked;
}

/**
 * ★ 依「離遺跡的距離」分層取樣。
 *
 * 公平性檢查 (b) 要求同一環帶在三個陣營的平均遺跡距離不能差太多。
 * 但環帶會被 Voronoi 邊界與山脈裁掉一部分，各陣營被裁掉的位置不同 ——
 * 盲目取樣時某個陣營的前線帶可能整片集中在內緣，平均距離差到 6.8 格。
 *
 * 把環帶切成等寬的數層、每層抽同樣多人，三個陣營的距離分佈就會一致，
 * 平均值自然收斂到環帶中點。
 */
function pickStratified(
  rng: Rng,
  cells: BandCell[],
  count: number,
  minSpacing: number,
  strata = 5,
): BandCell[] {
  if (count <= 0 || cells.length === 0) return [];
  const lo = Math.min(...cells.map((c) => c.d));
  const hi = Math.max(...cells.map((c) => c.d));
  if (hi - lo < 1e-6) return poissonPick(rng, cells, count, minSpacing);

  const width = (hi - lo) / strata;
  const groups: BandCell[][] = Array.from({ length: strata }, () => []);
  for (const c of cells) {
    const g = Math.min(strata - 1, Math.floor((c.d - lo) / width));
    groups[g]!.push(c);
  }

  const out: BandCell[] = [];
  const seen = new Set<number>();
  for (let g = 0; g < strata; g++) {
    // 前面若有分層抽不滿，缺額往後面的層補
    const want = Math.round(((g + 1) * count) / strata) - out.length;
    for (const c of poissonPick(rng, groups[g]!, want, minSpacing)) {
      const k = c.y * 100000 + c.x;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }

  // 還是不夠就從整個環帶補
  if (out.length < count) {
    for (const c of poissonPick(rng, cells, count * 2, minSpacing * 0.5)) {
      if (out.length >= count) break;
      const k = c.y * 100000 + c.x;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out.slice(0, count);
}

export interface AllocateOptions {
  /** 同行小隊。未指定時全部視為散客 */
  readonly squads?: readonly SquadRequest[];
}

/**
 * 批次分配 600 個出生點。
 *
 * 環帶依「到自家遺跡的直線距離」劃分，但只取**該陣營 Voronoi 區域內**的格 ——
 * `docs/01` §5.3 說的「環帶會被 Voronoi 邊界裁切」就發生在這裡。
 */
export function allocateSpawns(
  map: TerrainMap,
  sites: readonly RuinSite[],
  split: RegionSplit,
  seed: number,
  opts: AllocateOptions = {},
): SpawnAllocation {
  const rng = mulberry32(deriveSeed(seed, "spawn"));
  const { width, height } = MAP;

  // ── 鄰域統計（公平性檢查 a 與 d 的原料）──────────────────
  const buildableMask = new Uint8Array(width * height);
  const valuableMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(x, y, width);
      const c = map.cells[i]!;
      buildableMask[i] = c !== TERRAIN_CODE.MOUNTAIN && !inNoBuildZone(sites, x, y) ? 1 : 0;
      valuableMask[i] = c === TERRAIN_CODE.LODE || c === TERRAIN_CODE.FOREST ? 1 : 0;
    }
  }
  const buildableField = discCountField(buildableMask, 15);
  const valuableField = discCountField(valuableMask, 20);

  // ── 依 (陣營, 環帶) 分桶所有合法格 ────────────────────────
  const buckets = new Map<string, BandCell[]>();
  const bucketKey = (f: FactionId, b: SpawnBand) => `${f}:${b}`;
  for (const f of [1, 2, 3] as const) {
    for (const b of SPAWN_BANDS) buckets.set(bucketKey(f, b), []);
  }

  const ruinOf = new Map<FactionId, RuinSite>();
  for (const s of sites) ruinOf.set(s.id as FactionId, s);

  for (let y = MAP.edgeMargin; y < height - MAP.edgeMargin - 1; y++) {
    for (let x = MAP.edgeMargin; x < width - MAP.edgeMargin - 1; x++) {
      const owner = split.owner[idx(x, y, width)]!;
      if (owner < 1 || owner > 3) continue;
      const faction = owner as FactionId;
      const home = ruinOf.get(faction)!;
      const d = Math.hypot(x - home.x, y - home.y);

      let band: SpawnBand | null = null;
      for (const b of SPAWN_BANDS) {
        const [lo, hi] = SPAWN_BAND[b].radius;
        if (d >= lo && d < hi) {
          band = b;
          break;
        }
      }
      if (!band) continue;
      if (!isLegalSpawn(map, sites, x, y)) continue;

      const i = idx(x, y, width);
      buckets.get(bucketKey(faction, band))!.push({
        x,
        y,
        d,
        buildable: buildableField.counts[i]!,
        valuable: valuableField.counts[i]!,
      });
    }
  }

  // ── 全服的鄰域中位數 —— 目標是「大家都跟中位數差不多」 ──
  const allCells = [...buckets.values()].flat();
  const targetBuildable = median(allCells.map((c) => c.buildable));
  const targetValuable = median(allCells.map((c) => c.valuable));

  /**
   * 把候選格篩到接近中位數的那一批。逐步放寬容忍度，
   * 直到剩下的候選足以填滿名額（至少 6 倍，Poisson 才有得挑）。
   */
  const narrowToFair = (cells: BandCell[], quota: number): BandCell[] => {
    for (let tol = NEIGHBOURHOOD_TOLERANCE; tol <= 1.5; tol *= 1.35) {
      const kept = cells.filter(
        (c) =>
          Math.abs(c.buildable - targetBuildable) <= targetBuildable * tol &&
          Math.abs(c.valuable - targetValuable) <= targetValuable * tol,
      );
      if (kept.length >= quota * 6) return kept;
    }
    return cells;
  };

  // ── 每桶各自取樣 ─────────────────────────────────────────
  const points: SpawnPoint[] = [];
  const fill: SpawnAllocation["fill"] = [];
  let brokenSquads = 0;
  let squadCounter = 0;

  for (const f of [1, 2, 3] as const) {
    for (const b of SPAWN_BANDS) {
      const quota = SPAWN_BAND[b].quota;
      const cells = narrowToFair(buckets.get(bucketKey(f, b))!, quota);

      // docs/13 §3 步驟 4：r = sqrt(可用面積 / 人數) × 0.8
      const spacing = Math.sqrt(cells.length / Math.max(1, quota)) * 0.8;

      const squads = (opts.squads ?? []).filter((s) => s.faction === f && s.band === b);
      const squadSeats = squads.reduce((s, q) => s + Math.min(SQUAD.maxMembers, q.size), 0);
      const soloSeats = Math.max(0, quota - squadSeats);

      // 先放小隊的「隊長」，彼此拉開；再放散客
      const anchors = pickStratified(rng, cells, squads.length, spacing * 1.4);
      const taken: BandCell[] = [];

      squads.forEach((squad, si) => {
        const anchor = anchors[si];
        if (!anchor) {
          brokenSquads++;
          return;
        }
        const code = ++squadCounter;
        const size = Math.min(SQUAD.maxMembers, squad.size);
        // 隊員落在隊長周圍 8–15 格 —— 一起開始，但不是一支軍隊
        const near = cells.filter((c) => {
          const dd = Math.hypot(c.x - anchor.x, c.y - anchor.y);
          return dd >= SQUAD.clusterSpacing[0] && dd <= SQUAD.clusterSpacing[1];
        });
        const members = poissonPick(rng, near, size - 1, 4);
        if (members.length < size - 1) brokenSquads++;
        for (const c of [anchor, ...members]) {
          taken.push(c);
          points.push({
            x: c.x,
            y: c.y,
            faction: f,
            band: b,
            ruinDistance: c.d,
            region: regionOf(c.x, c.y),
            squad: code,
          });
        }
      });

      // 散客：排除已被小隊佔掉的位置附近
      const occupied = new Set(taken.map((c) => `${c.x},${c.y}`));
      const free = cells.filter((c) => !occupied.has(`${c.x},${c.y}`));
      const solos = pickStratified(rng, free, soloSeats, spacing);
      for (const c of solos) {
        points.push({
          x: c.x,
          y: c.y,
          faction: f,
          band: b,
          ruinDistance: c.d,
          region: regionOf(c.x, c.y),
          squad: null,
        });
      }

      fill.push({
        faction: f,
        band: b,
        placed: taken.length + solos.length,
        quota,
      });
    }
  }

  return { points, fill, brokenSquads };
}

/** 依 `SQUAD` 上限隨機產生一批同行小隊（測試與模擬用） */
export function randomSquads(
  seed: number,
  shareOfPlayers: number,
): SquadRequest[] {
  const rng = mulberry32(deriveSeed(seed, "squads"));
  const out: SquadRequest[] = [];
  for (const f of [1, 2, 3] as const) {
    for (const b of SPAWN_BANDS) {
      let seats = Math.round(SPAWN_BAND[b].quota * shareOfPlayers);
      while (seats >= 2) {
        const size = Math.min(seats, Math.max(2, Math.round(randRange(rng, 2, SQUAD.maxMembers))));
        out.push({ faction: f, band: b, size });
        seats -= size;
      }
    }
  }
  return out;
}
