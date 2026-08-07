/**
 * RuinCity 數值表 —— 所有遊戲數值的單一真相來源。
 *
 * 對應 docs/11-balance-tables.md。任何調整都應該先改文件，再改這裡。
 *
 * ## 兩個必須記住的約定
 *
 * 1. 表中的**時間**是「48 天賽季」的基準值，實際值需除以 `TIME_SCALE`；
 *    表中的**速率**（產出、糧耗）需乘以 `TIME_SCALE`；
 *    表中的**單位速度**需乘以 `MARCH_SCALE`。
 *    成本、人口、戰鬥數值則不套用任何係數。
 *
 * 2. 賽季在封盤期把 `BALANCE_VERSION` 寫入 `seasons.balance_version`，
 *    整場賽季讀取該版本 —— 進行中的賽季永遠不受新版本影響。
 */

export * from "./version";
export * from "./time";
export * from "./world";
export * from "./economy";
export * from "./buildings";
export * from "./units";
export * from "./combat";
export * from "./ruins";
export * from "./alliance";
export * from "./ai";
