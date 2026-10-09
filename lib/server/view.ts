/**
 * 區塊狀態 → 給畫面用的 JSON。**伺服器專用。**
 *
 * ★ 金額在這裡就換算成新台幣字串：匯率是伺服器的設定，
 *   客戶端不該自己乘 —— 兩邊各乘一次遲早對不上。
 * ★ 施工中的區塊**不帶任何圖**，只有數字。完成後才附上產出清單。
 */

import "server-only";

import { GROUP_LABEL, type BudgetGroup } from "@/lib/world/budget";
import { blockBounds, blockLabel, blockShortLabel, distanceFromOriginM, isOrigin } from "@/lib/world/grid";
import { STATUS_LABEL, formatTokens, formatTwd, formatUsd, type BlockStatus } from "@/lib/world/ledger";
import { MODEL_PROFILES, PAINTERS, PROVIDER_ORDER, type PainterId, type ProviderId } from "@/lib/world/pricing";

import type { ArtifactIndexEntry } from "./artifacts";
import type { BlockState } from "./blocks";

export interface Money {
  readonly twd: string;
  readonly usd: string;
  readonly micros: number;
}

export interface BlockView {
  readonly key: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly isOrigin: boolean;
  readonly distanceKm: number;
  readonly bounds: { south: number; north: number; west: number; east: number };
  readonly status: BlockStatus;
  readonly statusLabel: string;
  readonly pauseReason: string | null;
  readonly meters: {
    readonly tokensNeeded: string;
    readonly moneyNeeded: Money;
    readonly tokensSpent: string;
    readonly moneySpent: Money;
    /** 0..1 */
    readonly tokenProgress: number;
  };
  readonly funding: {
    readonly received: Money;
    readonly gap: Money;
    readonly constructionBalance: Money;
    readonly donations: number;
    readonly donors: number;
    /** 0..1 */
    readonly progress: number;
  };
  readonly progress: { readonly done: number; readonly total: number; readonly next: string | null };
  readonly budget: readonly {
    readonly group: BudgetGroup;
    readonly groupLabel: string;
    readonly lines: readonly {
      readonly key: string;
      readonly label: string;
      readonly basis: string;
      readonly tokensProjected: string | null;
      readonly projected: Money;
      readonly actual: Money;
    }[];
  }[];
  readonly vote: {
    readonly decidedBy: "VOTES" | "DEFAULT" | "NONE";
    readonly current: PainterId | null;
    /** 寫地圖參數的那一家（不出圖、不投票）；沒有就是預設參數 */
    readonly surveyor: string | null;
    readonly options: readonly {
      readonly provider: PainterId;
      readonly company: string;
      readonly model: string;
      readonly enabled: boolean;
      readonly weight: Money;
      readonly share: number;
      /** 若全部交給它，完成這一塊的募款總額 */
      readonly estimate: Money | null;
    }[];
    readonly abstained: Money;
  };
  readonly log: readonly {
    readonly label: string;
    readonly status: "SUCCEEDED" | "FAILED";
    readonly provider: string | null;
    readonly model: string | null;
    readonly tokens: string;
    readonly cost: string;
    readonly error: string | null;
  }[];
  readonly surplus: Money | null;
  readonly completed: null | {
    readonly fieldNote: string | null;
    readonly artifacts: readonly ArtifactIndexEntry[];
    readonly markers: readonly { readonly index: number; readonly lat: number; readonly lng: number; readonly heading: number; readonly caption: string | null }[];
    readonly credits: readonly { readonly provider: string; readonly steps: number }[];
  };
}

const KIND_LABEL: Record<string, string> = {
  SURVEY: "勘查",
  PARAMS: "地圖參數",
  SCENE: "場景圖",
  TILE: "正射底圖",
  DSM: "3D 圖資",
  TEXTURE: "材質貼圖",
};

export const PAUSE_TEXT: Record<string, string> = {
  "STEP_FAILED:SAFETY": "模型連續婉拒繪製（內容安全判斷），等待管理者檢查提示詞",
  "STEP_FAILED:AUTH": "平台的模型或地圖金鑰被拒，等待管理者更新金鑰",
  "STEP_FAILED:NO_IMAGE": "模型連續沒有回傳成品，等待管理者檢查",
  "STEP_FAILED:QUOTA": "模型供應商限流，稍後會再嘗試",
  "STEP_FAILED:UPSTREAM": "模型供應商暫時故障，稍後會再嘗試",
  "STEP_FAILED:BAD_REQUEST": "請求格式被拒，等待管理者檢查",
  "STEP_FAILED:INTERNAL": "伺服器內部錯誤，等待管理者檢查",
};

export function toBlockView(
  s: BlockState,
  opts: {
    readonly twdPerUsd: number;
    readonly enabled: readonly ProviderId[];
    readonly estimates: Partial<Record<ProviderId, number>>;
    readonly artifacts: readonly ArtifactIndexEntry[] | null;
  },
): BlockView {
  const money = (micros: number): Money => ({ twd: formatTwd(micros, opts.twdPerUsd), usd: formatUsd(micros), micros });
  const b = s.budget;

  const groups = new Map<BudgetGroup, BlockView["budget"][number]["lines"][number][]>();
  for (const l of b.lines) {
    const arr = groups.get(l.group) ?? [];
    arr.push({
      key: l.key,
      label: l.label,
      basis: l.basis,
      tokensProjected: l.tokensProjected ? formatTokens(l.tokensProjected) : null,
      projected: money(l.microsProjected),
      actual: money(l.microsActual),
    });
    groups.set(l.group, arr);
  }

  const totalVoted = s.tally.votedMicros;
  const next = s.steps[s.done];
  const row = s.row;

  const completed =
    s.status === "COMPLETE" && row
      ? {
          fieldNote: row.params?.fieldNote ?? null,
          artifacts: opts.artifacts ?? [],
          markers: (row.viewpoints ?? []).map((v, i) => ({
            index: i,
            lat: v.location.lat,
            lng: v.location.lng,
            heading: v.heading,
            caption: row.params?.markers[i]?.caption ?? null,
          })),
          credits: PROVIDER_ORDER.map((p) => ({
            provider: MODEL_PROFILES[p].displayName,
            steps: s.log.filter((l) => l.status === "SUCCEEDED" && l.provider === p).length,
          })).filter((c) => c.steps > 0),
        }
      : null;

  return {
    key: s.key,
    label: blockLabel(s.id),
    shortLabel: blockShortLabel(s.id),
    isOrigin: isOrigin(s.id),
    distanceKm: Math.round(distanceFromOriginM(s.id) / 100) / 10,
    bounds: blockBounds(s.id),
    status: s.status,
    statusLabel: STATUS_LABEL[s.status],
    pauseReason: row?.pauseReason ? (PAUSE_TEXT[row.pauseReason] ?? row.pauseReason) : null,
    meters: {
      tokensNeeded: formatTokens(b.meters.tokensNeeded),
      moneyNeeded: money(b.meters.grossNeededMicros),
      tokensSpent: formatTokens(b.meters.tokensSpent),
      moneySpent: money(b.meters.moneySpentMicros),
      tokenProgress: b.meters.tokensNeeded > 0 ? Math.min(1, b.meters.tokensSpent / b.meters.tokensNeeded) : 0,
    },
    funding: {
      received: money(b.grossReceivedMicros),
      gap: money(b.grossGapMicros),
      constructionBalance: money(b.constructionBalanceMicros),
      donations: s.donationCount,
      donors: s.donorCount,
      progress: b.meters.grossNeededMicros > 0 ? Math.min(1, b.grossReceivedMicros / b.meters.grossNeededMicros) : 0,
    },
    progress: { done: s.done, total: s.steps.length, next: next ? `${KIND_LABEL[next.kind]}${next.kind === "SCENE" || next.kind === "TEXTURE" ? ` #${next.index + 1}` : ""}` : null },
    budget: [...groups.entries()].map(([group, lines]) => ({ group, groupLabel: GROUP_LABEL[group], lines })),
    vote: {
      decidedBy: s.tally.decidedBy,
      current: s.tally.winner,
      surveyor: s.tally.surveyor ? `${MODEL_PROFILES[s.tally.surveyor].company} · ${MODEL_PROFILES[s.tally.surveyor].displayName}` : null,
      options: PAINTERS.map((p) => ({
        provider: p,
        company: MODEL_PROFILES[p].company,
        model: MODEL_PROFILES[p].displayName,
        enabled: opts.enabled.includes(p),
        weight: money(s.tally.weights[p]),
        share: totalVoted > 0 ? s.tally.weights[p] / totalVoted : 0,
        estimate: opts.estimates[p] !== undefined ? money(opts.estimates[p]!) : null,
      })),
      abstained: money(s.tally.totalMicros - s.tally.votedMicros),
    },
    log: [...s.log]
      .reverse()
      .slice(0, 200)
      .map((l) => ({
        label: `${KIND_LABEL[l.kind] ?? l.kind}${l.kind === "SCENE" || l.kind === "TEXTURE" ? ` #${l.kindIndex + 1}` : ""}`,
        status: l.status,
        provider: l.provider ? MODEL_PROFILES[l.provider].company : null,
        model: l.model,
        tokens: formatTokens(l.tokens),
        cost: formatTwd(l.micros, opts.twdPerUsd),
        error: l.errorCode,
      })),
    surplus: s.status === "COMPLETE" ? money(b.surplusMicros) : null,
    completed,
  };
}
