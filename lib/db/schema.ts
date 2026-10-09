/**
 * 資料庫結構。
 *
 * 四張主表：
 *
 *   blocks     一塊地圖（0.01° × 0.01°）。只有被捐過款的塊才有一列
 *   donations  捐款。**一筆捐款就是一張選票**：它的總額投給它選的那一家（或不投）
 *   steps      施工紀錄。每一次嘗試一列（成功或失敗都記），帳由這裡加總
 *   artifacts  產出的圖。**區塊完成前不對外提供**（`lib/server/artifacts.ts`）
 *
 * ★ 狀態（募款中／建設中／已完成）**不存欄位**，由帳推導（`lib/world/ledger.ts`）。
 *   唯一存下來的是 `completed_at` 與 `paused_at` —— 它們是事件，不是餘額。
 *
 * ★ 金額一律是**微美元**的 bigint。新台幣只存捐款人實際付的整數金額與當時的匯率。
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { MapParams } from "@/lib/world/params";
import type { Viewpoint } from "@/lib/world/prompts";

/** Postgres `bytea`。drizzle 沒有內建 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const micros = (name: string) => bigint(name, { mode: "number" });

// ─────────────────────────────────────────────────────────────
// 區塊
// ─────────────────────────────────────────────────────────────

export const blocks = pgTable(
  "blocks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 西南角，例如 `25.03_121.56`（`lib/world/grid.ts` 的 `blockKey`） */
    key: text("key").notNull(),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * 勘查選出的標記座標。只有全景 ID、座標與朝向 ——
     * Google 允許無限期保存 pano ID，**不允許**保存影像，所以影像一張都不存。
     */
    viewpoints: jsonb("viewpoints").$type<Viewpoint[]>(),
    params: jsonb("params").$type<MapParams>(),
    /** 模型給的參數格式不對、經過修正 */
    paramsRepaired: boolean("params_repaired").notNull().default(false),

    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** 完成時從淨額撥出的保存與分攤（之前為 null） */
    storageAllocatedMicros: micros("storage_allocated_micros"),
    computeAllocatedMicros: micros("compute_allocated_micros"),

    /**
     * 施工租約。一個步驟要呼叫外部 API 幾十秒，不能拿著交易鎖等 ——
     * 所以用一個有期限的租約：拿到才施工，逾時自動失效（工作者當掉也不會永遠卡住）。
     */
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseHolder: text("lease_holder"),

    /** 連續失敗次數。成功一次就歸零 */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
  },
  (t) => [
    uniqueIndex("blocks_key_uq").on(t.key),
    uniqueIndex("blocks_row_col_uq").on(t.row, t.col),
    index("blocks_open_idx").on(t.id).where(sql`completed_at IS NULL AND paused_at IS NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────
// 捐款（也是選票）
// ─────────────────────────────────────────────────────────────

export const donationStatusEnum = pgEnum("donation_status", ["PENDING", "PAID", "FAILED", "REFUNDED"]);

export const donations = pgTable(
  "donations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    blockId: bigint("block_id", { mode: "number" })
      .notNull()
      .references(() => blocks.id),
    /** Auth.js 的使用者 id */
    donorId: text("donor_id").notNull(),
    status: donationStatusEnum("status").notNull().default("PENDING"),

    /** 捐款人付的新台幣（整數元） */
    amountTwd: integer("amount_twd").notNull(),
    /** 入帳時的匯率快照（新台幣／美元） */
    twdPerUsd: numeric("twd_per_usd", { precision: 10, scale: 4 }).notNull(),

    /** 以下在 PAID 時填入（`ledger.splitDonation`） */
    grossMicros: micros("gross_micros").notNull().default(0),
    feeMicros: micros("fee_micros").notNull().default(0),
    taxMicros: micros("tax_micros").notNull().default(0),
    chargebackMicros: micros("chargeback_micros").notNull().default(0),
    netMicros: micros("net_micros").notNull().default(0),

    /** 這一張選票投給誰；null = 不投票 */
    vote: text("vote"),
    /** 給 AI 的建議（≤140 字，見 `prompts.wishesText`） */
    wish: text("wish"),

    processor: text("processor").notNull(),
    /** 金流商的訂單編號。webhook 依它對帳，所以要唯一 */
    processorRef: text("processor_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
  },
  (t) => [
    index("donations_block_idx").on(t.blockId, t.status),
    index("donations_donor_idx").on(t.donorId),
    uniqueIndex("donations_processor_ref_uq").on(t.processor, t.processorRef),
    check("donations_amount_positive", sql`${t.amountTwd} > 0`),
    check("donations_vote_known", sql`${t.vote} IS NULL OR ${t.vote} IN ('google','openai')`),
  ],
);

// ─────────────────────────────────────────────────────────────
// 施工紀錄
// ─────────────────────────────────────────────────────────────

export const stepStatusEnum = pgEnum("step_status", ["SUCCEEDED", "FAILED"]);

export const steps = pgTable(
  "steps",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    blockId: bigint("block_id", { mode: "number" })
      .notNull()
      .references(() => blocks.id),
    /** 在施工計畫裡的位置（`plan.planSteps` 的索引） */
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    kindIndex: integer("kind_index").notNull().default(0),
    status: stepStatusEnum("status").notNull(),

    /** 這一步由誰畫（勘查為 null） */
    provider: text("provider"),
    /** 實際服務的模型（fallback 時與請求的不同） */
    model: text("model"),

    textIn: integer("text_in").notNull().default(0),
    imageIn: integer("image_in").notNull().default(0),
    textOut: integer("text_out").notNull().default(0),
    imageOut: integer("image_out").notNull().default(0),
    tokenMicros: micros("token_micros").notNull().default(0),
    referenceMicros: micros("reference_micros").notNull().default(0),

    pricingVersion: text("pricing_version").notNull(),
    bibleVersion: text("bible_version").notNull(),
    /** 開工時的票數快照：{ weights, ranking } —— 「為什麼這一步是它畫的」 */
    tally: jsonb("tally").$type<{ weights: Record<string, number>; ranking: string[] }>(),

    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    note: text("note"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("steps_block_idx").on(t.blockId, t.seq),
    /** 一個位置只能成功一次 —— 兩個工作者搶到同一步時，第二個寫不進來 */
    uniqueIndex("steps_block_seq_succeeded_uq")
      .on(t.blockId, t.seq)
      .where(sql`status = 'SUCCEEDED'`),
    index("steps_observed_idx").on(t.provider, t.kind, t.id).where(sql`status = 'SUCCEEDED'`),
  ],
);

// ─────────────────────────────────────────────────────────────
// 產出
// ─────────────────────────────────────────────────────────────

export const artifacts = pgTable(
  "artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    blockId: bigint("block_id", { mode: "number" })
      .notNull()
      .references(() => blocks.id),
    stepId: bigint("step_id", { mode: "number" })
      .notNull()
      .references(() => steps.id),
    kind: text("kind").notNull(),
    kindIndex: integer("kind_index").notNull().default(0),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    data: bytea("data").notNull(),
    thumb: bytea("thumb").notNull(),
    /** 例：材質名稱、標記座標的說明 */
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("artifacts_block_kind_uq").on(t.blockId, t.kind, t.kindIndex)],
);
