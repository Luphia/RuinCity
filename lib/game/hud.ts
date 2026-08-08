/**
 * 常駐 HUD 的純邏輯。無 I/O。
 *
 * ★ 「下一件會完成的事」是手機端最重要的一個數字：
 *   玩家每次抬頭看的其實是「我什麼時候要回來」。
 *   它從所有佇列（核心、領土、招募）裡挑**最接近的未來**，
 *   已經過期的不算 —— 過期表示下一次結算就會收掉，不值得倒數。
 */

export interface CompletionItem {
  readonly label: string;
  readonly doneAt: number | null;
}

export interface NextCompletion {
  readonly label: string;
  readonly doneAt: number;
}

export function nearestCompletion(
  items: readonly CompletionItem[],
  now: number,
): NextCompletion | null {
  let best: NextCompletion | null = null;
  for (const it of items) {
    if (it.doneAt === null || it.doneAt <= now) continue;
    if (!best || it.doneAt < best.doneAt) best = { label: it.label, doneAt: it.doneAt };
  }
  return best;
}

/**
 * 客戶端顯示用的資源外推：快照值 + 速率 × 經過時間，封頂在儲存上限。
 * ★ 只供顯示（P1：伺服器是唯一真相）。負速率（冬季糧耗）也一樣外推，
 *   但不外推到零以下 —— 餓死部隊的判定在伺服器的結算裡，不在這裡。
 */
/** 倒數的顯示格式：超過一小時給 h:mm:ss，否則 m:ss */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function extrapolate(
  snapshot: number,
  perHour: number,
  elapsedMs: number,
  capacity: number,
): number {
  const value = snapshot + (perHour * elapsedMs) / 3_600_000;
  return Math.max(0, Math.min(capacity, value));
}
