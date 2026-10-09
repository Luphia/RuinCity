/**
 * 一塊地圖的完整狀態：帳、票、施工進度、預算書。**伺服器專用。**
 *
 * ★ 「這一塊現在怎樣了」**只有這一份實作**。區塊頁、施工引擎、世界地圖都呼叫它 ——
 *   施工引擎決定開不開工所看的餘額，和捐款人在頁面上看到的餘額必須是同一個數字。
 *   兩份實作遲早分岔，症狀是「頁面說建設中、其實在等錢」或反過來。
 */

import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { buildBudget, type Budget, type BudgetConfig } from "@/lib/world/budget";
import { blockKey, parseBlockKey, type BlockId } from "@/lib/world/grid";
import { GRANT_PROCESSOR, blockStatus, type BlockStatus } from "@/lib/world/ledger";
import {
  addKind,
  averageObserved,
  emptyKindTotals,
  planSteps,
  type Observed,
  type PlannedStep,
} from "@/lib/world/plan";
import {
  isPainterId,
  isProviderId,
  type PaidStepKind,
  type PainterId,
  type ProviderId,
  type StepKind,
} from "@/lib/world/pricing";
import { pickFor, tallyVotes, type Tally } from "@/lib/world/vote";

export type BlockRow = typeof schema.blocks.$inferSelect;

export interface StepLogEntry {
  readonly seq: number;
  readonly kind: StepKind;
  readonly kindIndex: number;
  readonly status: "SUCCEEDED" | "FAILED";
  readonly provider: ProviderId | null;
  readonly model: string | null;
  readonly tokens: number;
  readonly micros: number;
  readonly errorCode: string | null;
  readonly finishedAt: number;
}

export interface BlockState {
  readonly id: BlockId;
  readonly key: string;
  /** null = 從來沒有人捐過款 */
  readonly row: BlockRow | null;
  readonly steps: readonly PlannedStep[];
  readonly done: number;
  readonly tally: Tally;
  readonly budget: Budget;
  readonly status: BlockStatus;
  readonly running: boolean;
  /** 捐款筆數與人數（不含平台撥款） */
  readonly donationCount: number;
  readonly donorCount: number;
  /** 平台撥款的總額（`pnpm block:paint`）；已含在預算書的已收金額裡 */
  readonly grantedMicros: number;
  readonly log: readonly StepLogEntry[];
  /** 最近的捐款留言（給 AI 的建議），新的在前 */
  readonly wishes: readonly string[];
  /** 如果剩下的步驟全部交給某一家，完成這一塊的募款總額（投票時參考） */
  readonly estimates: Partial<Record<PainterId, number>>;
}

export interface StateDeps {
  readonly enabled: readonly ProviderId[];
  readonly fallback: PainterId;
  readonly config: BudgetConfig;
  /** 全站的實際用量平均（`loadObserved`）；不給就只用表上的先驗 */
  readonly observed?: Observed;
}

/** 全站最近的實際用量 → 估計用的平均值 */
export async function loadObserved(db: TxDb): Promise<Observed> {
  const rows = await db
    .select({
      provider: schema.steps.provider,
      kind: schema.steps.kind,
      textIn: schema.steps.textIn,
      imageIn: schema.steps.imageIn,
      textOut: schema.steps.textOut,
      imageOut: schema.steps.imageOut,
    })
    .from(schema.steps)
    .where(and(eq(schema.steps.status, "SUCCEEDED"), isNotNull(schema.steps.provider)))
    .orderBy(desc(schema.steps.id))
    .limit(3000);
  return averageObserved(
    rows
      .filter((r) => isProviderId(r.provider))
      .map((r) => ({
        provider: r.provider as ProviderId,
        kind: r.kind as StepKind,
        usage: { textIn: r.textIn, imageIn: r.imageIn, textOut: r.textOut, imageOut: r.imageOut },
      })),
  );
}

export async function loadBlockState(
  db: TxDb,
  key: string,
  now: number,
  deps: StateDeps,
): Promise<BlockState | null> {
  const id = parseBlockKey(key);
  if (!id) return null;

  const [row] = await db.select().from(schema.blocks).where(eq(schema.blocks.key, key)).limit(1);

  const paid = row
    ? await db
        .select({
          donorId: schema.donations.donorId,
          grossMicros: schema.donations.grossMicros,
          feeMicros: schema.donations.feeMicros,
          taxMicros: schema.donations.taxMicros,
          chargebackMicros: schema.donations.chargebackMicros,
          vote: schema.donations.vote,
          wish: schema.donations.wish,
          paidAt: schema.donations.paidAt,
          processor: schema.donations.processor,
        })
        .from(schema.donations)
        .where(and(eq(schema.donations.blockId, row.id), eq(schema.donations.status, "PAID")))
    : [];

  const attempts = row
    ? await db.select().from(schema.steps).where(eq(schema.steps.blockId, row.id)).orderBy(schema.steps.id)
    : [];

  return deriveState(id, row ?? null, paid, attempts, now, deps);
}

type PaidRow = {
  donorId: string;
  grossMicros: number;
  feeMicros: number;
  taxMicros: number;
  chargebackMicros: number;
  vote: string | null;
  wish: string | null;
  paidAt: Date | null;
  processor: string;
};

type StepRow = typeof schema.steps.$inferSelect;

/** 純推導（拆出來是為了讓整合測試以外也看得懂這段在算什麼） */
export function deriveState(
  id: BlockId,
  row: BlockRow | null,
  paid: readonly PaidRow[],
  attempts: readonly StepRow[],
  now: number,
  deps: StateDeps,
): BlockState {
  // ── 票：一筆捐款一張票，權重 = 那一筆的總額 ──
  const tally = tallyVotes(
    paid.map((d) => ({
      donorId: d.donorId,
      paidMicros: d.grossMicros,
      vote: isPainterId(d.vote) ? d.vote : null,
    })),
    deps.enabled,
    deps.fallback,
  );

  // ── 施工進度：成功的步驟必須是從 0 開始的連續前綴 ──
  const succeeded = new Map<number, StepRow>();
  for (const s of attempts) if (s.status === "SUCCEEDED") succeeded.set(s.seq, s);
  let done = 0;
  while (succeeded.has(done)) done++;

  const steps = planSteps(row?.viewpoints ? row.viewpoints.length : null);

  const byKind = emptyKindTotals();
  let failedTokens = 0;
  let failedMicros = 0;
  for (const s of attempts) {
    const tokens = s.textIn + s.imageIn + s.textOut + s.imageOut;
    if (s.status === "FAILED") {
      failedTokens += tokens;
      failedMicros += s.tokenMicros + s.referenceMicros;
      continue;
    }
    if (s.kind === "SURVEY") continue;
    const k = s.kind as PaidStepKind;
    byKind[k] = addKind(byKind[k], { tokens, tokenMicros: s.tokenMicros, referenceMicros: s.referenceMicros });
  }

  const received = paid.reduce(
    (acc, d) => ({
      count: acc.count + 1,
      grossMicros: acc.grossMicros + d.grossMicros,
      feeMicros: acc.feeMicros + d.feeMicros,
      taxMicros: acc.taxMicros + d.taxMicros,
      chargebackMicros: acc.chargebackMicros + d.chargebackMicros,
    }),
    { count: 0, grossMicros: 0, feeMicros: 0, taxMicros: 0, chargebackMicros: 0 },
  );

  const allocated =
    row?.storageAllocatedMicros != null && row.computeAllocatedMicros != null
      ? { storageMicros: row.storageAllocatedMicros, computeMicros: row.computeAllocatedMicros }
      : null;

  const budgetFor = (pick: (kind: StepKind) => ProviderId | null) =>
    buildBudget({
      steps,
      done,
      pick,
      observed: deps.observed,
      actual: { byKind, failed: { tokens: failedTokens, micros: failedMicros } },
      received,
      allocated,
      config: deps.config,
    });
  const budget = budgetFor((kind) => pickFor(tally, kind));

  // 「如果改投某一家」的總額：出圖換成那一家，地圖參數仍歸勘查員
  const estimates: Partial<Record<PainterId, number>> = {};
  for (const p of tally.ranking) {
    estimates[p] = budgetFor((kind) => (kind === "PARAMS" ? tally.surveyor : p)).meters.grossNeededMicros;
  }

  const running = !!row?.leaseUntil && row.leaseUntil.getTime() > now;
  const status = blockStatus({
    grossReceivedMicros: received.grossMicros,
    constructionBalanceMicros: budget.constructionBalanceMicros,
    completedAt: row?.completedAt ?? null,
    nextStepMicros: budget.nextStepMicros,
    running,
    paused: !!row?.pausedAt,
  });

  const donations = paid.filter((d) => d.processor !== GRANT_PROCESSOR);
  const wishes = paid
    .filter((d) => d.wish && d.wish.trim())
    .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0))
    .map((d) => d.wish!.trim());

  return {
    id,
    key: blockKey(id),
    row,
    steps,
    done,
    tally,
    budget,
    status,
    running,
    donationCount: donations.length,
    donorCount: new Set(donations.map((d) => d.donorId)).size,
    grantedMicros: paid.filter((d) => d.processor === GRANT_PROCESSOR).reduce((s, d) => s + d.grossMicros, 0),
    log: attempts.map((s) => ({
      seq: s.seq,
      kind: s.kind as StepKind,
      kindIndex: s.kindIndex,
      status: s.status,
      provider: isProviderId(s.provider) ? s.provider : null,
      model: s.model,
      tokens: s.textIn + s.imageIn + s.textOut + s.imageOut,
      micros: s.tokenMicros + s.referenceMicros,
      errorCode: s.errorCode,
      finishedAt: s.finishedAt.getTime(),
    })),
    wishes,
    estimates,
  };
}

export interface BlockSummary {
  readonly key: string;
  readonly row: number;
  readonly col: number;
  readonly completed: boolean;
  readonly paused: boolean;
  /** 已募得的捐款（不含平台撥款） */
  readonly grossMicros: number;
}

/**
 * 世界地圖用：一個範圍裡**有人捐過款**的塊。
 *
 * ★ 只回粗狀態（完成／暫停／有捐款）——地圖上幾百塊不能每一塊都算一份預算書。
 *   精確的狀態在區塊頁（`loadBlockState`）。
 */
export async function blocksInRange(
  db: TxDb,
  range: { rowMin: number; rowMax: number; colMin: number; colMax: number },
  limit = 2000,
): Promise<BlockSummary[]> {
  const rows = await db
    .select({
      key: schema.blocks.key,
      row: schema.blocks.row,
      col: schema.blocks.col,
      completedAt: schema.blocks.completedAt,
      pausedAt: schema.blocks.pausedAt,
      gross: sql<string>`coalesce((select sum(${schema.donations.grossMicros}) from ${schema.donations} where ${schema.donations.blockId} = ${schema.blocks.id} and ${schema.donations.status} = 'PAID' and ${schema.donations.processor} <> ${GRANT_PROCESSOR}), 0)`,
    })
    .from(schema.blocks)
    .where(
      and(
        gte(schema.blocks.row, range.rowMin),
        lte(schema.blocks.row, range.rowMax),
        // 換日線：呼叫端把跨線的範圍拆成兩段
        gte(schema.blocks.col, range.colMin),
        lte(schema.blocks.col, range.colMax),
      ),
    )
    .limit(limit);
  return rows.map((r) => ({
    key: r.key,
    row: r.row,
    col: r.col,
    completed: !!r.completedAt,
    paused: !!r.pausedAt,
    grossMicros: Number(r.gross),
  }));
}

/** 完成的鄰塊（底圖接縫用） */
export async function completedBlocks(db: TxDb, keys: readonly string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.blocks.id, key: schema.blocks.key })
    .from(schema.blocks)
    .where(and(inArray(schema.blocks.key, [...keys]), isNotNull(schema.blocks.completedAt)));
  return new Map(rows.map((r) => [r.key, r.id]));
}
