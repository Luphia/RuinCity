/**
 * 模型投票：**依捐款金額加權**。純函式，無 I/O。
 *
 * 規則（`docs/00-design.md` §4）：
 *
 * - 每位捐款人對**每一塊**有一票，權重 = 他對那一塊的**已入帳**捐款總額（扣手續費前）
 * - 捐款可以不投票。不投票的錢照樣拿來施工，只是不參與決定用哪一家
 * - 每一個施工步驟**開工那一刻**計票，排名第一、而且**做得了這一步**的那一家畫這一步
 *   （GPT Image 只會出圖；「地圖參數」那一步就輪到排名下一家）
 * - 同票時依 `PROVIDER_ORDER`（固定、公開，不是隨機）
 * - 沒有人投票（或投的那幾家目前都停用）時，平台預設排第一
 *
 * ★ 票投給目前停用的那一家（平台沒設它的金鑰）時，那一票**照樣顯示**，
 *   只是不能贏。把它從畫面上拿掉的話，捐款人會以為自己的票不見了。
 */

import { PROVIDER_ORDER, supports, type ProviderId, type StepKind } from "./pricing";

export interface DonorStanding {
  readonly donorId: string;
  /** 這位捐款人對這一塊的已入帳總額（微美元） */
  readonly paidMicros: number;
  readonly vote: ProviderId | null;
}

export interface Tally {
  readonly weights: Readonly<Record<ProviderId, number>>;
  /** 有投票的捐款總額 */
  readonly votedMicros: number;
  /** 全部捐款總額（含沒投票的） */
  readonly totalMicros: number;
  /** 啟用中的各家，依名次排列 */
  readonly ranking: readonly ProviderId[];
  /** 排名第一（畫大多數步驟的那一家）。沒有任何可用的模型時為 null */
  readonly winner: ProviderId | null;
  /** `VOTES` = 票選出來的；`DEFAULT` = 沒有有效的票，用平台預設 */
  readonly decidedBy: "VOTES" | "DEFAULT" | "NONE";
}

export function tallyVotes(
  standings: readonly DonorStanding[],
  enabled: readonly ProviderId[],
  fallback: ProviderId,
): Tally {
  const weights = Object.fromEntries(PROVIDER_ORDER.map((p) => [p, 0])) as Record<ProviderId, number>;
  let votedMicros = 0;
  let totalMicros = 0;
  for (const s of standings) {
    const paid = Math.max(0, s.paidMicros);
    totalMicros += paid;
    if (s.vote) {
      weights[s.vote] += paid;
      votedMicros += paid;
    }
  }

  const live = PROVIDER_ORDER.filter((p) => enabled.includes(p));
  const ranking = [...live].sort(
    (a, b) =>
      weights[b] - weights[a] ||
      // 都沒票的那幾家裡，平台預設排前面
      (weights[a] === 0 ? Number(b === fallback) - Number(a === fallback) : 0) ||
      PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b),
  );
  const winner = ranking[0] ?? null;
  const decidedBy = winner === null ? "NONE" : weights[winner] > 0 ? "VOTES" : "DEFAULT";
  return { weights, votedMicros, totalMicros, ranking, winner, decidedBy };
}

/** 這一步由誰做：排名最前面、而且做得了這一步的那一家 */
export function pickFor(tally: Tally, kind: StepKind): ProviderId | null {
  return tally.ranking.find((p) => supports(p, kind)) ?? null;
}
