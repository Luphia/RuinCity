/**
 * 地圖上的交戰標示。純函式，無 I/O、無 PixiJS。
 *
 * ★ 「這一格現在還在打嗎」**只能有一份實作**。
 *
 *   它有兩個呼叫端：場景（要不要演兩把刀）與 footer（按鈕該說
 *   「交戰中 ⚔」還是「觀戰 🔥」）。兩份實作遲早分岔，
 *   而症狀是畫面自己跟自己打架 —— 地圖還在砍，按鈕已經說打完了。
 *   這與 `maxAffordable`、`current-player.ts` 是同一條規矩。
 */

export interface BattleMarker {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** true = 觀戰窗口內（脈動紅 ✕ 可點觀戰）；false = 近期戰場（暗色殘跡） */
  readonly fresh: boolean;
  /**
   * ★ 伺服器**上一次回答**時這一格正在打（`docs/04` §3d）。
   *   打完的戰場與正在打的戰場長得不一樣是必要的：
   *   前者只是情報，後者是**還來得及參加**的邀請。
   *
   *   注意這是一個快照，不是現在式 —— 判斷「現在」要用 `isBattleLive`。
   */
  readonly live?: boolean;
  /**
   * 這場交戰的結算時刻（毫秒，`engagements.ends_at`）。
   *
   * ★ 動畫的**下架時刻**由它決定，不是由下一次輪詢決定。
   *   交戰只有兩分鐘（`BATTLE.durationMs`）而輪詢是十幾秒一次 ——
   *   等輪詢的話，一場已經打完的仗還會在地圖上砍十幾秒，
   *   而那段時間裡點進去是沒有現場的。
   */
  readonly endsAt?: number;
}

/**
 * 這一格現在還在打嗎。
 *
 * `endsAt` 沒給（舊的回應、或伺服器沒有這個欄位）就只能信 `live` ——
 * 少一個欄位不該讓正在打的仗從地圖上消失。
 */
export function isBattleLive(
  battle: Pick<BattleMarker, "live" | "endsAt">,
  now: number,
): boolean {
  if (!battle.live) return false;
  return battle.endsAt === undefined || now < battle.endsAt;
}
