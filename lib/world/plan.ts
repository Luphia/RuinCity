/**
 * 一塊地圖的施工計畫與 token 估計。純函式，無 I/O。
 *
 * ## 施工順序
 *
 *   1. SURVEY      勘查：在塊內 10×10 個點問 Street View，選出最多 100 個標記座標（免費）
 *   2. PARAMS      地圖參數：看版型與幾張代表性街景，寫出整塊的設定（JSON）——
 *                  地貌、水位、植被密度、材質清單、每個標記座標的一句說明
 *   3. SCENE × k   標記座標的場景圖（k ≤ 100）
 *   4. TILE        正射地圖底圖（俯視、北朝上、剛好一塊）
 *   5. DSM         3D 圖資：數值地表高度圖（灰階，越亮越高，含樹冠與殘骸）
 *   6. TEXTURE × 8 材質貼圖：參數裡列出的八種材質，各一張可平鋪的貼圖
 *
 * ★ 參數排在最前面，因為後面每一步都讀它：一百張場景圖由不同模型畫，
 *   靠的是同一份「這裡的水淹到哪、植被多密、牆是什麼做的」才會像同一個地方。
 *
 * ★ 每一步開工時才決定用哪一家（`vote.ts`）。估計也只能用「現在的排名」來算剩下的步驟。
 *
 * ★ 勘查之前不知道有幾個標記座標，先以 `DEFAULT_SCENES` 估；勘查完改成實際的 k
 *   （沒有街景的山區、海面會是 0 —— 那一塊只有底圖、3D 與材質）。
 */

import {
  MODEL_PROFILES,
  ZERO_USAGE,
  referenceFeeMicros,
  totalTokens,
  usageCostMicros,
  type PaidStepKind,
  type ProviderId,
  type StepKind,
  type TokenUsage,
} from "./pricing";

export const MAX_SCENES = 100;
/** 勘查前的假設 —— 寧可估多，捐款人才不會在最後一步卡住 */
export const DEFAULT_SCENES = MAX_SCENES;
export const TEXTURES_PER_BLOCK = 8;

export interface PlannedStep {
  readonly kind: StepKind;
  /** 同一種步驟的第幾個（SCENE 0..k-1、TEXTURE 0..7；其餘恆為 0） */
  readonly index: number;
}

/** `viewpoints` 為 null = 還沒勘查 */
export function planSteps(viewpoints: number | null): PlannedStep[] {
  const k = Math.max(0, Math.min(MAX_SCENES, viewpoints ?? DEFAULT_SCENES));
  return [
    { kind: "SURVEY", index: 0 },
    { kind: "PARAMS", index: 0 },
    ...Array.from({ length: k }, (_, i) => ({ kind: "SCENE" as const, index: i })),
    { kind: "TILE", index: 0 },
    { kind: "DSM", index: 0 },
    ...Array.from({ length: TEXTURES_PER_BLOCK }, (_, i) => ({ kind: "TEXTURE" as const, index: i })),
  ];
}

/** 過去實際用量的平均（每個模型、每種步驟）。樣本太少就不要給 —— 見 `MIN_OBSERVED` */
export type Observed = Partial<Record<ProviderId, Partial<Record<PaidStepKind, TokenUsage>>>>;

/** 至少這麼多筆實際紀錄，才用它取代表上的先驗 */
export const MIN_OBSERVED = 3;

export interface StepEstimate {
  readonly provider: ProviderId | null;
  readonly usage: TokenUsage;
  readonly tokens: number;
  /** 只含 token 的成本 */
  readonly tokenMicros: number;
  /** 參考影像費 */
  readonly referenceMicros: number;
}

export function estimateStep(
  kind: StepKind,
  provider: ProviderId | null,
  observed?: Observed,
): StepEstimate {
  if (kind === "SURVEY" || provider === null) {
    return { provider, usage: ZERO_USAGE, tokens: 0, tokenMicros: 0, referenceMicros: 0 };
  }
  const profile = MODEL_PROFILES[provider];
  const usage = observed?.[provider]?.[kind] ?? profile.typical[kind];
  if (!usage) throw new Error(`${provider} 不支援 ${kind}`);
  return {
    provider,
    usage,
    tokens: totalTokens(usage),
    tokenMicros: usageCostMicros(profile.rates, usage),
    referenceMicros: referenceFeeMicros(kind),
  };
}

/** 每一種步驟由誰來做（由 `vote.ts` 的排名決定） */
export type Picker = (kind: StepKind) => ProviderId | null;

export interface KindTotals {
  readonly count: number;
  readonly tokens: number;
  readonly tokenMicros: number;
  readonly referenceMicros: number;
}

const EMPTY: KindTotals = { count: 0, tokens: 0, tokenMicros: 0, referenceMicros: 0 };

export function emptyKindTotals(): Record<PaidStepKind, KindTotals> {
  return { PARAMS: EMPTY, SCENE: EMPTY, TILE: EMPTY, DSM: EMPTY, TEXTURE: EMPTY };
}

export function addKind(a: KindTotals, b: Omit<KindTotals, "count"> & { count?: number }): KindTotals {
  return {
    count: a.count + (b.count ?? 1),
    tokens: a.tokens + b.tokens,
    tokenMicros: a.tokenMicros + b.tokenMicros,
    referenceMicros: a.referenceMicros + b.referenceMicros,
  };
}

export interface RemainingEstimate {
  /** 下一步；全部完成時為 null */
  readonly next: (StepEstimate & { readonly step: PlannedStep }) | null;
  readonly byKind: Record<PaidStepKind, KindTotals>;
  readonly tokens: number;
  readonly tokenMicros: number;
  readonly referenceMicros: number;
}

/** 剩下的步驟（`done` 個已完成）照目前的排名做完，還要多少 */
export function estimateRemaining(
  steps: readonly PlannedStep[],
  done: number,
  pick: Picker,
  observed?: Observed,
): RemainingEstimate {
  const byKind = emptyKindTotals();
  let next: RemainingEstimate["next"] = null;
  let tokens = 0;
  let tokenMicros = 0;
  let referenceMicros = 0;
  for (const step of steps.slice(done)) {
    const e = estimateStep(step.kind, pick(step.kind), observed);
    if (!next) next = { ...e, step };
    if (step.kind === "SURVEY") continue;
    byKind[step.kind] = addKind(byKind[step.kind], e);
    tokens += e.tokens;
    tokenMicros += e.tokenMicros;
    referenceMicros += e.referenceMicros;
  }
  return { next, byKind, tokens, tokenMicros, referenceMicros };
}

/**
 * 把一批實際用量平均成 `Observed`。樣本不足 `MIN_OBSERVED` 的組合不輸出。
 */
export function averageObserved(
  rows: readonly { provider: ProviderId; kind: StepKind; usage: TokenUsage }[],
): Observed {
  const sums = new Map<string, { n: number; u: TokenUsage }>();
  for (const r of rows) {
    if (r.kind === "SURVEY") continue;
    const key = `${r.provider}:${r.kind}`;
    const cur = sums.get(key) ?? { n: 0, u: ZERO_USAGE };
    sums.set(key, {
      n: cur.n + 1,
      u: {
        textIn: cur.u.textIn + r.usage.textIn,
        imageIn: cur.u.imageIn + r.usage.imageIn,
        textOut: cur.u.textOut + r.usage.textOut,
        imageOut: cur.u.imageOut + r.usage.imageOut,
      },
    });
  }
  const out: Partial<Record<ProviderId, Partial<Record<PaidStepKind, TokenUsage>>>> = {};
  for (const [key, { n, u }] of sums) {
    if (n < MIN_OBSERVED) continue;
    const [provider, kind] = key.split(":") as [ProviderId, PaidStepKind];
    (out[provider] ??= {})[kind] = {
      textIn: Math.round(u.textIn / n),
      imageIn: Math.round(u.imageIn / n),
      textOut: Math.round(u.textOut / n),
      imageOut: Math.round(u.imageOut / n),
    };
  }
  return out;
}
