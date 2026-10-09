/**
 * 平台撥款：管理員不經捐款直接把一塊蓋起來（`pnpm block:paint`）。**伺服器專用。**
 *
 * ★ 不是繞過帳：撥款是帳上的一筆收入（`donations`，processor = `grant`），
 *   狀態照樣由帳推導，施工引擎照樣看餘額開工。所以區塊頁、預算書、施工引擎看到的
 *   仍然是同一份 —— 只是錢的來源寫成「平台撥款」，不算捐款、不算捐款人。
 * ★ 撥的是**淨額缺口**：撥款沒有手續費與稅，撥多了只會變成結餘。
 *   估價低估時（實際用量比較高），下一次呼叫會再補，直到蓋完。
 * ★ 撥款可以投票（`painter`）：它的權重就是撥款金額，管理員用它指定由誰來畫。
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { blockCenter, parseBlockKey } from "@/lib/world/grid";
import { GRANT_DONOR, GRANT_PROCESSOR, grantNeededMicros, grantSplit, microsToTwdCeil } from "@/lib/world/ledger";
import type { PainterId } from "@/lib/world/pricing";

import { loadBlockState, type BlockState, type StateDeps } from "./blocks";
import { ensureBlock } from "./donations";

export type GrantResult =
  | { readonly ok: true; readonly grantedTwd: number; readonly grantedMicros: number; readonly resumed: boolean; readonly state: BlockState }
  | { readonly ok: false; readonly reason: "BAD_BLOCK" | "OCEAN_OR_POLE" | "BLOCK_COMPLETE" | "PROVIDER_DISABLED" };

/** 還要撥多少（微美元）；已完成回 0 */
export function grantQuote(state: BlockState): number {
  if (state.status === "COMPLETE") return 0;
  return grantNeededMicros({
    netGapMicros: state.budget.netGapMicros,
    constructionBalanceMicros: state.budget.constructionBalanceMicros,
    nextStepMicros: state.budget.nextStepMicros,
  });
}

/** 還沒做的步驟預計要付給模型與地圖服務的錢（token + 參考影像，不含預備金與保存） */
export function remainingApiMicros(state: BlockState): number {
  return state.budget.lines
    .filter((l) => l.group === "construction" || l.group === "reference")
    .reduce((s, l) => s + Math.max(0, l.microsProjected - l.microsActual), 0);
}

/** 已經付給模型與地圖服務的錢（含失敗那幾次照收的費用；不含圈存的保存與營運） */
export function apiSpentMicros(state: BlockState): number {
  return state.budget.lines
    .filter((l) => l.group === "construction" || l.group === "reference" || l.key === "contingency.retry")
    .reduce((s, l) => s + l.microsActual, 0);
}

/**
 * 補足這一塊的經費。**要在交易裡呼叫**（`withTransaction`）：讀餘額與寫入撥款是同一個決定。
 *
 * `resume`：解除暫停（連續失敗而暫停的塊，管理員處理完金鑰或提示詞之後用）。
 */
export async function grantToBlock(
  tx: TxDb,
  input: {
    readonly key: string;
    readonly painter: PainterId | null;
    readonly resume: boolean;
    readonly now: number;
    readonly deps: StateDeps;
  },
): Promise<GrantResult> {
  const id = parseBlockKey(input.key);
  if (!id) return { ok: false, reason: "BAD_BLOCK" };
  if (Math.abs(blockCenter(id).lat) > 85) return { ok: false, reason: "OCEAN_OR_POLE" };
  if (input.painter !== null && !input.deps.enabled.includes(input.painter)) return { ok: false, reason: "PROVIDER_DISABLED" };

  const blockId = await ensureBlock(tx, input.key);
  if (!blockId) return { ok: false, reason: "BAD_BLOCK" };

  let resumed = false;
  if (input.resume) {
    const r = await tx
      .update(schema.blocks)
      .set({ pausedAt: null, pauseReason: null, consecutiveFailures: 0 })
      .where(and(eq(schema.blocks.id, blockId), isNotNull(schema.blocks.pausedAt)))
      .returning({ id: schema.blocks.id });
    resumed = r.length > 0;
  }

  const before = await loadBlockState(tx, input.key, input.now, input.deps);
  if (!before) return { ok: false, reason: "BAD_BLOCK" };
  if (before.status === "COMPLETE") return { ok: false, reason: "BLOCK_COMPLETE" };

  // 指定由誰來畫：之前的撥款一起改投（撥款是平台的票，不動捐款人的票）
  if (input.painter !== null) {
    await tx
      .update(schema.donations)
      .set({ vote: input.painter })
      .where(and(eq(schema.donations.blockId, blockId), eq(schema.donations.processor, GRANT_PROCESSOR)));
  }

  /**
   * ★ 撥款自己也是一張票：指定較貴的畫師時，撥下去之後估價跟著變高。
   *   所以同一筆撥款補到不再缺為止（幾輪就收斂：票只會往指定的那一家移）。
   */
  const twdPerUsd = input.deps.config.twdPerUsd;
  let grantId: number | null = null;
  let grantedTwd = 0;
  let state = before;
  for (let round = 0; round < 5; round++) {
    const needed = grantQuote(state);
    if (needed <= 0) break;
    grantedTwd += microsToTwdCeil(needed, twdPerUsd);
    const split = grantSplit(grantedTwd, twdPerUsd);
    if (grantId === null) {
      const [row] = await tx
        .insert(schema.donations)
        .values({
          blockId,
          donorId: GRANT_DONOR,
          status: "PAID",
          amountTwd: grantedTwd,
          twdPerUsd,
          ...split,
          vote: input.painter,
          processor: GRANT_PROCESSOR,
          processorRef: `grant-${input.now}-${randomUUID().slice(0, 8)}`,
          paidAt: new Date(input.now),
        })
        .returning({ id: schema.donations.id });
      grantId = row!.id;
    } else {
      await tx.update(schema.donations).set({ amountTwd: grantedTwd, ...split }).where(eq(schema.donations.id, grantId));
    }
    state = (await loadBlockState(tx, input.key, input.now, input.deps))!;
  }

  return { ok: true, grantedTwd, grantedMicros: grantedTwd > 0 ? grantSplit(grantedTwd, twdPerUsd).grossMicros : 0, resumed, state };
}
