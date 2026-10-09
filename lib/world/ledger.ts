/**
 * 捐款帳與施工狀態。純函式，無 I/O。
 *
 * 金額一律是**微美元**整數（1 USD = 1,000,000）。捐款人付新台幣，
 * 入帳時依**當下的匯率快照**換算，匯率跟著那一筆捐款存下來 ——
 * 之後匯率變了，過去的帳不會跟著變。
 *
 * ## 一筆捐款進來之後
 *
 *   總額（gross）
 *   − 金流手續費（費率 + 每筆固定費，以金流商回報的實際值為準）
 *   − 稅金與規費（營業稅等，依 `BudgetConfig.taxRate`）
 *   − 退款與拒付準備
 *   = 淨額（net）—— 只有這部分能拿來施工與保存
 *
 * 一塊地圖的淨額再先**圈出**兩筆小額準備（四年保存、伺服器分攤，見 `budget.ts`），
 * 剩下的才是施工餘額。
 */

import type { BudgetConfig } from "./budget";

export const MICROS_PER_USD = 1_000_000;

/**
 * 施工餘額要是下一步估價的幾倍才開工。
 *
 * ★ 估計只是估計：模型這一次可能想得比較久、畫得比較大，也可能失敗要重來。
 *   留 25% 的緩衝，實際花費超過估價時餘額才不會變成負的 ——
 *   「捐款不夠還硬蓋」等於拿別塊地圖的錢來墊。
 *   萬一還是超支，餘額會短暫為負，施工停在那裡等下一筆捐款，不會有任何一步被跳過。
 */
export const START_MARGIN = 1.25;

export function canStartStep(balanceMicros: number, nextStepMicros: number): boolean {
  return balanceMicros >= Math.ceil(nextStepMicros * START_MARGIN);
}

export function toMicros(amount: number, unitsPerUsd: number): number {
  return Math.round((amount / unitsPerUsd) * MICROS_PER_USD);
}

export function fromMicros(micros: number, unitsPerUsd: number): number {
  return (micros / MICROS_PER_USD) * unitsPerUsd;
}

/** 新台幣顯示：小於 10 元保留兩位小數，否則取整 */
export function formatTwd(micros: number, twdPerUsd: number): string {
  if (micros === 0) return "NT$0";
  const v = fromMicros(micros, twdPerUsd);
  const digits = Math.abs(v) < 10 ? 2 : 0;
  return `NT$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatUsd(micros: number): string {
  if (micros === 0) return "US$0";
  const v = micros / MICROS_PER_USD;
  const digits = Math.abs(v) < 1 ? 4 : 2;
  return `US$${v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatTokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export interface DonationSplit {
  readonly grossMicros: number;
  readonly feeMicros: number;
  readonly taxMicros: number;
  readonly chargebackMicros: number;
  readonly netMicros: number;
}

/**
 * 一筆捐款拆帳。
 *
 * `actualFeeTwd` 是金流商回報的實際手續費（有的話）；沒有就用設定的費率估。
 * ★ 稅與準備金依**總額**計，不是依淨額 —— 營業稅的稅基是收到的錢。
 */
export function splitDonation(
  grossTwd: number,
  twdPerUsd: number,
  config: Pick<BudgetConfig, "paymentFeeRate" | "paymentFeeFixedTwd" | "taxRate" | "chargebackRate">,
  actualFeeTwd?: number,
): DonationSplit {
  const feeTwd = actualFeeTwd ?? grossTwd * config.paymentFeeRate + config.paymentFeeFixedTwd;
  const grossMicros = toMicros(grossTwd, twdPerUsd);
  const feeMicros = Math.min(grossMicros, toMicros(feeTwd, twdPerUsd));
  const taxMicros = Math.round(grossMicros * config.taxRate);
  const chargebackMicros = Math.round(grossMicros * config.chargebackRate);
  return {
    grossMicros,
    feeMicros,
    taxMicros,
    chargebackMicros,
    netMicros: grossMicros - feeMicros - taxMicros - chargebackMicros,
  };
}

/** 平台撥款在 `donations.processor` 的值；捐款人欄位記成 `GRANT_DONOR` */
export const GRANT_PROCESSOR = "grant";
export const GRANT_DONOR = "platform";

/**
 * 平台撥款（管理員指令 `pnpm block:paint`）：不經金流商，所以沒有手續費、稅與拒付準備，
 * 淨額 = 總額。它照樣是帳上的一筆收入 —— 狀態仍然只由帳推導。
 */
export function grantSplit(amountTwd: number, twdPerUsd: number): DonationSplit {
  const grossMicros = toMicros(amountTwd, twdPerUsd);
  return { grossMicros, feeMicros: 0, taxMicros: 0, chargebackMicros: 0, netMicros: grossMicros };
}

/**
 * 要撥多少才能把這一塊蓋完：補足淨額缺口；缺口是 0 但下一步還開不了工（估價低估、
 * 實際用量比較高）時，補到剛好能開下一步（含 `START_MARGIN`）。
 */
export function grantNeededMicros(input: {
  readonly netGapMicros: number;
  readonly constructionBalanceMicros: number;
  readonly nextStepMicros: number | null;
}): number {
  const toStart = input.nextStepMicros === null ? 0 : Math.ceil(input.nextStepMicros * START_MARGIN) - input.constructionBalanceMicros;
  return Math.max(0, input.netGapMicros, toStart);
}

/** 微美元 → 撥款的新台幣整數（無條件進位：寧可多一元，不要差一點開不了工） */
export function microsToTwdCeil(micros: number, twdPerUsd: number): number {
  return Math.ceil(fromMicros(micros, twdPerUsd) - 1e-9);
}

export type BlockStatus = "UNFUNDED" | "FUNDING" | "BUILDING" | "PAUSED" | "COMPLETE";

export const STATUS_LABEL: Record<BlockStatus, string> = {
  UNFUNDED: "尚無捐款",
  FUNDING: "募款中",
  BUILDING: "建設中",
  PAUSED: "施工暫停",
  COMPLETE: "已完成",
};

/**
 * 這一塊現在是什麼狀態。
 *
 * ★ 由帳推導，不另存一個 status 欄位：狀態欄位會和帳分岔
 *   （捐款入帳了狀態卻沒更新、或反過來），而帳本身才是真相。
 *   `completedAt` 是唯一存下來的狀態 —— 因為「完成」是一個事件，不是一個餘額。
 */
export function blockStatus(input: {
  readonly grossReceivedMicros: number;
  readonly constructionBalanceMicros: number;
  readonly completedAt: Date | null;
  /** 下一步的估價（token + 參考影像費）；沒有下一步為 null */
  readonly nextStepMicros: number | null;
  /** 有一個步驟正在跑 */
  readonly running: boolean;
  /** 連續失敗太多次而暫停 */
  readonly paused?: boolean;
}): BlockStatus {
  if (input.completedAt) return "COMPLETE";
  if (input.grossReceivedMicros <= 0) return "UNFUNDED";
  if (input.running) return "BUILDING";
  // ★ 暫停要講出來：顯示成「募款中」的話，捐款人會以為再捐一點就會動
  if (input.paused) return "PAUSED";
  if (input.nextStepMicros === null) return "BUILDING";
  return canStartStep(input.constructionBalanceMicros, input.nextStepMicros) ? "BUILDING" : "FUNDING";
}
