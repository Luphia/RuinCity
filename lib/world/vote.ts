/**
 * 模型投票：**依捐款金額加權**。純函式，無 I/O。
 *
 * 規則（`docs/00-design.md` §4）：
 *
 * - 每位捐款人對**每一塊**有一票，權重 = 他對那一塊的**已入帳**捐款總額（扣手續費前）
 * - 捐款可以不投票。不投票的錢照樣拿來施工，只是不參與決定用哪一家
 * - 每一個出圖步驟**開工那一刻**計票，排名第一的那一家畫這一步
 * - 同票時依 `PAINTERS` 的順序（固定、公開，不是隨機）
 * - 沒有人投票（或投的那幾家目前都停用）時，平台預設排第一
 *
 * ★ 只有**擬真影像模型**能被投（`PAINTERS`）。畫面必須擬真，
 *   畫不出照片的模型就算票數最高也不該拿到畫筆。
 *   「地圖參數」那一步只產出 JSON、不出圖，由**勘查員**（`SURVEYORS` 裡第一個啟用的）
 *   負責，不參與投票 —— 它的產出不會出現在畫面上，只決定一百張圖要對齊的設定。
 *
 * ★ 票投給目前停用的那一家（平台沒設它的金鑰）時，那一票**照樣顯示**，
 *   只是不能贏。把它從畫面上拿掉的話，捐款人會以為自己的票不見了。
 */

import { PAINTERS, SURVEYORS, type PainterId, type ProviderId, type StepKind } from "./pricing";

export interface DonorStanding {
  readonly donorId: string;
  /** 這位捐款人對這一塊的已入帳總額（微美元） */
  readonly paidMicros: number;
  readonly vote: PainterId | null;
}

export interface Tally {
  readonly weights: Readonly<Record<PainterId, number>>;
  /** 有投票的捐款總額 */
  readonly votedMicros: number;
  /** 全部捐款總額（含沒投票的） */
  readonly totalMicros: number;
  /** 啟用中的繪製模型，依名次排列 */
  readonly ranking: readonly PainterId[];
  /** 排名第一（畫所有出圖步驟的那一家）。沒有任何可用的模型時為 null */
  readonly winner: PainterId | null;
  /** `VOTES` = 票選出來的；`DEFAULT` = 沒有有效的票，用平台預設 */
  readonly decidedBy: "VOTES" | "DEFAULT" | "NONE";
  /** 寫地圖參數的那一家（不投票）。沒有可用的就是 null —— 用預設參數，不花錢 */
  readonly surveyor: ProviderId | null;
}

export function tallyVotes(
  standings: readonly DonorStanding[],
  enabled: readonly ProviderId[],
  fallback: PainterId,
): Tally {
  const weights = Object.fromEntries(PAINTERS.map((p) => [p, 0])) as Record<PainterId, number>;
  let votedMicros = 0;
  let totalMicros = 0;
  for (const s of standings) {
    const paid = Math.max(0, s.paidMicros);
    totalMicros += paid;
    if (s.vote && s.vote in weights) {
      weights[s.vote] += paid;
      votedMicros += paid;
    }
  }

  const live = PAINTERS.filter((p) => enabled.includes(p));
  const ranking = [...live].sort(
    (a, b) =>
      weights[b] - weights[a] ||
      // 都沒票的那幾家裡，平台預設排前面
      (weights[a] === 0 ? Number(b === fallback) - Number(a === fallback) : 0) ||
      PAINTERS.indexOf(a) - PAINTERS.indexOf(b),
  );
  const winner = ranking[0] ?? null;
  const decidedBy = winner === null ? "NONE" : weights[winner] > 0 ? "VOTES" : "DEFAULT";
  const surveyor = SURVEYORS.find((p) => enabled.includes(p)) ?? null;
  return { weights, votedMicros, totalMicros, ranking, winner, decidedBy, surveyor };
}

/** 這一步由誰做：地圖參數歸勘查員，其餘歸票選第一 */
export function pickFor(tally: Tally, kind: StepKind): ProviderId | null {
  if (kind === "PARAMS") return tally.surveyor;
  return tally.winner;
}
