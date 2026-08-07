/**
 * 惰性結算引擎。純函式，無 I/O。
 * 對應 docs/03-economy.md §2.2 與 docs/07-tech-architecture.md。
 *
 * ## 核心不變式
 *
 *     世界狀態 = f(上一個狀態, 排定的事件, 時間)
 *
 * 資源不用定時器每秒寫資料庫，而是以「**快照 + 速率**」儲存，
 * 讀取時才把中間經過的時間補算回來。一位玩家平均每天寫入 < 30 次。
 *
 * ## ★ 為什麼不能只做一次 `amount + rate × 總時間`
 *
 * 因為**速率會在中途改變**，而且有兩種來源：
 *
 * 1. **事件**：蓋好一座農田，產出速率就跳一階
 * 2. **季節**：冬季產出 ×0.70、糧耗 ×1.55（`docs/14` §3）
 *
 * 玩家關掉分頁三天再回來，中間可能跨過好幾個事件與一次換季。
 * 所以結算必須**分段積分**：在每一個速率改變的時間點切開，各段各算。
 *
 * 少了這一點，一個在秋天離線、冬天回來的玩家會拿到整段都用秋季係數
 * 算出來的資源 —— 而且他離線越久賺越多。這是這類遊戲最經典的漏洞。
 */

import { RESOURCES, STORAGE, type Resource, type Season } from "./balance";
import { SEASON_DURATION_MS, realTimeOfGameMonth, seasonOfMonth } from "./calendar";

export type SettleResource = Exclude<Resource, "relic">;
export const SETTLE_RESOURCES: readonly SettleResource[] = RESOURCES.filter(
  (r): r is SettleResource => r !== "relic",
);

export type Amounts = Record<SettleResource, number>;

export interface PopulationState {
  amount: number;
  /** 每真實小時的成長 */
  rate: number;
  cap: number;
  /** 已被部隊佔用（含行軍中）。陣亡不返還，所以這個值只由招募與陣亡改變 */
  used: number;
}

export interface PlayerEconomy {
  readonly resources: Amounts;
  /** 每真實小時的**基準**產出（尚未套用季節係數） */
  readonly baseRates: Amounts;
  /** 每真實小時的**基準**消耗（養兵等，正數代表支出） */
  readonly baseUpkeep: Amounts;
  readonly capacity: number;
  readonly population: PopulationState;
  /** 上次結算的時間戳（ms） */
  readonly settledAt: number;
}

/** 結算過程中會改變速率或狀態的事件 */
export interface ScheduledEvent {
  readonly id: number;
  readonly type: string;
  readonly resolveAt: number;
  readonly seq: number;
  readonly payload?: unknown;
}

export interface SettleContext {
  /** 賽季開始時間，用來換算季節 */
  readonly seasonStartedAt: number;
  /**
   * 套用一個事件。回傳新的經濟狀態 ——
   * 蓋好農田會提高 `baseRates`、佔到領土會提高人口成長率。
   *
   * 保持成純函式，賽季模擬才能重放同一串事件。
   */
  readonly apply: (economy: PlayerEconomy, event: ScheduledEvent) => PlayerEconomy;
  /** 季節係數查詢（注入以便測試） */
  readonly modifiersOf: (season: Season) => { production: number; upkeep: number };
}

export interface SettleResult {
  readonly economy: PlayerEconomy;
  /** 這次結算處理掉的事件，依 (resolveAt, seq, id) 排序 */
  readonly resolved: readonly ScheduledEvent[];
  /** 因為滿倉而蒸發的量。UI 用它顯示「你浪費了多少」 */
  readonly overflow: Amounts;
  /**
   * 整段結算裡「糧食見底且收支為負」的總時長（毫秒）。
   *
   * 呼叫端拿它去餓死部隊（`army.ts` 的 `starve`）——
   * 這一層不認識兵種，也不該認識。
   */
  readonly starvingMs: number;
  /** 實際跨過幾段（事件 + 換季）。測試與除錯用 */
  readonly segments: number;
}

export function zeroAmounts(): Amounts {
  return { grain: 0, timber: 0, stone: 0, iron: 0 };
}

/**
 * 賽季裡所有的換季時刻（絕對毫秒）。
 *
 * 12 個遊戲月分成四季，所以只有三個換季點（月 4、7、10）。
 */
export function seasonBoundaries(seasonStartedAt: number): number[] {
  const out: number[] = [];
  for (let month = 2; month <= 12; month++) {
    if (seasonOfMonth(month) !== seasonOfMonth(month - 1)) {
      out.push(realTimeOfGameMonth(seasonStartedAt, month));
    }
  }
  return out;
}

/** 某個時刻屬於哪一季 */
export function seasonAt(seasonStartedAt: number, at: number): Season {
  const elapsed = Math.max(0, Math.min(SEASON_DURATION_MS - 1, at - seasonStartedAt));
  const month = Math.min(12, Math.floor(elapsed / (SEASON_DURATION_MS / 12)) + 1);
  return seasonOfMonth(month);
}

/**
 * 在一段**速率固定**的區間內累積資源。
 *
 * 溢出直接消失，不扣既有資源，也不做懲罰性溢出（`docs/03` §2.3）。
 */
function accrueSegment(
  economy: PlayerEconomy,
  fromMs: number,
  toMs: number,
  season: { production: number; upkeep: number },
): {
  resources: Amounts;
  overflow: Amounts;
  population: PopulationState;
  /** 這一段裡「糧食見底且收支為負」持續了多久（毫秒） */
  starvingMs: number;
} {
  const hours = Math.max(0, toMs - fromMs) / 3_600_000;
  const resources = { ...economy.resources };
  const overflow = zeroAmounts();
  let starvingMs = 0;

  for (const r of SETTLE_RESOURCES) {
    const rate = economy.baseRates[r] * season.production - economy.baseUpkeep[r] * season.upkeep;
    const next = resources[r] + rate * hours;

    /**
     * ★ 糧食見底之後**還剩多少時間在挨餓**。
     *
     * 這一層只算「餓了多久」，不算「死了誰」——
     * 餓死哪些兵是 `army.ts` 的事，而 `settle.ts` 不認識兵種。
     * 這是同一條界線的延續：這裡只做速率 × 時間的積分。
     */
    if (r === "grain" && rate < 0 && next < 0) {
      const hoursUntilEmpty = resources[r] / -rate;
      starvingMs += Math.max(0, hours - hoursUntilEmpty) * 3_600_000;
    }

    if (next > economy.capacity) {
      overflow[r] = next - economy.capacity;
      resources[r] = economy.capacity;
    } else {
      // 負的收支會把資源吃到 0 為止，但不會變成負數 ——
      // 真正的懲罰是餓死部隊（M3），不是負資源
      resources[r] = Math.max(0, next);
    }
  }

  // 人口：同樣的快照 + 速率模型，但上限扣掉已被部隊佔用的部分
  const headroom = Math.max(0, economy.population.cap - economy.population.used);
  const population: PopulationState = {
    ...economy.population,
    amount: Math.min(headroom, economy.population.amount + economy.population.rate * hours),
  };

  return { resources, overflow, population, starvingMs };
}

/**
 * 把一位玩家結算到 `now`。
 *
 * 事件與換季點合併成一條時間軸，逐段積分。**冪等**：
 * 對同一個輸入結算兩次會得到同一個結果（第二次沒有事件、經過時間為 0）。
 */
export function settlePlayer(
  economy: PlayerEconomy,
  pending: readonly ScheduledEvent[],
  now: number,
  ctx: SettleContext,
): SettleResult {
  const from = economy.settledAt;
  if (now <= from) {
    return { economy, resolved: [], overflow: zeroAmounts(), segments: 0, starvingMs: 0 };
  }

  // ── 建立時間軸：事件 + 換季點 ──────────────────────────────
  const events = pending
    .filter((e) => e.resolveAt > from && e.resolveAt <= now)
    .slice()
    .sort((a, b) => a.resolveAt - b.resolveAt || a.seq - b.seq || a.id - b.id);

  const boundaries = seasonBoundaries(ctx.seasonStartedAt).filter((t) => t > from && t <= now);

  const stops = [...new Set([...events.map((e) => e.resolveAt), ...boundaries])].sort(
    (a, b) => a - b,
  );

  let current = economy;
  let cursor = from;
  const overflow = zeroAmounts();
  const resolved: ScheduledEvent[] = [];
  let segments = 0;
  let starvingMs = 0;

  const advanceTo = (to: number) => {
    if (to <= cursor) return;
    // 用區段的**起點**決定季節係數 —— 因為換季點本身就是一個 stop，
    // 所以每一段內部的季節必然是固定的
    const season = ctx.modifiersOf(seasonAt(ctx.seasonStartedAt, cursor));
    const step = accrueSegment(current, cursor, to, season);
    for (const r of SETTLE_RESOURCES) overflow[r] += step.overflow[r];
    starvingMs += step.starvingMs;
    current = { ...current, resources: step.resources, population: step.population };
    cursor = to;
    segments++;
  };

  for (const stop of stops) {
    advanceTo(stop);
    // 同一個時間點上的事件依 (seq, id) 依序套用
    for (const event of events.filter((e) => e.resolveAt === stop)) {
      current = ctx.apply(current, event);
      resolved.push(event);
    }
  }

  advanceTo(now);

  return {
    economy: { ...current, settledAt: now },
    resolved,
    overflow,
    segments,
    starvingMs,
  };
}

/**
 * 儲存上限。docs/03 §2.3。
 *
 * 這裡重新實作而不是用 `formulas.ts` 的版本，是因為結算路徑拿到的是
 * 已經算好的 `capacity` 快照 —— 這個函式只在**重算速率**時用。
 */
export function computeCapacity(
  citadelLevel: number,
  depotLevel: number,
  outpostLevels: number,
  capacityPerCitadelLevel: number,
  depotBonusPerLevel: number,
  outpostStoragePerLevel: number,
): number {
  const base = STORAGE.base + capacityPerCitadelLevel * citadelLevel;
  return Math.round(
    base * (1 + depotBonusPerLevel * depotLevel) + outpostStoragePerLevel * outpostLevels,
  );
}

/**
 * 距離某項資源溢出還有多久（小時）。UI 顯示「還有 X 小時將溢出」用 ——
 * `docs/03` §2.3 說要讓玩家能主動規劃，而不是被焦慮驅動。
 *
 * 回傳 `Infinity` 代表不會溢出（速率為零或負）。
 */
export function hoursUntilOverflow(
  economy: PlayerEconomy,
  season: { production: number; upkeep: number },
): Amounts {
  const out = zeroAmounts();
  for (const r of SETTLE_RESOURCES) {
    const rate = economy.baseRates[r] * season.production - economy.baseUpkeep[r] * season.upkeep;
    out[r] = rate > 0 ? Math.max(0, (economy.capacity - economy.resources[r]) / rate) : Infinity;
  }
  return out;
}

/** 可支配人口 = 累積量（上限已在結算時扣過 used） */
export function availablePopulation(p: PopulationState): number {
  return Math.max(0, Math.min(p.amount, p.cap - p.used));
}
