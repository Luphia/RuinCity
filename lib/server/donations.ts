/**
 * 捐款：建立、入帳、改票。**伺服器專用。**
 *
 * ## ★ 一筆捐款就是一張選票
 *
 * 「依捐款金額比例投票」最直接的實作：每一筆捐款帶著它自己的選擇（或不投），
 * 權重就是那一筆的金額。同一個人捐三次可以投三家 —— 那是他的錢、他的意思。
 * 捐款人之後可以把自己在某一塊的**所有**捐款改投或撤回（`setMyVote`），
 * 但只能在那一塊完工之前 —— 完工之後票已經沒有意義了。
 *
 * ## ★ 入帳只認 webhook
 *
 * `confirmDonation` 由金流商的 webhook 呼叫（驗簽之後），而且是**冪等**的：
 * 金流商重送同一個通知，帳不會記兩次。
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import type { BudgetConfig } from "@/lib/world/budget";
import { blockCenter, blockKey, parseBlockKey } from "@/lib/world/grid";
import { splitDonation } from "@/lib/world/ledger";
import { WISH_MAX_CHARS } from "@/lib/world/prompts";
import { isPainterId, type PainterId, type ProviderId } from "@/lib/world/pricing";

import { DONATION_MAX_TWD, DONATION_MIN_TWD } from "./config";

export type DonationRejection =
  | "BAD_BLOCK"
  | "AMOUNT_TOO_SMALL"
  | "AMOUNT_TOO_LARGE"
  | "PROVIDER_DISABLED"
  | "BLOCK_COMPLETE"
  | "OCEAN_OR_POLE";

export const REJECTION_TEXT: Record<DonationRejection, string> = {
  BAD_BLOCK: "這不是一個有效的區塊。",
  AMOUNT_TOO_SMALL: `單筆最少 NT$${DONATION_MIN_TWD} —— 再少的話，手續費會比捐款還多。`,
  AMOUNT_TOO_LARGE: `單筆最多 NT$${DONATION_MAX_TWD.toLocaleString("en-US")}。`,
  PROVIDER_DISABLED: "這一家模型目前停用中，換一家投，或選擇不投票。",
  BLOCK_COMPLETE: "這一塊已經完成了。",
  OCEAN_OR_POLE: "極區的區塊不開放捐款（沒有任何街景，也無法畫成地圖）。",
};

/** 捐款留言的清理：去控制字元、壓空白、截斷 */
export function cleanWish(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const w = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return w ? w.slice(0, WISH_MAX_CHARS) : null;
}

export async function ensureBlock(db: TxDb, key: string): Promise<number | null> {
  const id = parseBlockKey(key);
  if (!id) return null;
  await db
    .insert(schema.blocks)
    .values({ key: blockKey(id), row: id.row, col: id.col })
    .onConflictDoNothing({ target: schema.blocks.key });
  const [row] = await db.select({ id: schema.blocks.id }).from(schema.blocks).where(eq(schema.blocks.key, key));
  return row?.id ?? null;
}

export async function createDonation(
  db: TxDb,
  input: {
    readonly blockKey: string;
    readonly donorId: string;
    readonly amountTwd: number;
    readonly vote: PainterId | null;
    readonly wish?: string | null;
    readonly processor: string;
    readonly enabled: readonly ProviderId[];
    readonly config: BudgetConfig;
  },
): Promise<{ ok: true; donationId: number; blockId: number } | { ok: false; reason: DonationRejection }> {
  const id = parseBlockKey(input.blockKey);
  if (!id) return { ok: false, reason: "BAD_BLOCK" };
  if (Math.abs(blockCenter(id).lat) > 85) return { ok: false, reason: "OCEAN_OR_POLE" };
  if (!Number.isInteger(input.amountTwd) || input.amountTwd < DONATION_MIN_TWD) {
    return { ok: false, reason: "AMOUNT_TOO_SMALL" };
  }
  if (input.amountTwd > DONATION_MAX_TWD) return { ok: false, reason: "AMOUNT_TOO_LARGE" };
  if (input.vote !== null && !input.enabled.includes(input.vote)) {
    return { ok: false, reason: "PROVIDER_DISABLED" };
  }

  const blockId = await ensureBlock(db, input.blockKey);
  if (!blockId) return { ok: false, reason: "BAD_BLOCK" };
  const [block] = await db
    .select({ completedAt: schema.blocks.completedAt })
    .from(schema.blocks)
    .where(eq(schema.blocks.id, blockId));
  if (block?.completedAt) return { ok: false, reason: "BLOCK_COMPLETE" };

  const [row] = await db
    .insert(schema.donations)
    .values({
      blockId,
      donorId: input.donorId,
      amountTwd: input.amountTwd,
      twdPerUsd: input.config.twdPerUsd,
      vote: input.vote,
      wish: cleanWish(input.wish),
      processor: input.processor,
    })
    .returning({ id: schema.donations.id });
  return { ok: true, donationId: row!.id, blockId };
}

export async function attachProcessorRef(db: TxDb, donationId: number, processorRef: string) {
  await db
    .update(schema.donations)
    .set({ processorRef })
    .where(and(eq(schema.donations.id, donationId), eq(schema.donations.status, "PENDING")));
}

export type ConfirmResult =
  | { readonly ok: true; readonly blockId: number; readonly alreadyPaid: boolean }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "AMOUNT_MISMATCH" | "NOT_PENDING" };

/**
 * 金流商通知付款成功 → 入帳。
 *
 * ★ 冪等：同一筆通知重送，第二次只回 `alreadyPaid`。
 * ★ 金額對不上就拒收 —— webhook 說付了 NT$30、訂單是 NT$3,000，那不是捐款，是攻擊。
 * ★ 匯率用**建立訂單時**的快照：捐款人看到的換算，和入帳的換算要是同一個。
 * ★ 要在交易裡呼叫（`withTransaction`）。SQLite 沒有 `SELECT … FOR UPDATE`；
 *   libSQL 的交易是 `BEGIN IMMEDIATE`，一開始就拿到寫入鎖，同一筆通知重送兩次也只會入帳一次。
 */
export async function confirmDonation(
  db: TxDb,
  input: {
    readonly processor: string;
    readonly processorRef: string;
    readonly amountTwd: number;
    readonly feeTwd?: number;
    readonly now: number;
    readonly config: BudgetConfig;
  },
): Promise<ConfirmResult> {
  const [d] = await db
    .select()
    .from(schema.donations)
    .where(and(eq(schema.donations.processor, input.processor), eq(schema.donations.processorRef, input.processorRef)));
  if (!d) return { ok: false, reason: "NOT_FOUND" };
  if (d.status === "PAID") return { ok: true, blockId: d.blockId, alreadyPaid: true };
  if (d.status !== "PENDING") return { ok: false, reason: "NOT_PENDING" };
  if (d.amountTwd !== input.amountTwd) return { ok: false, reason: "AMOUNT_MISMATCH" };

  const split = splitDonation(d.amountTwd, Number(d.twdPerUsd), input.config, input.feeTwd);
  await db
    .update(schema.donations)
    .set({
      status: "PAID",
      paidAt: new Date(input.now),
      grossMicros: split.grossMicros,
      feeMicros: split.feeMicros,
      taxMicros: split.taxMicros,
      chargebackMicros: split.chargebackMicros,
      netMicros: split.netMicros,
    })
    .where(eq(schema.donations.id, d.id));

  // 暫停中的塊：新的捐款進來，給它一次重新開工的機會
  await db
    .update(schema.blocks)
    .set({ pausedAt: null, pauseReason: null, consecutiveFailures: 0 })
    .where(and(eq(schema.blocks.id, d.blockId), sql`${schema.blocks.pauseReason} = 'WAITING_FOR_FUNDS'`));

  return { ok: true, blockId: d.blockId, alreadyPaid: false };
}

export async function failDonation(db: TxDb, processor: string, processorRef: string) {
  await db
    .update(schema.donations)
    .set({ status: "FAILED" })
    .where(
      and(
        eq(schema.donations.processor, processor),
        eq(schema.donations.processorRef, processorRef),
        eq(schema.donations.status, "PENDING"),
      ),
    );
}

/**
 * 把我在這一塊的所有捐款改投 `vote`（null = 撤回投票）。
 * 完工之後不能改：票只在施工期間有意義。
 */
export async function setMyVote(
  db: TxDb,
  input: { readonly blockKey: string; readonly donorId: string; readonly vote: PainterId | null; readonly enabled: readonly ProviderId[] },
): Promise<{ ok: true; changed: number } | { ok: false; reason: "NOT_FOUND" | "BLOCK_COMPLETE" | "PROVIDER_DISABLED" }> {
  if (input.vote !== null && !input.enabled.includes(input.vote)) return { ok: false, reason: "PROVIDER_DISABLED" };
  const [block] = await db
    .select({ id: schema.blocks.id, completedAt: schema.blocks.completedAt })
    .from(schema.blocks)
    .where(eq(schema.blocks.key, input.blockKey));
  if (!block) return { ok: false, reason: "NOT_FOUND" };
  if (block.completedAt) return { ok: false, reason: "BLOCK_COMPLETE" };
  const changed = await db
    .update(schema.donations)
    .set({ vote: input.vote })
    .where(
      and(
        eq(schema.donations.blockId, block.id),
        eq(schema.donations.donorId, input.donorId),
        inArray(schema.donations.status, ["PAID", "PENDING"]),
      ),
    )
    .returning({ id: schema.donations.id });
  return { ok: true, changed: changed.length };
}

export interface MyDonation {
  readonly id: number;
  readonly blockKey: string;
  readonly amountTwd: number;
  readonly status: string;
  readonly vote: PainterId | null;
  readonly createdAt: number;
}

export async function myDonations(db: TxDb, donorId: string, blockKeyFilter?: string): Promise<MyDonation[]> {
  const rows = await db
    .select({
      id: schema.donations.id,
      blockKey: schema.blocks.key,
      amountTwd: schema.donations.amountTwd,
      status: schema.donations.status,
      vote: schema.donations.vote,
      createdAt: schema.donations.createdAt,
    })
    .from(schema.donations)
    .innerJoin(schema.blocks, eq(schema.blocks.id, schema.donations.blockId))
    .where(
      blockKeyFilter
        ? and(eq(schema.donations.donorId, donorId), eq(schema.blocks.key, blockKeyFilter))
        : eq(schema.donations.donorId, donorId),
    )
    .orderBy(sql`${schema.donations.id} desc`)
    .limit(200);
  return rows.map((r) => ({
    ...r,
    vote: isPainterId(r.vote) ? r.vote : null,
    createdAt: r.createdAt.getTime(),
  }));
}
