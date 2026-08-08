/**
 * 「/map 該畫哪一場的地圖」。純函式，無 I/O。
 *
 * ★ 這條規則值得自己一個檔案，因為它錯過一次，而錯的方式很安靜：
 *
 *   舊版取「最新的、還沒封存的那一場」。但**下一場在第 7 天就開放登記**
 *   （`ensureNextSeason`），而登記中的賽季**還沒有地圖** ——
 *   地形是封盤時才生成的。於是每一場賽季走到第 7 天，
 *   所有還在打的人的地圖會同時換成 `s0` 開發地圖：
 *   自己的據點、領土、行軍全部畫在一張無關的地形上；
 *   而 `public/terrain/s0` 沒進映像檔的部署會直接 404 →「地圖載入失敗」。
 *
 *   這不是邊界情況，它會**準時**發生在每一位玩家身上。
 *
 * 正確的判準是「這位觀看者現在在哪一場裡」，退路才是「最新的**有地圖**的一場」。
 */

/** 有地圖的階段。REGISTRATION 沒有地形檔 —— 拿它當預設就是把所有人推進退路 */
export const MAP_READY_STATUSES = ["SEALED", "RUNNING", "ENDING"] as const;

export type MapReadyStatus = (typeof MAP_READY_STATUSES)[number];

export interface SeasonRef {
  readonly id: number;
  readonly status: string;
}

export function hasMap(status: string): status is MapReadyStatus {
  return (MAP_READY_STATUSES as readonly string[]).includes(status);
}

/**
 * @param explicit      ?season= 指定（開發與除錯用），有就照做
 * @param viewerSeason  這位觀看者的 player 所在的那一場（出局的也算 ——
 *                      他要看的仍然是那張圖）。沒登入就是 null
 * @param seasons       候選賽季（未封存的），順序不拘
 * @param fallback      都沒有時的開發地圖 id
 */
export function pickMapSeason(
  explicit: string | null,
  viewerSeason: SeasonRef | null,
  seasons: readonly SeasonRef[],
  fallback: string,
): string {
  if (explicit) return explicit;

  // ★ 自己那一場優先，即使它不是最新的一場
  if (viewerSeason && hasMap(viewerSeason.status)) return `s${viewerSeason.id}`;

  const ready = seasons
    .filter((s) => hasMap(s.status))
    .sort((a, b) => b.id - a.id)[0];
  if (ready) return `s${ready.id}`;

  return fallback;
}
