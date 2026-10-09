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
 * 長期保存（`lib/server/archive.ts`）：
 *
 *   scene_files     場景包裡「圖以外」的檔案（scene.json、檢視器、README），完工後凍結
 *   scene_archives  每塊一列：場景包的根 CID、Boltchain 委託索引的 CID、保存目標
 *   scene_deals     SwarmStorage 的保存委託。四年是一串接力的委託（見 `lib/swarm/quote.ts`）
 *
 * ★ 狀態（募款中／建設中／已完成）**不存欄位**，由帳推導（`lib/world/ledger.ts`）。
 *   唯一存下來的是 `completed_at` 與 `paused_at` —— 它們是事件，不是餘額。
 *
 * ★ 金額一律是**微美元**的整數（SQLite 的 INTEGER 是 64 位元）。新台幣只存捐款人實際付的整數金額與當時的匯率。
 *
 * ## SQLite（libSQL）
 *
 * - 時間存成**毫秒整數**（`timestamp_ms`），程式裡拿到的是 `Date`；比較直接用 `lt(欄位, new Date())`
 * - 預設時間用 `$defaultFn`（由程式填），不靠資料庫的 `now()`
 * - 列舉是 `text` + CHECK 約束（SQLite 沒有 enum 型別）
 * - JSON 是 `text`（`mode: "json"`）；位元組是 `blob`
 * - 部分唯一索引（`WHERE status = 'SUCCEEDED'`）SQLite 也支援 ——「同一步只能成功一次」靠它
 */

import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type { MapParams } from "@/lib/world/params";
import type { Viewpoint } from "@/lib/world/prompts";

/**
 * 位元組。libSQL 讀回來是 `ArrayBuffer`，程式裡一律用 `Uint8Array`。
 * （drizzle 內建的 `blob({ mode: "buffer" })` 型別是 Node 的 `Buffer`，寫入 `Uint8Array` 會被型別擋下）
 */
const bytes = customType<{ data: Uint8Array; driverData: ArrayBuffer | Uint8Array }>({
  dataType() {
    return "blob";
  },
  toDriver(v) {
    return v;
  },
  fromDriver(v) {
    return v instanceof Uint8Array ? v : new Uint8Array(v);
  },
});

const micros = (name: string) => integer(name, { mode: "number" });
const id = () => integer("id", { mode: "number" }).primaryKey({ autoIncrement: true });
const ref = (name: string) => integer(name, { mode: "number" });
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => ts("created_at").notNull().$defaultFn(() => new Date());
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
/** 列舉：text + CHECK（在表的第二個參數裡加 `oneOf`） */
const oneOf = (name: string, col: unknown, values: readonly string[]) =>
  check(name, sql`${col} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`);

// ─────────────────────────────────────────────────────────────
// 區塊
// ─────────────────────────────────────────────────────────────

export const blocks = sqliteTable(
  "blocks",
  {
    id: id(),
    /** 西南角，例如 `25.03_121.56`（`lib/world/grid.ts` 的 `blockKey`） */
    key: text("key").notNull(),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    createdAt: createdAt(),

    /**
     * 勘查選出的標記座標。只有全景 ID、座標與朝向 ——
     * Google 允許無限期保存 pano ID，**不允許**保存影像，所以影像一張都不存。
     */
    viewpoints: json<Viewpoint[]>("viewpoints"),
    params: json<MapParams>("params"),
    /** 模型給的參數格式不對、經過修正 */
    paramsRepaired: integer("params_repaired", { mode: "boolean" }).notNull().default(false),

    completedAt: ts("completed_at"),
    /** 完成時從淨額撥出的保存與分攤（之前為 null） */
    storageAllocatedMicros: micros("storage_allocated_micros"),
    computeAllocatedMicros: micros("compute_allocated_micros"),

    /**
     * 施工租約。一個步驟要呼叫外部 API 幾十秒，不能拿著交易鎖等 ——
     * 所以用一個有期限的租約：拿到才施工，逾時自動失效（工作者當掉也不會永遠卡住）。
     */
    leaseUntil: ts("lease_until"),
    leaseHolder: text("lease_holder"),

    /** 連續失敗次數。成功一次就歸零 */
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    pausedAt: ts("paused_at"),
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

export const DONATION_STATUSES = ["PENDING", "PAID", "FAILED", "REFUNDED"] as const;

export const donations = sqliteTable(
  "donations",
  {
    id: id(),
    blockId: ref("block_id")
      .notNull()
      .references(() => blocks.id),
    /** Auth.js 的使用者 id */
    donorId: text("donor_id").notNull(),
    status: text("status", { enum: DONATION_STATUSES }).notNull().default("PENDING"),

    /** 捐款人付的新台幣（整數元） */
    amountTwd: integer("amount_twd").notNull(),
    /** 入帳時的匯率快照（新台幣／美元） */
    twdPerUsd: real("twd_per_usd").notNull(),

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
    createdAt: createdAt(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    index("donations_block_idx").on(t.blockId, t.status),
    index("donations_donor_idx").on(t.donorId),
    uniqueIndex("donations_processor_ref_uq").on(t.processor, t.processorRef),
    check("donations_amount_positive", sql`${t.amountTwd} > 0`),
    oneOf("donations_status_known", t.status, DONATION_STATUSES),
    check("donations_vote_known", sql`${t.vote} IS NULL OR ${t.vote} IN ('google','openai')`),
  ],
);

// ─────────────────────────────────────────────────────────────
// 施工紀錄
// ─────────────────────────────────────────────────────────────

export const STEP_STATUSES = ["SUCCEEDED", "FAILED"] as const;

export const steps = sqliteTable(
  "steps",
  {
    id: id(),
    blockId: ref("block_id")
      .notNull()
      .references(() => blocks.id),
    /** 在施工計畫裡的位置（`plan.planSteps` 的索引） */
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    kindIndex: integer("kind_index").notNull().default(0),
    status: text("status", { enum: STEP_STATUSES }).notNull(),

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
    tally: json<{ weights: Record<string, number>; ranking: string[] }>("tally"),

    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    note: text("note"),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at").notNull(),
  },
  (t) => [
    index("steps_block_idx").on(t.blockId, t.seq),
    /** 一個位置只能成功一次 —— 兩個工作者搶到同一步時，第二個寫不進來 */
    uniqueIndex("steps_block_seq_succeeded_uq")
      .on(t.blockId, t.seq)
      .where(sql`status = 'SUCCEEDED'`),
    oneOf("steps_status_known", t.status, STEP_STATUSES),
    index("steps_observed_idx").on(t.provider, t.kind, t.id).where(sql`status = 'SUCCEEDED'`),
  ],
);

// ─────────────────────────────────────────────────────────────
// 產出
// ─────────────────────────────────────────────────────────────

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: id(),
    blockId: ref("block_id")
      .notNull()
      .references(() => blocks.id),
    stepId: ref("step_id")
      .notNull()
      .references(() => steps.id),
    kind: text("kind").notNull(),
    kindIndex: integer("kind_index").notNull().default(0),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    data: bytes("data").notNull(),
    thumb: bytes("thumb").notNull(),
    /** 例：材質名稱、標記座標的說明 */
    label: text("label"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("artifacts_block_kind_uq").on(t.blockId, t.kind, t.kindIndex)],
);

// ─────────────────────────────────────────────────────────────
// 長期保存：場景包 → Boltchain SwarmStorage
// ─────────────────────────────────────────────────────────────

/**
 * 場景包裡圖以外的檔案。**第一次打包時寫入，之後永不改寫** ——
 * 檢視器與清單的程式之後會改版，但已發布的包必須永遠重建得出同一個 CID。
 * 圖本身不重複存：它們就是 `artifacts` 的位元組。
 */
export const sceneFiles = sqliteTable(
  "scene_files",
  {
    blockId: ref("block_id")
      .notNull()
      .references(() => blocks.id),
    path: text("path").notNull(),
    data: bytes("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blockId, t.path] })],
);

export const ARCHIVE_STATUSES = ["PACKED", "STORED", "DONE"] as const;

export const sceneArchives = sqliteTable(
  "scene_archives",
  {
    id: id(),
    blockId: ref("block_id")
      .notNull()
      .references(() => blocks.id),
    /** 場景包（UnixFS 目錄）的根 CID —— 任何人都能用 `ipfs add` 重算 */
    sceneCid: text("scene_cid").notNull(),
    /** Boltchain 委託索引（dag-cbor）的根 CID；鏈上記的就是它 */
    dealIndexCid: text("deal_index_cid").notNull(),
    /** 委託索引列出的區塊數與位元組數（不含索引自己） */
    blockCount: integer("block_count").notNull(),
    bytes: ref("bytes").notNull(),
    /** PACKED：打包好、還沒有保存委託；STORED：有委託在保存中；DONE：保存期滿 */
    status: text("status", { enum: ARCHIVE_STATUSES }).notNull().default("PACKED"),
    /** 保存到什麼時候（完工 + 保存月數） */
    retainUntil: ts("retain_until").notNull(),
    lastError: text("last_error"),
    /** 失敗後不要每分鐘重試 */
    nextAttemptAt: ts("next_attempt_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scene_archives_block_uq").on(t.blockId), oneOf("scene_archives_status_known", t.status, ARCHIVE_STATUSES)],
);

export const DEAL_STATUSES = ["SUBMITTED", "ACTIVE", "FAILED"] as const;

export const sceneDeals = sqliteTable(
  "scene_deals",
  {
    id: id(),
    archiveId: ref("archive_id")
      .notNull()
      .references(() => sceneArchives.id),
    /** `boltchain:<chainId>` 或 `demo` */
    network: text("network").notNull(),
    status: text("status", { enum: DEAL_STATUSES }).notNull(),
    txHash: text("tx_hash").notNull(),
    /** 合約的委託編號（uint256，十進位字串）。交易確認前為 null */
    dealId: text("deal_id"),
    replicas: integer("replicas").notNull(),
    epochs: integer("epochs").notNull(),
    /** wei / GiB / epoch（十進位字串） */
    priceWei: text("price_wei").notNull(),
    /** 送出的託管款（wei，十進位字串） */
    costWei: text("cost_wei").notNull(),
    startEpoch: ref("start_epoch"),
    endEpoch: ref("end_epoch"),
    /** 最近一次讀到的副本狀態：[{provider, since, paidThrough, open}] */
    slots: json<{ provider: number; since: number; paidThrough: number; open: boolean }[]>("slots"),
    checkedAt: ts("checked_at"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("scene_deals_tx_uq").on(t.network, t.txHash),
    index("scene_deals_archive_idx").on(t.archiveId),
    oneOf("scene_deals_status_known", t.status, DEAL_STATUSES),
  ],
);
