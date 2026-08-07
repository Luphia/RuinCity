/**
 * 資源與儲存。
 * 對應 docs/03-economy.md。
 */

export const RESOURCES = ["grain", "timber", "stone", "iron", "relic"] as const;
export type Resource = (typeof RESOURCES)[number];

/** 可被掠奪的資源。遺物永不被掠奪 —— 它代表賽季進度，被搶會把落後方永遠鎖死。 */
export const LOOTABLE: readonly Resource[] = ["grain", "timber", "stone", "iron"];

export const RESOURCE_LABEL: Record<Resource, string> = {
  grain: "糧食",
  timber: "木材",
  stone: "石料",
  iron: "鐵",
  relic: "遺物",
} as const;

export const STORAGE = {
  /** 每種資源的基礎上限 */
  base: 2000,
  /** 溢出的產出直接消失，不扣既有資源，也不做懲罰性溢出 */
  overflowPenalty: 0,
} as const;

export const STARVATION = {
  /** 糧食歸零後，每隔多久餓死一次 */
  intervalMs: 10 * 60 * 1000,
  /** 每次餓死的比例（優先餓死糧耗最高者） */
  ratio: 0.03,
  /** 提前多久紅字警告 */
  warningMs: 6 * 60 * 60 * 1000,
} as const;

/**
 * 資源**不可跨類轉換**是刻意的：
 * 「石頭滿了但木頭見底」是必然會發生的困境，
 * 而交易只能跟同盟成員進行 —— 所以唯二的解法是加入聯盟或去搶。
 * 沒有第三條路。
 */
export const CONVERTIBLE_BETWEEN_TYPES = false;
