/**
 * 遊戲曆法與四季。純函式，無 I/O。
 *
 * 1 真實日 = 1 遊戲月 = 30 遊戲日。賽季 12 真實日 = 12 遊戲月 = 1 遊戲年。
 *
 * 介面上一律顯示「廢曆 41 年 · 3 月 12 日」而不是「賽季第 2 天 14 小時」——
 * 「我們在七月丟了尖塔」比「我們在第 6.5 天丟了尖塔」有重量得多。
 *
 * 見 docs/14-time-and-cadence.md。
 */

import {
  CALENDAR,
  SEASON_MODIFIERS,
  SEASONS,
  type Season,
  type SeasonModifiers,
} from "./balance/time";

export interface GameDate {
  /** 廢曆年份 */
  readonly year: number;
  /** 遊戲月 1–12 */
  readonly month: number;
  /** 遊戲日 1–30 */
  readonly day: number;
  /** 賽季開始至今的遊戲月小數值，0 ≤ elapsed < 12 */
  readonly elapsedMonths: number;
  readonly season: Season;
}

/** 賽季總長度（毫秒） */
export const SEASON_DURATION_MS =
  CALENDAR.seasonGameMonths * CALENDAR.realMsPerGameMonth;

/**
 * 把真實時間換算為遊戲曆。
 *
 * @param startedAt 賽季 T=0 的真實時間戳（毫秒）
 * @param now       當前真實時間戳（毫秒）
 */
export function toGameDate(startedAt: number, now: number): GameDate {
  const elapsedMs = Math.max(0, now - startedAt);
  const elapsedMonths = elapsedMs / CALENDAR.realMsPerGameMonth;

  // 全程用整數毫秒運算。用小數月份再乘回天數會在剛好落於
  // 遊戲日邊界時被浮點誤差咬掉一天（例如 2 日 + 48 分會算成 3 月 1 日）。
  const monthIndex = Math.min(
    CALENDAR.seasonGameMonths - 1,
    Math.floor(elapsedMs / CALENDAR.realMsPerGameMonth),
  ); // 0-based；第 12 月結束後仍停在第 12 月（終戰期）
  const msIntoMonth = elapsedMs - monthIndex * CALENDAR.realMsPerGameMonth;
  const day = Math.min(
    CALENDAR.gameDaysPerMonth,
    Math.floor(msIntoMonth / CALENDAR.realMsPerGameDay) + 1,
  );

  return {
    year: CALENDAR.epochYear,
    month: monthIndex + 1,
    day,
    elapsedMonths,
    season: seasonOfMonth(monthIndex + 1),
  };
}

/** 遊戲月 → 季節。月份會被 clamp 到 1–12。 */
export function seasonOfMonth(month: number): Season {
  const m = Math.min(CALENDAR.gameMonthsPerYear, Math.max(1, Math.floor(month)));
  for (const season of SEASONS) {
    const [from, to] = SEASON_MODIFIERS[season].months;
    if (m >= from && m <= to) return season;
  }
  // 不可能到達：SEASON_MODIFIERS 覆蓋 1–12
  return "WINTER";
}

/** 取得某個真實時間點的季節係數 */
export function seasonModifiersAt(startedAt: number, now: number): SeasonModifiers {
  return SEASON_MODIFIERS[toGameDate(startedAt, now).season];
}

/** 格式化為「廢曆 41 年 · 3 月 12 日」 */
export function formatGameDate(date: GameDate): string {
  return `廢曆 ${date.year} 年 · ${date.month} 月 ${date.day} 日`;
}

/** 格式化為帶季節的完整形式：「廢曆 41 年 · 3 月 12 日（春 · 荒芽）」 */
export function formatGameDateWithSeason(date: GameDate): string {
  const seasonLabel = SEASON_LABEL[date.season];
  return `${formatGameDate(date)}（${seasonLabel}）`;
}

export const SEASON_LABEL: Record<Season, string> = {
  SPRING: "春 · 荒芽",
  SUMMER: "夏 · 焦土",
  AUTUMN: "秋 · 豐鏽",
  WINTER: "冬 · 長夜",
} as const;

/**
 * 某個遊戲月開始時的真實時間戳。
 * `month` 為 1-based；`month = 13` 回傳賽季結束時間。
 */
export function realTimeOfGameMonth(startedAt: number, month: number): number {
  return startedAt + (month - 1) * CALENDAR.realMsPerGameMonth;
}

/** 下一次季節切換的真實時間戳。已在最後一季則回傳賽季結束時間。 */
export function nextSeasonChangeAt(startedAt: number, now: number): number {
  const { season } = toGameDate(startedAt, now);
  const [, lastMonth] = SEASON_MODIFIERS[season].months;
  return realTimeOfGameMonth(startedAt, lastMonth + 1);
}

/** 賽季是否已走完 12 個遊戲月 */
export function isSeasonExpired(startedAt: number, now: number): boolean {
  return now - startedAt >= SEASON_DURATION_MS;
}
