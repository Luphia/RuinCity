/**
 * 出生點批次分配。純函式，無 I/O。
 * 對應 docs/13-season-registration.md §3 步驟 3–5。
 *
 * 所有人同時進入，所以任何不公平都會在第一天被攤在論壇上比較 ——
 * 分配必須是可驗證公平的，不能靠隨機祈禱。
 */

import { MAP, PLAYER_MIN_SPACING, SPAWN_BAND, SPAWN_BANDS, SQUAD, type SpawnBand } from "../balance";
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
  /** 有幾席塞不進 `PLAYER_MIN_SPACING`、降級成核心間距（名額不會少，只是離得近）。
      900×900 下應恆為 0 —— 這個計數存在是為了讓失敗看得見（`11` §22.1） */
  readonly spacingShort: number;
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
 *
 * ★ 500×500 時代的做法是「容忍度閾值池」：把候選篩到中位數 ±tol 再取樣。
 *   全域間距 8 之後那條路走不通 —— 每一席在間距 8 下消耗
 *   ~8²/0.56 ≈ 114 格的取樣面積（貪婪序列吸附的擁塞密度），
 *   池子要裝得下配額，容忍度就得放到接近不篩，(d) 直接炸到 40%。
 *   改成**分數排序的貪婪取樣**：每格算「離全服中位數多遠」的公平分數，
 *   洗牌後穩定排序、分數低的先拿、間距硬性擋 —— 公平性從二元門檻
 *   變成最佳化目標，間距逼一席讓步時，它讓到「次接近中位數」的格子，
 *   而不是掉進完全不篩的池子。分數量化成 0.04 的階（同分保留洗牌順序），
 *   同分格子之間仍是藍雜訊。
 */
const SCORE_QUANTUM = 0.02;

/**
 * ★ 理想間距（分佈品質）與地形公平（檢查 d）是**直接對立**的兩件事：
 *   前者要求 600 人鋪滿整個環帶，後者要求大家都住在「鄰域統計接近
 *   中位數」的那一小撮格子上，而那撮格子是成群的。
 *
 *   `docs/13` §3 步驟 4 的 `sqrt(面積/人數) × 0.8`（中原帶約 16 格）
 *   是在**沒有**全域最小間距的年代訂的 —— 那時它是唯一防止擠成一團的
 *   機制。現在間距 8 是硬性保證（`PLAYER_MIN_SPACING`），
 *   理想間距只剩「別讓半個環帶空著」這個較弱的目的，
 *   所以係數從 0.8 降到 0.35（中原帶約 8.7 格，實際仍受 8 格下限保護）。
 *
 *   實測（seed 99991）：0.8 → 檢查 (d) 42%；0.35 → 見 `11` §22.7 的表。
 */
const SPREAD_FACTOR = 0.35;

/**
 * ★ 出生點之間的**硬性**下限，切比雪夫距離。
 *
 * 據點核心是 2×2（`coreTiles()`），所以兩個出生點只要在任一軸上
 * 相距 < 2，兩人的核心就會**重疊**到同一格 —— 而 `tiles` 上
 * (season, x, y) 是唯一鍵，後寫的那位會靜靜地少掉一格主堡用地。
 * 開賽時看不出來，要等到玩家發現自己的主堡只有三格才會炸出來。
 *
 * 這個下限與下面那個「逐步放寬」的理想間距是兩回事：
 * 理想間距是分佈品質，可以妥協；這一條是資料完整性，不能妥協。
 *
 * ★ 就取 2，不多留緩衝。多留一格聽起來比較安全，但它會把候選池的
 *   需求從 quota × 6 拉到 quota × 18 —— 而那個池子是靠「鄰域統計接近
 *   全服中位數」篩出來的，要湊到 18 倍就得把容忍度放到 1.5，
 *   公平性檢查 (d) 直接從 2.8% 惡化到 28%。
 *   換句話說：為了幾格的呼吸空間，會讓一部分玩家系統性地生在比較好
 *   （或比較差）的地形上。核心貼核心只是擠，那個才是不公平。
 */
export const HARD_MIN_SPACING = 2;

/**
 * 全服的佔位表。
 *
 * `poissonPick` 只看得到**同一次呼叫**裡的點，但九個 (陣營, 環帶) 桶是
 * 各自取樣的，小隊與散客又分兩批 —— 環帶交界處的兩個人完全可能相差一格。
 * 所以硬性下限必須有一份跨桶的紀錄。
 */
interface Blocker {
  take(x: number, y: number): void;
  free(c: { x: number; y: number }): boolean;
}

function createBlocker(r = HARD_MIN_SPACING - 1): Blocker {
  const blocked = new Set<number>();
  const key = (x: number, y: number) => y * 100000 + x;
  return {
    take(x: number, y: number) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) blocked.add(key(x + dx, y + dy));
      }
    },
    free: (c: { x: number; y: number }) => !blocked.has(key(c.x, c.y)),
  };
}

/** 兩份佔位表疊在一起：真人的點要同時滿足一般間距與真人間距 */
function composeBlockers(a: Blocker, b: Blocker): Blocker {
  return {
    take(x: number, y: number) {
      a.take(x, y);
      b.take(x, y);
    },
    free: (c: { x: number; y: number }) => a.free(c) && b.free(c),
  };
}

/**
 * Poisson-disk sampling（Bridson）在一組離散候選格上。
 *
 * 標準 Bridson 在連續空間取樣，但這裡的合法格是離散且形狀不規則的
 * （環帶被 Voronoi 邊界與山脈裁切），所以改成「洗牌後貪婪挑選 +
 * 空間雜湊做最小間距檢查」—— 結果同樣是藍雜訊分佈，而且不會卡在
 * 找不到候選點的無限重試裡。
 *
 * `blocker` 是跨呼叫的佔位表。每一次呼叫都只看得到自己挑出來的點，
 * 但這個函式會被呼叫很多次（九個桶 × 五個分層 × 小隊/散客兩批），
 * 硬性下限只有靠它才守得住。
 */
function poissonPick(
  rng: Rng,
  cells: BandCell[],
  count: number,
  minSpacing: number,
  blocker: Blocker = createBlocker(),
  score?: (c: BandCell) => number,
  caps?: StratumCaps,
): BandCell[] {
  if (count <= 0) return [];
  const picked: BandCell[] = [];
  const capUsed = caps ? new Int32Array(caps.caps.length) : null;

  // 空間雜湊：格寬 = 最小間距，只需檢查 3×3 個桶。
  // 格寬不得小於硬性下限，否則 3×3 的鄰域看不到該擋的那個點
  const bucketSize = Math.max(HARD_MIN_SPACING, minSpacing);
  const buckets = new Map<number, BandCell[]>();
  const key = (x: number, y: number) =>
    Math.floor(y / bucketSize) * 100000 + Math.floor(x / bucketSize);

  // 硬性下限由 blocker 負責（切比雪夫，2×2 核心是方的）；
  // 這裡的 farEnough 只管「分佈品質」那個可以妥協的理想間距
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

  /** 分層軟上限：這一層已經拿夠了就跳過（`StratumCaps` 的說明） */
  const capOk = (c: BandCell) =>
    !caps || capUsed![caps.keyOf(c)]! < caps.caps[caps.keyOf(c)]!;

  const add = (c: BandCell) => {
    picked.push(c);
    blocker.take(c.x, c.y);
    if (caps) capUsed![caps.keyOf(c)]!++;
    const k = key(c.x, c.y);
    const list = buckets.get(k);
    if (list) list.push(c);
    else buckets.set(k, [c]);
  };

  /**
   * 洗牌決定同分格子之間的順序（藍雜訊），再依**公平分數**穩定排序 ——
   * 分數低（離全服中位數近）的先拿。分數量化成階（`SCORE_QUANTUM`），
   * 所以同一階內仍然是洗牌後的隨機順序：公平是目標，不是逐格的最佳化。
   */
  const pool = shuffle(rng, cells.slice());
  if (score) {
    const q = new Map<BandCell, number>();
    for (const c of pool) q.set(c, Math.round(score(c) / SCORE_QUANTUM));
    pool.sort((a, b) => q.get(a)! - q.get(b)!);
  }
  const used = new Set<number>();

  // 逐步放寬間距：先用理想間距鋪滿，不夠再降低要求。
  // 這比「取樣失敗就整個重來」穩定得多。
  for (let spacing = minSpacing; spacing >= 1 && picked.length < count; spacing *= 0.8) {
    for (const c of pool) {
      if (picked.length >= count) break;
      const k = c.y * 100000 + c.x;
      if (used.has(k)) continue;
      if (!blocker.free(c)) continue;
      if (!capOk(c)) continue;
      if (!farEnough(c, spacing)) continue;
      used.add(k);
      add(c);
    }
  }

  /**
   * 最後保底：只要還有沒用過的格子就填 —— 名額不能少人。
   *
   * ★ 但硬性下限仍然要守。填不滿的話 `fill.placed < quota` 會讓
   *   `generateWorld` 換 seed 重來，這比讓兩個人生在同一格好得多。
   */
  for (const c of pool) {
    if (picked.length >= count) break;
    const k = c.y * 100000 + c.x;
    if (used.has(k)) continue;
    if (!blocker.free(c)) continue;
    if (!capOk(c)) continue;
    used.add(k);
    add(c);
  }
  return picked;
}

/**
 * 分層軟上限。`keyOf` 把一格對應到它的分層索引，`caps[i]` 是那一層
 * 最多能拿幾席 —— 「軟」的意思是：拿不滿時呼叫端會再跑一次不帶上限的補位。
 */
interface StratumCaps {
  readonly keyOf: (c: BandCell) => number;
  readonly caps: readonly number[];
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
  blocker: Blocker = createBlocker(),
  score?: (c: BandCell) => number,
  strata = 5,
): BandCell[] {
  if (count <= 0 || cells.length === 0) return [];
  const lo = Math.min(...cells.map((c) => c.d));
  const hi = Math.max(...cells.map((c) => c.d));
  if (hi - lo < 1e-6) return poissonPick(rng, cells, count, minSpacing, blocker, score);

  /**
   * ★ 分層是**軟上限**，不是硬配額。
   *
   *   舊版把環帶切五層、每層各自取樣同樣多人。它確實壓住了檢查 (b)，
   *   但也把公平分數的選擇權切碎了：某一層的地形若整片偏離中位數，
   *   那一層的席位只能挑該層最不糟的格子 —— 全域間距 8 之後這個代價
   *   直接讓檢查 (d) 從 14% 惡化到 27%（同一張圖、同一組 seed）。
   *
   *   改成「一次貪婪 + 每層上限 `SLACK` 倍的均分」：分數低的先拿，
   *   但沒有任何一層能吃掉超過 1.5 倍的份額 —— 距離分佈仍然鋪得開
   *   （檢查 b 的三陣營均距差維持在 3 格以內），地形選擇卻回到全域最佳。
   */
  const SLACK = 1.5;
  const width = (hi - lo) / strata;
  const keyOf = (c: BandCell) => Math.min(strata - 1, Math.floor((c.d - lo) / width));
  const caps = Array.from({ length: strata }, () => Math.ceil((count / strata) * SLACK));

  const out: BandCell[] = [];
  const seen = new Set<number>();
  const take = (list: readonly BandCell[]) => {
    for (const c of list) {
      if (out.length >= count) break;
      const k = c.y * 100000 + c.x;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  };

  take(poissonPick(rng, cells, count, minSpacing, blocker, score, { keyOf, caps }));

  // 上限擋掉之後還不夠 → 放掉上限再補（名額優先於分佈品質）。
  // ★ 這裡也要用**同一份**跨呼叫佔位表 —— 早期版本在這條保底路徑
  //   忘了傳 blocker（用了函式簽章的預設新表），就是 §20.4
  //   「600 人裡有人核心重疊」那一類靜默資料損壞的溫床。
  if (out.length < count) {
    take(poissonPick(rng, cells, count - out.length, minSpacing * 0.5, blocker, score));
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
   * 公平分數：這一格的鄰域統計離**全服中位數**有多遠（相對誤差）。
   * 0 = 完全在中位數上。取樣時分數低的先拿 —— 見 `SCORE_QUANTUM`。
   *
   * ★ 兩項**不是等權**。高價值地形（LODE/FOREST）是雜訊的高分位數、
   *   天生成群，全候選格的相對標準差 97%；可建設格數則平坦得多
   *   （檢查 a 實測 2%，門檻 8%）。等權相加的話，可建設那一項的
   *   小抖動會把高價值那一項的排序打散 —— 明明只有 (d) 是瓶頸，
   *   卻讓不是瓶頸的那一項決定誰先拿。權重 0.15 讓它只當同分時的鑑別。
   */
  const BUILDABLE_WEIGHT = 0.15;
  const fairScore = (c: BandCell): number =>
    (targetValuable > 0 ? Math.abs(c.valuable - targetValuable) / targetValuable : 0) +
    (targetBuildable > 0
      ? (BUILDABLE_WEIGHT * Math.abs(c.buildable - targetBuildable)) / targetBuildable
      : 0);

  // ── 每桶各自取樣 ─────────────────────────────────────────
  const points: SpawnPoint[] = [];
  const fill: SpawnAllocation["fill"] = [];
  let brokenSquads = 0;
  let squadCounter = 0;
  const blocker = createBlocker();

  /**
   * ★ 全域間距（`docs/11` §22.1）：任兩位領主 ≥ `PLAYER_MIN_SPACING`（8，
   *   切比雪夫），真人與 AI 一視同仁，跨桶共用一份佔位表。
   *   小隊成員彼此豁免（自願聚落）：叢集先擺好、再整組記進表裡 ——
   *   陌生人與小隊成員之間仍然 ≥ 8，只有隊友彼此可以更近。
   *   500×500 時代這裡只保護真人（HUMAN_MIN_SPACING = 11，全服一律 11
   *   幾何上塞不下）；900×900 之後全域 8 是硬性保證，人機之別退役。
   */
  const spacingBlocker = createBlocker(PLAYER_MIN_SPACING - 1);
  const spaced = composeBlockers(blocker, spacingBlocker);
  let spacingShort = 0;

  for (const f of [1, 2, 3] as const) {
    for (const b of SPAWN_BANDS) {
      const quota = SPAWN_BAND[b].quota;
      /**
       * 整個環帶都是候選 —— 公平性由 `fairScore` 的排序負責，
       * 不再先篩掉一批格子。舊的「容忍度池階梯」在全域間距 8 下
       * 會讓緊的池子整層開不了，席位直接漏到不篩的那一階（(d) 炸到 40%）。
       */
      const cells = buckets.get(bucketKey(f, b))!;

      // docs/13 §3 步驟 4：r = sqrt(可用面積 / 人數) × 0.8
      const spacing = Math.max(
        PLAYER_MIN_SPACING,
        Math.sqrt(cells.length / Math.max(1, quota)) * SPREAD_FACTOR,
      );

      const squads = (opts.squads ?? []).filter((s) => s.faction === f && s.band === b);
      const squadSeats = squads.reduce((s, q) => s + Math.min(SQUAD.maxMembers, q.size), 0);
      const soloSeats = Math.max(0, quota - squadSeats);

      // 先放小隊的「隊長」，彼此拉開；再放散客。
      // 隊長本身是一席，走全域間距（複合佔位表）；
      // 隊員在叢集**擺好之後**才整組記進間距表 —— 隊友彼此豁免（自願聚落）
      const anchors = pickStratified(
        rng,
        cells.filter(spacingBlocker.free),
        squads.length,
        spacing * 1.4,
        spaced,
        fairScore,
      );
      const taken: BandCell[] = [];

      squads.forEach((squad, si) => {
        const anchor = anchors[si];
        if (!anchor) {
          brokenSquads++;
          return;
        }
        const code = ++squadCounter;
        const size = Math.min(SQUAD.maxMembers, squad.size);
        // 隊員落在隊長周圍 8–15 格 —— 一起開始，但不是一支軍隊。
        // 對**陌生人**仍要守全域間距（spacingBlocker.free），只對隊友豁免
        const near = cells.filter((c) => {
          if (!blocker.free(c) || !spacingBlocker.free(c)) return false;
          const dd = Math.hypot(c.x - anchor.x, c.y - anchor.y);
          return dd >= SQUAD.clusterSpacing[0] && dd <= SQUAD.clusterSpacing[1];
        });
        const members = poissonPick(rng, near, size - 1, 4, blocker, fairScore);
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
        // 叢集擺好，整組記進間距表 —— 之後的每一席都離他們 ≥ 8
        for (const c of [anchor, ...members]) spacingBlocker.take(c.x, c.y);
      });

      // 散客：真人與 AI 同一條規則，一律走全域間距（核心 2 + 間距 8）。
      // 分層取樣照顧遺跡距離（檢查 b），fairScore 照顧地形（檢查 a、d）
      const solos = pickStratified(
        rng,
        cells.filter(spaced.free),
        soloSeats,
        spacing,
        spaced,
        fairScore,
      );

      /**
       * 保底：塞不進全域間距時，逐席降級成核心間距 ——
       * 名額永遠不能少人（少一席 = 換 seed 白跑一整輪世界生成）。
       * 降級席位計數（spacingShort），封盤 log 要講出來；
       * 降級的席位仍記進間距表，後面的席位照樣離他 ≥ 8。
       *
       * ★ 900×900 下這條路徑不該被走到（每帶有 3–4 倍的幾何餘裕，
       *   `11` §22.1）。它存在只是為了讓「塞不下」變成一個看得見的數字，
       *   而不是靜默地少人或靜默地擠在一起。
       */
      const extra: BandCell[] = [];
      const stillShort = quota - taken.length - solos.length;
      if (stillShort > 0) {
        const degraded = pickStratified(
          rng,
          cells.filter(blocker.free),
          stillShort,
          spacing,
          blocker,
          fairScore,
        );
        spacingShort += degraded.length;
        for (const c of degraded) spacingBlocker.take(c.x, c.y);
        extra.push(...degraded);
      }

      for (const c of [...solos, ...extra]) {
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
        placed: taken.length + solos.length + extra.length,
        quota,
      });
    }
  }

  return { points, fill, brokenSquads, spacingShort };
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
