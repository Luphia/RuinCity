/**
 * 執政官的決策函式。純函式，無 I/O。
 * 對應 docs/18-steward.md。
 *
 * ## ★ 鐵則：執行者，不是決策者
 *
 * 整份企劃的核心是「選擇本身就是玩法」。如果執政官替領主做選擇，
 * 玩法就被拿走了。所以這個模組**結構上**就碰不到那些東西 ——
 * 它的回傳型別裡根本沒有「升主堡」「出兵」「拆除」「掛單」這些動作。
 * 不是靠檢查擋下來的，是根本沒有那個 case。
 *
 * ## ★ 只在佇列閒置時行動
 *
 * 這是整個系統最重要的設計：玩家自己排了東西，執政官就沒有回合。
 * 於是「玩家 vs 執政官」的衝突**根本不會發生**，
 * 不需要任何衝突解決邏輯。你玩得越勤，執政官越沒事做。
 *
 * ## ★ 刻意次優
 *
 * 如果全權委託跟親自操作一樣好，就沒有理由登入了（`18` §5）。
 * 執政官選**最近的合法格**而不是最好的地形、
 * 依優先序找**第一個空格**而不是最適合的位置。
 * 目標是完全委託的玩家第 12 天總戰力為積極玩家的 75–85%。
 */

import {
  FACILITY,
  STEWARD,
  STEWARD_DIRECTIVES,
  UNIT,
  type Facility,
  type StewardDirective,
  type Terrain,
  type Unit,
} from "./balance";
import { facilityCost, facilityLevelCap, stewardDirectiveSlots } from "./formulas";
import { deriveSeed, mulberry32 } from "./rng";
import { claimCost } from "./territory";
import { zeroAmounts, type Amounts, type SettleResource } from "./settle";

// ─────────────────────────────────────────────────────────────
// 方針
// ─────────────────────────────────────────────────────────────

export type ExpansionPreference = "NEAREST" | "TOWARD_RUIN" | "TOWARD_WILD";

export interface ExpansionDirective {
  readonly enabled: boolean;
  readonly preference: ExpansionPreference;
  readonly reserve: Amounts;
}

export interface DevelopmentDirective {
  readonly enabled: boolean;
  /** 設施優先序。沒列到的種類執政官不會蓋 */
  readonly priority: readonly Facility[];
  readonly reserve: Amounts;
}

export interface LevyDirective {
  readonly enabled: boolean;
  /** 兵種配比（權重，不需要加總為 1） */
  readonly mix: Readonly<Partial<Record<Unit, number>>>;
  /** 人口保留下限 —— 低於這個數就不再招兵 */
  readonly populationReserve: number;
  readonly reserve: Amounts;
}

export interface Directives {
  readonly expansion: ExpansionDirective;
  readonly development: DevelopmentDirective;
  readonly levy: LevyDirective;
  /** 領主接管：暫停到什麼時候。null = 沒暫停 */
  readonly pausedUntil: number | null;
}

export const DEFAULT_PRIORITY: readonly Facility[] = [
  "FARM",
  "SAWMILL",
  "QUARRY",
  "MINE",
  "WATCHTOWER",
];

/**
 * 預設方針：**全部關閉**。
 *
 * ★ 不預設開啟。執政官是領主的工具，不是替領主決定要不要用工具的人 ——
 *   預設開啟等於在玩家還沒理解取捨之前就先幫他做了第一個決定。
 */
export function defaultDirectives(): Directives {
  return {
    expansion: { enabled: false, preference: "NEAREST", reserve: zeroAmounts() },
    development: { enabled: false, priority: DEFAULT_PRIORITY, reserve: zeroAmounts() },
    levy: { enabled: false, mix: { MILITIA: 1 }, populationReserve: 0, reserve: zeroAmounts() },
    pausedUntil: null,
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function amountsOf(v: unknown): Amounts {
  const o = (v ?? {}) as Partial<Record<SettleResource, unknown>>;
  const out = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    if (isNum(o[r])) out[r] = Math.max(0, o[r]);
  }
  return out;
}

/**
 * 把資料庫裡的 jsonb 讀成方針。認不出來的欄位一律退回預設值。
 *
 * ★ 缺欄位時**退回「關閉」而不是「開啟」**。方針格式演進時，
 *   舊資料的最壞情況應該是「執政官不動」，不是「執政官拿舊參數亂花錢」。
 */
export function parseDirectives(raw: unknown): Directives {
  const p = (raw ?? {}) as Record<string, unknown>;
  const d = defaultDirectives();

  const exp = (p.expansion ?? {}) as Record<string, unknown>;
  const dev = (p.development ?? {}) as Record<string, unknown>;
  const lev = (p.levy ?? {}) as Record<string, unknown>;

  const priority = Array.isArray(dev.priority)
    ? dev.priority.filter((f): f is Facility => typeof f === "string" && f in FACILITY)
    : DEFAULT_PRIORITY;

  const mix: Partial<Record<Unit, number>> = {};
  if (lev.mix && typeof lev.mix === "object") {
    for (const [k, v] of Object.entries(lev.mix as Record<string, unknown>)) {
      if (k in UNIT && isNum(v) && v > 0) mix[k as Unit] = v;
    }
  }

  return {
    expansion: {
      enabled: exp.enabled === true,
      preference:
        exp.preference === "TOWARD_RUIN" || exp.preference === "TOWARD_WILD"
          ? exp.preference
          : "NEAREST",
      reserve: amountsOf(exp.reserve),
    },
    development: {
      enabled: dev.enabled === true,
      priority: priority.length > 0 ? priority : DEFAULT_PRIORITY,
      reserve: amountsOf(dev.reserve),
    },
    levy: {
      enabled: lev.enabled === true,
      mix: Object.keys(mix).length > 0 ? mix : d.levy.mix,
      populationReserve: isNum(lev.populationReserve) ? Math.max(0, lev.populationReserve) : 0,
      reserve: amountsOf(lev.reserve),
    },
    pausedUntil: isNum(p.pausedUntil) ? p.pausedUntil : null,
  };
}

/**
 * 實際生效的方針。
 *
 * 可同時啟用的數量由主堡等級決定（`1 + ⌊主堡/8⌋`，上限 3）——
 * 早期只能開一個，於是又是一個取捨：「幫我拓荒，還是幫我募兵？」
 *
 * ★ 開超過額度時，依 `STEWARD_DIRECTIVES` 的宣告順序取前 N 個。
 *   必須是**確定性**的：模擬要能重放，而且玩家看到的「哪個被停用了」
 *   不能每次讀取都不一樣。
 */
export function activeDirectives(
  directives: Directives,
  citadelLevel: number,
): readonly StewardDirective[] {
  const slots = stewardDirectiveSlots(citadelLevel);
  const enabled = STEWARD_DIRECTIVES.filter((d) =>
    d === "EXPANSION"
      ? directives.expansion.enabled
      : d === "DEVELOPMENT"
        ? directives.development.enabled
        : directives.levy.enabled,
  );
  return enabled.slice(0, slots);
}

/** 有幾個方針因為額度不夠而被停用 */
export function directivesOverLimit(directives: Directives, citadelLevel: number): number {
  const enabled =
    (directives.expansion.enabled ? 1 : 0) +
    (directives.development.enabled ? 1 : 0) +
    (directives.levy.enabled ? 1 : 0);
  return Math.max(0, enabled - stewardDirectiveSlots(citadelLevel));
}

// ─────────────────────────────────────────────────────────────
// 決策的輸入
// ─────────────────────────────────────────────────────────────

/**
 * 一個可拓荒的候選格。
 *
 * ★ 只帶**地理事實**，不帶成本。成本由這個模組用 `claimCost()` 自己算 ——
 *   拓荒成本隨已有領土遞增，而同一輪可能連拓好幾格，
 *   呼叫端算好的那個數字在第二格就已經過期了。
 */
export interface StewardCandidate {
  readonly x: number;
  readonly y: number;
  readonly terrain: Terrain;
  /** 離核心據點的距離（格） */
  readonly distanceToBase: number;
  /** 離最近一座遺跡的距離（格）。不知道就給 Infinity */
  readonly distanceToRuin: number;
  /** 相鄰的**他人**領土數 —— 「朝荒野」要避開的就是這個 */
  readonly hostileNeighbours: number;
}

/**
 * 一個可蓋／可升的設施機會。
 *
 * ★ 同樣只帶事實。空地的成本取決於「要蓋哪一種」，
 *   而那是方針優先序決定的 —— 呼叫端不知道，也不該猜。
 */
export interface StewardFacilityOption {
  readonly x: number;
  readonly y: number;
  readonly terrain: Terrain;
  /** 這格現在的設施；null = 空地 */
  readonly facility: Facility | null;
  readonly level: number;
}

export interface StewardInput {
  readonly now: number;
  readonly citadelLevel: number;
  readonly directives: Directives;

  readonly resources: Amounts;
  readonly capacity: number;
  /** 每小時淨收支（已套季節），只用來算溢出警告 */
  readonly netPerHour: Amounts;

  readonly population: { readonly amount: number; readonly cap: number; readonly used: number };

  /** 閒置的領土佇列數。拓荒與建設**共用**這些佇列 */
  readonly territoryQueuesFree: number;
  /** 閒置的兵營佇列數。M3 之前一律 0 */
  readonly barracksQueuesFree: number;

  readonly ownedCount: number;
  readonly territoryCapacity: number;

  readonly candidates: readonly StewardCandidate[];
  readonly facilityOptions: readonly StewardFacilityOption[];
}

// ─────────────────────────────────────────────────────────────
// 決策的輸出
// ─────────────────────────────────────────────────────────────

export type StewardAction =
  | { readonly kind: "CLAIM"; readonly x: number; readonly y: number }
  | {
      readonly kind: "BUILD";
      readonly x: number;
      readonly y: number;
      readonly facility: Facility;
      readonly toLevel: number;
    }
  | { readonly kind: "LEVY"; readonly unit: Unit; readonly count: number };

export type BlockReason =
  | "PAUSED"
  | "NO_SLOT"
  | "QUEUE_BUSY"
  | "RESERVE"
  | "AT_CAPACITY"
  | "NO_TARGET"
  | "LEVEL_CAPPED"
  | "POPULATION_RESERVE";

export interface StewardBlock {
  readonly directive: StewardDirective;
  readonly reason: BlockReason;
  /** 給簡報用的補充，例如「本可再拓荒 2 格」 */
  readonly detail?: string;
}

export type WarningKind = "OVERFLOW_SOON" | "POPULATION_CAPPED" | "TERRITORY_CAPPED";

export interface StewardWarning {
  readonly kind: WarningKind;
  readonly resource?: SettleResource;
  readonly hours?: number;
}

export interface StewardDecision {
  readonly actions: readonly StewardAction[];
  readonly blocked: readonly StewardBlock[];
  readonly warnings: readonly StewardWarning[];
}

/** 保留下限以上才能動用（`18` §4.2） */
export function spendable(resources: Amounts, reserve: Amounts): Amounts {
  const out = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    out[r] = Math.max(0, resources[r] - reserve[r]);
  }
  return out;
}

function affordable(available: Amounts, cost: Amounts): boolean {
  return (
    available.grain >= cost.grain &&
    available.timber >= cost.timber &&
    available.stone >= cost.stone &&
    available.iron >= cost.iron
  );
}

function subtract(a: Amounts, b: Amounts): Amounts {
  const out = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) out[r] = a[r] - b[r];
  return out;
}

/** 溢出警告的提前量（真實小時） */
const OVERFLOW_WARNING_HOURS = 4;

/**
 * 決定執政官這一輪要做什麼。
 *
 * 回傳的動作由呼叫端**逐一送進與玩家相同的 Server Action** ——
 * 若動作不合法，它就是失敗。執政官不可能作弊（`18` §11.2）。
 */
export function decideStewardActions(input: StewardInput): StewardDecision {
  const warnings = collectWarnings(input);

  if (input.directives.pausedUntil !== null && input.directives.pausedUntil > input.now) {
    return {
      actions: [],
      blocked: STEWARD_DIRECTIVES.map((d) => ({ directive: d, reason: "PAUSED" as const })),
      warnings,
    };
  }

  const active = new Set(activeDirectives(input.directives, input.citadelLevel));
  const blocked: StewardBlock[] = [];

  for (const d of STEWARD_DIRECTIVES) {
    const enabled =
      d === "EXPANSION"
        ? input.directives.expansion.enabled
        : d === "DEVELOPMENT"
          ? input.directives.development.enabled
          : input.directives.levy.enabled;
    if (enabled && !active.has(d)) {
      blocked.push({
        directive: d,
        reason: "NO_SLOT",
        detail: `主堡 Lv${input.citadelLevel} 只能同時啟用 ${stewardDirectiveSlots(input.citadelLevel)} 個方針`,
      });
    }
  }

  const actions: StewardAction[] = [];
  const territory = planTerritory(input, active, blocked, actions);
  planLevy(input, active, blocked, actions, territory.remaining);

  return { actions, blocked, warnings };
}

/**
 * 拓荒與建設**共用領土佇列**，所以要一起排。
 *
 * ★ 順序：**先把已佔的地用起來，再去拓新的**。
 *   一塊光禿禿的領土不產出任何東西，卻已經把拓荒成本墊高了
 *   （成本隨已有領土遞增）。先建設是保守但站得住腳的政策 ——
 *   也確實比會抓時機衝領土的玩家次優。
 */
function planTerritory(
  input: StewardInput,
  active: ReadonlySet<StewardDirective>,
  blocked: StewardBlock[],
  actions: StewardAction[],
): { remaining: Amounts } {
  const wantsDev = active.has("DEVELOPMENT");
  const wantsExp = active.has("EXPANSION");
  if (!wantsDev && !wantsExp) return { remaining: input.resources };

  if (input.territoryQueuesFree <= 0) {
    for (const d of ["DEVELOPMENT", "EXPANSION"] as const) {
      if (active.has(d)) blocked.push({ directive: d, reason: "QUEUE_BUSY" });
    }
    return { remaining: input.resources };
  }

  // 兩個方針各有各的保留下限，所以「還剩多少能花」要分開追蹤
  let devBudget = wantsDev
    ? spendable(input.resources, input.directives.development.reserve)
    : zeroAmounts();
  let expBudget = wantsExp
    ? spendable(input.resources, input.directives.expansion.reserve)
    : zeroAmounts();
  let pool = input.resources;

  const usedTiles = new Set<string>();
  let owned = input.ownedCount;
  let devBlockedBy: BlockReason | null = null;
  let expBlockedBy: BlockReason | null = null;
  let devSkipped = 0;
  let expSkipped = 0;

  const levelCap = facilityLevelCap(input.citadelLevel);

  for (let slot = 0; slot < input.territoryQueuesFree; slot++) {
    let placed = false;

    if (wantsDev) {
      const option = pickFacility(input, usedTiles, levelCap);
      if (!option) {
        devBlockedBy ??= input.facilityOptions.some((o) => o.level >= levelCap)
          ? "LEVEL_CAPPED"
          : "NO_TARGET";
      } else if (!affordable(devBudget, option.cost)) {
        devBlockedBy ??= "RESERVE";
        devSkipped++;
      } else {
        actions.push({
          kind: "BUILD",
          x: option.x,
          y: option.y,
          facility: option.facility,
          toLevel: option.level + 1,
        });
        usedTiles.add(`${option.x},${option.y}`);
        devBudget = subtract(devBudget, option.cost);
        expBudget = subtract(expBudget, option.cost);
        pool = subtract(pool, option.cost);
        placed = true;
      }
    }

    if (!placed && wantsExp) {
      if (owned >= input.territoryCapacity) {
        expBlockedBy ??= "AT_CAPACITY";
      } else {
        const target = pickCandidate(input, usedTiles);
        // 成本隨已有領土遞增，所以每一格都要用**當下的** owned 重算
        const raw = claimCost(owned);
        const cost: Amounts = { ...zeroAmounts(), grain: raw.grain, timber: raw.timber };
        if (!target) {
          expBlockedBy ??= "NO_TARGET";
        } else if (!affordable(expBudget, cost)) {
          expBlockedBy ??= "RESERVE";
          expSkipped++;
        } else {
          actions.push({ kind: "CLAIM", x: target.x, y: target.y });
          usedTiles.add(`${target.x},${target.y}`);
          devBudget = subtract(devBudget, cost);
          expBudget = subtract(expBudget, cost);
          pool = subtract(pool, cost);
          owned++;
          placed = true;
        }
      }
    }

    if (!placed) break;
  }

  /**
   * ★ `BLOCKED` 跟行動一樣要被看見（`18` §11.4）。
   *   「木材保留下限 5,000，本可再拓荒 2 格」—— 執政官**沒做什麼**
   *   跟它做了什麼一樣需要告訴領主。
   */
  if (wantsDev && devBlockedBy) {
    blocked.push({
      directive: "DEVELOPMENT",
      reason: devBlockedBy,
      detail:
        devBlockedBy === "RESERVE" ? `保留下限擋住了 ${devSkipped} 次建設` : undefined,
    });
  }
  if (wantsExp && expBlockedBy) {
    blocked.push({
      directive: "EXPANSION",
      reason: expBlockedBy,
      detail: expBlockedBy === "RESERVE" ? `保留下限擋住了 ${expSkipped} 次拓荒` : undefined,
    });
  }

  return { remaining: pool };
}

/**
 * 挑一個設施機會。
 *
 * ★ 刻意次優：依優先序找**第一個**符合的格，不看地形適配。
 *   親自操作的玩家會把農田放在非森林格、哨塔放在細頸（`18` §5）。
 */
function pickFacility(
  input: StewardInput,
  used: ReadonlySet<string>,
  levelCap: number,
): { x: number; y: number; facility: Facility; level: number; cost: Amounts } | null {
  const priority = input.directives.development.priority;
  const costOf = (f: Facility, level: number): Amounts => {
    const raw = facilityCost(f, level);
    return {
      grain: raw.grain ?? 0,
      timber: raw.timber ?? 0,
      stone: raw.stone ?? 0,
      iron: raw.iron ?? 0,
    };
  };

  // 先補空地：一塊沒有設施的領土完全不產出，卻已經把拓荒成本墊高了
  for (const want of priority) {
    for (const o of input.facilityOptions) {
      if (used.has(`${o.x},${o.y}`)) continue;
      if (o.facility !== null) continue;
      if (levelCap < 1) continue;
      return { x: o.x, y: o.y, facility: want, level: 0, cost: costOf(want, 1) };
    }
  }

  // 再升級既有設施，依優先序
  for (const want of priority) {
    for (const o of input.facilityOptions) {
      if (used.has(`${o.x},${o.y}`)) continue;
      if (o.facility !== want) continue;
      if (o.level + 1 > levelCap) continue;
      return { x: o.x, y: o.y, facility: want, level: o.level, cost: costOf(want, o.level + 1) };
    }
  }

  return null;
}

/**
 * 挑一個拓荒目標。
 *
 * ★ 刻意次優：`NEAREST` 選**最近的合法格**，不挑 `LODE` / `FOREST`
 *   等高價值地形。就近向外攤的結果是版圖容易長出細頸 ——
 *   而那正是 `18` §12 要驗的「執政官創造了可被利用的弱點」。
 */
function pickCandidate(
  input: StewardInput,
  used: ReadonlySet<string>,
): StewardCandidate | null {
  const pref = input.directives.expansion.preference;
  let best: StewardCandidate | null = null;
  let bestScore = Infinity;

  for (const c of input.candidates) {
    if (used.has(`${c.x},${c.y}`)) continue;
    const score =
      pref === "TOWARD_RUIN"
        ? c.distanceToRuin
        : pref === "TOWARD_WILD"
          ? c.hostileNeighbours * 1000 + c.distanceToBase
          : c.distanceToBase;
    // 平手時用座標決勝，確保**確定性**（模擬要能重放）
    if (
      score < bestScore ||
      (score === bestScore && best !== null && (c.x < best.x || (c.x === best.x && c.y < best.y)))
    ) {
      best = c;
      bestScore = score;
    }
  }

  return best;
}

/**
 * 募兵。
 *
 * ★ M3 之前 `barracksQueuesFree` 恆為 0，所以這裡只會產出 `QUEUE_BUSY`。
 *   決策邏輯先寫好並測起來，M3 接上兵營之後不需要改這個函式。
 */
function planLevy(
  input: StewardInput,
  active: ReadonlySet<StewardDirective>,
  blocked: StewardBlock[],
  actions: StewardAction[],
  pool: Amounts,
) {
  if (!active.has("LEVY")) return;

  if (input.barracksQueuesFree <= 0) {
    blocked.push({ directive: "LEVY", reason: "QUEUE_BUSY" });
    return;
  }

  const free = Math.max(0, input.population.cap - input.population.used);
  if (free <= input.directives.levy.populationReserve) {
    blocked.push({ directive: "LEVY", reason: "POPULATION_RESERVE" });
    return;
  }

  const budget = spendable(pool, input.directives.levy.reserve);
  const entries = Object.entries(input.directives.levy.mix)
    .filter((e): e is [Unit, number] => (e[1] ?? 0) > 0)
    // 依 UNITS 的宣告順序，不依物件的鍵序 —— 後者不保證穩定
    .sort((a, b) => UNIT_ORDER.indexOf(a[0]) - UNIT_ORDER.indexOf(b[0]));
  const totalWeight = entries.reduce((s, [, w]) => s + w, 0);
  if (totalWeight <= 0) {
    blocked.push({ directive: "LEVY", reason: "NO_TARGET" });
    return;
  }

  const popBudget = free - input.directives.levy.populationReserve;
  const spent = budget;
  let popLeft = popBudget;
  let any = false;

  for (const [unit, weight] of entries) {
    const spec = UNIT[unit];
    const share = weight / totalWeight;
    const wantCount = Math.floor((popBudget * share) / Math.max(1, spec.population));
    if (wantCount <= 0) continue;

    // 錢與人口哪個先見底就以哪個為準
    const byResource = Math.min(
      ...(["grain", "timber", "stone", "iron"] as const).map((r) =>
        spec.cost[r] > 0 ? Math.floor(spent[r] / spec.cost[r]) : Infinity,
      ),
    );
    const count = Math.max(
      0,
      Math.min(wantCount, byResource, Math.floor(popLeft / Math.max(1, spec.population))),
    );
    if (count <= 0) continue;

    actions.push({ kind: "LEVY", unit, count });
    for (const r of ["grain", "timber", "stone", "iron"] as const) {
      spent[r] -= spec.cost[r] * count;
    }
    popLeft -= count * spec.population;
    any = true;
  }

  if (!any) blocked.push({ directive: "LEVY", reason: "RESERVE" });
}

const UNIT_ORDER = Object.keys(UNIT) as Unit[];

/**
 * 簡報要用的警告。
 *
 * 這些不是執政官的行動，是它**看到的事**：
 * 「領主，糧食將於 4 小時後溢出」（`18` §7）。
 */
function collectWarnings(input: StewardInput): StewardWarning[] {
  const out: StewardWarning[] = [];

  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    const rate = input.netPerHour[r];
    if (rate <= 0) continue;
    const hours = (input.capacity - input.resources[r]) / rate;
    if (hours <= OVERFLOW_WARNING_HOURS) {
      out.push({ kind: "OVERFLOW_SOON", resource: r, hours: Math.max(0, hours) });
    }
  }

  if (input.population.amount >= input.population.cap - input.population.used) {
    out.push({ kind: "POPULATION_CAPPED" });
  }
  if (input.ownedCount >= input.territoryCapacity) {
    out.push({ kind: "TERRITORY_CAPPED" });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// 名字與形象
// ─────────────────────────────────────────────────────────────

const NAME_PREFIX = [
  "灰", "斷", "鏽", "冷", "缺", "焦", "白", "鐵", "枯", "暗", "半", "老",
] as const;
const NAME_SUFFIX = [
  "喉", "指", "眼", "牙", "耳", "臂", "骨", "影", "刃", "鴉", "犬", "燈",
] as const;
const NAME_TITLE = [
  "三號書記", "第七抄寫員", "舊城管事", "配給官", "看守", "帳房",
] as const;

/**
 * 由 seed 生成執政官的名字。
 *
 * 確定性：同一個 `playerId` 在同一賽季永遠得到同一個名字，
 * 不需要在生成時就寫進資料庫。
 */
export function stewardName(seed: number): string {
  const rng = mulberry32(deriveSeed(seed, "steward-name"));
  // 六分之一的機率是職稱而不是綽號，讓名單看起來不像同一個模板刷出來的
  if (rng() < 1 / 6) return NAME_TITLE[Math.floor(rng() * NAME_TITLE.length)]!;
  const a = NAME_PREFIX[Math.floor(rng() * NAME_PREFIX.length)]!;
  const b = NAME_SUFFIX[Math.floor(rng() * NAME_SUFFIX.length)]!;
  return a + b;
}

/** 32×32 頭像的組合 seed。實際繪製在美術資源進來之後 */
export function stewardAvatarSeed(seed: number): number {
  return Math.floor(mulberry32(deriveSeed(seed, "steward-avatar"))() * 2 ** 31);
}

/** 全權代理：連續未登入 48 小時（`18` §8） */
export function isFullProxy(lastSeenAt: number | null, now: number): boolean {
  if (lastSeenAt === null) return false;
  return now - lastSeenAt >= STEWARD.fullProxyAfterMs;
}

/** 領主接管：暫停時長要 clamp 在 1–24 小時 */
export function clampPause(hours: number): number {
  const ms = hours * 3_600_000;
  return Math.min(STEWARD.pauseMs.max, Math.max(STEWARD.pauseMs.min, ms));
}
