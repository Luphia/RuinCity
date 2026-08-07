/**
 * 數值表版本。
 *
 * 賽季在封盤期把當時的版本寫入 `seasons.balance_version`，
 * 整場賽季讀取該版本 —— **進行中的賽季永遠不受新版本影響**。
 * 見 docs/12-open-questions.md B16。
 *
 * 兩場賽季同時運行且每 7 天開一場，所以數值可以每週上線一次；
 * 這個常數就是隔離牆。任何影響 PvP 平衡的改動都必須 bump 這個版本。
 */
export const BALANCE_VERSION = "2026.08.07-a" as const;

export type BalanceVersion = typeof BALANCE_VERSION;
