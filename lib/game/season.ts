/**
 * 賽季的生命週期與登記。純函式，無 I/O。
 * 對應 docs/13-season-registration.md 與 docs/14-time-and-cadence.md。
 *
 * ## ★ 為什麼是「事先登記 + 全員同時進入」
 *
 * 原設計是外環螺旋：玩家陸續註冊、由外向內填入環帶，用地理位置補償
 * 晚加入者的落後。那本質上是個補丁 —— 它承認「晚進來的人吃虧」
 * 然後試圖補償。
 *
 * 同時開賽直接消滅這個問題，並帶來三個原本拿不到的好處：
 *
 * 1. **開賽前 N 已知** → 出生點分配從貪婪插入變成可驗證的批次最佳化
 * 2. 賽季成為有明確起跑槍的賽事，社群期待與敘事完整
 * 3. **登記表單本身成為第一個做決策的場景**
 *
 * ## ★ 三個選擇，送出後不可更改
 *
 * 陣營（決定你加入哪 5 個聯盟之一）、出生帶（決定你會遇到哪一種戰爭）、
 * 同行小隊（最多 8 人，不是 40 人 —— 一群朋友，不是一支軍隊）。
 */

import { CALENDAR, SPAWN_BAND, SPAWN_BANDS, SQUAD, type SpawnBand } from "./balance";
import { SEASON_DURATION_MS } from "./calendar";
import { zeroAmounts, type Amounts } from "./settle";

export const FACTIONS = [1, 2, 3] as const;
export type FactionId = (typeof FACTIONS)[number];

/** 每場固定 600 人 = 3 陣營 × 5 聯盟 × 40 人（`docs/06` §0） */
export const SEASON_CAPACITY = 600;
export const FACTION_CAPACITY = 200;

// ─────────────────────────────────────────────────────────────
// 生命週期
// ─────────────────────────────────────────────────────────────

export const PHASES = ["REGISTRATION", "SEALED", "RUNNING", "ENDING", "ARCHIVED"] as const;
export type Phase = (typeof PHASES)[number];

/** 各階段的長度（`docs/13` §1） */
export const PHASE_DURATION = {
  /** 登記期 3 天 */
  registrationMs: 3 * 24 * 60 * 60 * 1000,
  /** 封盤期 12 小時 —— 地圖生成、分配、驗證、公布預覽 */
  sealedMs: 12 * 60 * 60 * 1000,
  /** 賽季 12 天 = 12 遊戲月 */
  runningMs: SEASON_DURATION_MS,
  /** 終戰期 12 小時 —— 凍結、結算、歸檔 */
  endingMs: 12 * 60 * 60 * 1000,
  /** 每 7 天開新的一場 */
  cadenceMs: 7 * 24 * 60 * 60 * 1000,
} as const;

export interface SeasonSchedule {
  readonly registrationOpensAt: number;
  readonly registrationClosesAt: number;
  /** T = 0 */
  readonly startsAt: number;
  readonly endsAt: number;
  readonly archivesAt: number;
  /** 下一場的登記開放時間 */
  readonly nextOpensAt: number;
}

/**
 * 從登記開放時間推出整條時間軸。
 *
 * ★ 下一場在**第 11 日**開放登記，不是等這場結束。
 *   玩家的個人循環因此是 14 天而不是 24 天 ——
 *   「不能玩」轉成「準備下一場」（`docs/13` §5）。
 */
export function scheduleFrom(registrationOpensAt: number): SeasonSchedule {
  const registrationClosesAt = registrationOpensAt + PHASE_DURATION.registrationMs;
  const startsAt = registrationClosesAt + PHASE_DURATION.sealedMs;
  const endsAt = startsAt + PHASE_DURATION.runningMs;
  return {
    registrationOpensAt,
    registrationClosesAt,
    startsAt,
    endsAt,
    archivesAt: endsAt + PHASE_DURATION.endingMs,
    nextOpensAt: registrationOpensAt + PHASE_DURATION.cadenceMs,
  };
}

/**
 * 現在是哪一個階段。
 *
 * ★ 階段由**時間戳**推導，不是由一個會被忘記更新的狀態欄位決定。
 *   資料庫裡的 `status` 是那個推導結果的快取 ——
 *   兩者不一致時以時間為準（`syncStatus` 負責把它補回去）。
 */
export function phaseAt(schedule: SeasonSchedule, now: number): Phase {
  if (now < schedule.registrationOpensAt) return "REGISTRATION";
  if (now < schedule.registrationClosesAt) return "REGISTRATION";
  if (now < schedule.startsAt) return "SEALED";
  if (now < schedule.endsAt) return "RUNNING";
  if (now < schedule.archivesAt) return "ENDING";
  return "ARCHIVED";
}

/** 現在還收不收登記 */
export function registrationOpen(schedule: SeasonSchedule, now: number): boolean {
  return now >= schedule.registrationOpensAt && now < schedule.registrationClosesAt;
}

/** 賽季進行到第幾個遊戲月（1–12）。未開賽回 0 */
export function gameMonthOf(schedule: SeasonSchedule, now: number): number {
  if (now < schedule.startsAt) return 0;
  const elapsed = now - schedule.startsAt;
  return Math.min(
    CALENDAR.seasonGameMonths,
    Math.floor(elapsed / CALENDAR.realMsPerGameMonth) + 1,
  );
}

// ─────────────────────────────────────────────────────────────
// 名額
// ─────────────────────────────────────────────────────────────

export interface QuotaKey {
  readonly faction: FactionId;
  readonly band: SpawnBand;
}

export interface QuotaRow extends QuotaKey {
  readonly capacity: number;
  readonly taken: number;
}

/** 開一場賽季要建的 9 列名額（3 陣營 × 3 環帶） */
export function initialQuotas(): readonly (QuotaKey & { capacity: number })[] {
  const out: (QuotaKey & { capacity: number })[] = [];
  for (const faction of FACTIONS) {
    for (const band of SPAWN_BANDS) {
      out.push({ faction, band, capacity: SPAWN_BAND[band].quota });
    }
  }
  return out;
}

/** 這 9 列加起來必須剛好是 600 —— 三層結構精確吻合（`docs/13` §2.1） */
export function totalCapacity(): number {
  return initialQuotas().reduce((s, q) => s + q.capacity, 0);
}

// ─────────────────────────────────────────────────────────────
// 登記
// ─────────────────────────────────────────────────────────────

export type RegistrationRejection =
  | "NOT_OPEN"
  | "UNKNOWN_FACTION"
  | "UNKNOWN_BAND"
  | "QUOTA_FULL"
  | "ALREADY_REGISTERED"
  | "ALREADY_IN_ANOTHER_SEASON"
  | "SQUAD_FULL"
  | "SQUAD_MISMATCH"
  | "BAD_SQUAD_CODE";

export interface RegistrationInput {
  readonly faction: number;
  readonly band: string;
  readonly squadCode?: string | null;
}

export interface RegistrationContext {
  readonly schedule: SeasonSchedule;
  readonly now: number;
  /** 這一格 (陣營, 環帶) 目前的佔用 */
  readonly quota: { readonly capacity: number; readonly taken: number } | null;
  readonly alreadyRegistered: boolean;
  /** 這位玩家是否已經在**另一場**賽季裡（`docs/13` §7 D1） */
  readonly inAnotherSeason: boolean;
  /** 同代碼的既有成員；空陣列 = 這個代碼還沒人用過 */
  readonly squadMembers: readonly { faction: number; band: string }[];
}

export interface RegistrationPlan {
  readonly faction: FactionId;
  readonly band: SpawnBand;
  readonly squadCode: string | null;
}

/** 同行代碼：4–12 個英數字，統一轉大寫 */
export function normaliseSquadCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return null;
  return code;
}

/**
 * 驗證一次登記。
 *
 * ★ 名額檢查在這裡只是**先擋一次給 UI 用**。真正的併發控制是
 *   `season_quotas` 上的 `CHECK (taken <= capacity)` 加一句原子
 *   `UPDATE ... SET taken = taken + 1` —— 兩個人同時搶最後一個名額時，
 *   輸的那個會撞到約束而不是讀到過期的計數（`docs/10` M0 的發現）。
 */
export function planRegistration(
  input: RegistrationInput,
  ctx: RegistrationContext,
): RegistrationPlan | { readonly reason: RegistrationRejection } {
  if (!registrationOpen(ctx.schedule, ctx.now)) return { reason: "NOT_OPEN" };
  if (ctx.alreadyRegistered) return { reason: "ALREADY_REGISTERED" };
  if (ctx.inAnotherSeason) return { reason: "ALREADY_IN_ANOTHER_SEASON" };

  if (!FACTIONS.includes(input.faction as FactionId)) return { reason: "UNKNOWN_FACTION" };
  if (!SPAWN_BANDS.includes(input.band as SpawnBand)) return { reason: "UNKNOWN_BAND" };

  const faction = input.faction as FactionId;
  const band = input.band as SpawnBand;

  if (!ctx.quota || ctx.quota.taken >= ctx.quota.capacity) return { reason: "QUOTA_FULL" };

  let squadCode: string | null = null;
  if (input.squadCode) {
    squadCode = normaliseSquadCode(input.squadCode);
    if (squadCode === null) return { reason: "BAD_SQUAD_CODE" };

    /**
     * ★ 同行小隊上限 8 人，而且必須同陣營同環帶（`docs/13` §2.3）。
     *
     *   8 是「一群朋友」的規模，不是「一支軍隊」的規模 ——
     *   讓整個 40 人聯盟抱團開局，那一區會被單一勢力直接壓死。
     */
    if (ctx.squadMembers.length >= SQUAD.maxMembers) return { reason: "SQUAD_FULL" };
    const mismatch = ctx.squadMembers.some((m) => m.faction !== faction || m.band !== band);
    if (mismatch) return { reason: "SQUAD_MISMATCH" };
  }

  return { faction, band, squadCode };
}

/**
 * 把登記聚合成分配器要的小隊請求。
 *
 * 只有**兩人以上**才算小隊 —— 一個人填了代碼卻沒有同伴，
 * 讓他當散客比讓分配器去處理一個 size = 1 的群集乾淨。
 */
export function squadRequestsFrom(
  registrations: readonly { faction: number; band: string; squadCode: string | null }[],
): readonly { faction: FactionId; band: SpawnBand; size: number }[] {
  const groups = new Map<string, { faction: FactionId; band: SpawnBand; size: number }>();
  for (const r of registrations) {
    if (!r.squadCode) continue;
    const key = `${r.squadCode}:${r.faction}:${r.band}`;
    const existing = groups.get(key);
    if (existing) existing.size++;
    else {
      groups.set(key, {
        faction: r.faction as FactionId,
        band: r.band as SpawnBand,
        size: 1,
      });
    }
  }
  return [...groups.values()].filter((g) => g.size >= 2);
}

// ─────────────────────────────────────────────────────────────
// AI 補足
// ─────────────────────────────────────────────────────────────

export interface FillPlan {
  readonly faction: FactionId;
  readonly band: SpawnBand;
  readonly count: number;
}

/**
 * 封盤期用 AI 把每一格補滿（`docs/13` §2.1）。
 *
 * ★ 所以三個陣營在開賽時**永遠恰好各 200 人**，不存在失衡問題 ——
 *   而這正是「固定名額」這個決策之所以可行的原因。
 *   動態名額那一版要處理「名額 = N/3 但 N 尚未確定」的雞生蛋問題，
 *   AI 補足讓那整套機制變得不必要。
 */
export function planAiFill(quotas: readonly QuotaRow[]): readonly FillPlan[] {
  return quotas
    .map((q) => ({
      faction: q.faction,
      band: q.band,
      count: Math.max(0, q.capacity - q.taken),
    }))
    .filter((f) => f.count > 0);
}

// ─────────────────────────────────────────────────────────────
// 開局狀態
// ─────────────────────────────────────────────────────────────

/** 起始資源（`docs/11` §16：糧木石 500、鐵 200） */
export const BASE_STARTING_RESOURCES: Amounts = {
  grain: 500,
  timber: 500,
  stone: 500,
  iron: 200,
};

/** 起始兵力：民兵 ×10（`docs/11` §10） */
export const STARTING_ARMY = { MILITIA: 10 } as const;

/**
 * 出生帶決定起始資源。
 *
 * ★ 邊陲 ×1.4 是**補償**，不是獎勵：離自家遺跡最遠就等於離敵對陣營最近
 *   （`docs/13` §2.2 的設計修正 —— 上一版把邊陲寫成安全區，那是錯的）。
 */
export function startingResources(band: SpawnBand): Amounts {
  const multiplier = SPAWN_BAND[band].startingResourceMultiplier;
  const out = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    out[r] = Math.round(BASE_STARTING_RESOURCES[r] * multiplier);
  }
  return out;
}

/** 前線的 +1 領土容量 */
export function bonusTerritoryCapacity(band: SpawnBand): number {
  return SPAWN_BAND[band].bonusTerritoryCapacity;
}

/**
 * 起始人口佔用。
 *
 * 民兵 ×10 各佔 1 人口，而且**陣亡不返還** ——
 * 所以這 10 點從第一秒就記在 `population.used` 上。
 */
export function startingPopulationUsed(): number {
  return STARTING_ARMY.MILITIA;
}

export { SPAWN_BAND, SPAWN_BANDS, SQUAD };
export type { SpawnBand };
