/**
 * 一塊地圖的**預算書**。純函式，無 I/O。
 *
 * 施工中的地圖不能進入，捐款人能看到的只有錢與 token —— 所以每一分錢花在哪裡
 * 都要能在這份預算書上找到一行，而且每一行都要寫出**怎麼算的**。
 *
 * ## 五組支出
 *
 * | 組 | 項目 | 依據 |
 * | --- | --- | --- |
 * | 建設 | 地圖參數、標記座標場景圖 ×100、正射底圖、3D 圖資、材質貼圖 ×8 | 各步驟 token × 該模型費率（`pricing.ts`） |
 * | 參考資料 | Street View 影像、地圖靜態圖 | Google Maps Platform 每次請求計價 |
 * | 預備 | 失敗重試、匯率與價格波動 | 只對**還沒做**的步驟提列；完成後沒用完的列為結餘 |
 * | 保存與營運 | 四年保存（兩份副本 + 傳輸）、伺服器與資料庫分攤、平台管理費（0%） | 預估容量 × 儲存單價 × 48 個月 |
 * | 收款成本 | 金流手續費、營業稅、退款與拒付準備 | 依**募款總額**計，所以目標金額要倒推回來（gross-up） |
 *
 * ## 四個主要數字（施工中的地圖只顯示這四個）
 *
 * - **預計所需 Token**：建設各步驟的 token（已完成的取實際、剩下的取估計）
 * - **換算金額**：完成這一塊需要的**募款總額**（含以上全部五組）
 * - **已花費 Token**：實際用掉的 token（含失敗重來的）
 * - **已花費金額**：實際花掉的錢（token、參考影像、手續費、稅、準備金、已撥付的保存費）
 */

import { MICROS_PER_USD, toMicros } from "./ledger";
import {
  addKind,
  emptyKindTotals,
  estimateRemaining,
  type KindTotals,
  type Observed,
  type Picker,
  type PlannedStep,
} from "./plan";
import { PAID_STEP_KINDS, type PaidStepKind } from "./pricing";

/**
 * 預算參數。預設值的理由都寫在旁邊；部署時以環境變數覆寫（`lib/server/config.ts`）。
 *
 * ★ 稅與金流的數字**不是法律或會計意見**。它們是合理的起點，
 *   上線前要由會計師依營運主體的實際身分（公司、協會、個人）確認。
 */
export interface BudgetConfig {
  /** 新台幣兌美元。每筆捐款入帳時快照 */
  readonly twdPerUsd: number;
  /** 金流手續費率。台灣第三方支付的信用卡費率約 2.4%–3.5%，取 2.8% */
  readonly paymentFeeRate: number;
  /** 每筆固定費（金流固定費 + 電子發票／收據開立費），新台幣 */
  readonly paymentFeeFixedTwd: number;
  /** 稅金與規費率。預設 5% = 營業稅（營業人收取的贊助款屬銷售額）；免稅主體設 0 */
  readonly taxRate: number;
  /** 退款與拒付準備率（信用卡爭議款、誤捐退款） */
  readonly chargebackRate: number;
  /** 平均每筆捐款（新台幣），只拿來估「要收幾筆」→ 每筆固定費的總額 */
  readonly avgDonationTwd: number;
  /** 物件儲存單價（美元／GB／月）。預設 0.015 ≈ Cloudflare R2 標準儲存 */
  readonly storageUsdPerGbMonth: number;
  /** 保存副本數：主存放 + 一份異地備份 */
  readonly storageReplicas: number;
  /** 保存月數：4 年 */
  readonly retentionMonths: number;
  /** 傳輸單價（美元／GB）。R2 出口免費，留一點給 CDN 與請求次數費 */
  readonly egressUsdPerGb: number;
  /** 四年內預估被瀏覽幾次（每次載入底圖、3D、材質與部分場景圖） */
  readonly expectedViews: number;
  /** 一次瀏覽平均載入多少 MB */
  readonly viewPayloadMb: number;
  /** 伺服器運算與資料庫分攤（美元／塊）：施工排程、影像轉檔、帳務與四年的資料庫列 */
  readonly computeUsdPerBlock: number;
  /** 平台管理費率。預設 0 —— 捐款全數用在這一塊上；營運方若要收，在這裡明列 */
  readonly platformFeeRate: number;
  /** 失敗重試準備（剩餘 token 成本的比例）。被擋、截斷、沒回圖的那一次照樣計費 */
  readonly retryReserveRate: number;
  /** 匯率與價格波動緩衝（剩餘建設成本的比例）。成本是美元、捐款是台幣，模型也可能在施工中漲價 */
  readonly volatilityRate: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  twdPerUsd: 32,
  paymentFeeRate: 0.028,
  paymentFeeFixedTwd: 5,
  taxRate: 0.05,
  chargebackRate: 0.01,
  avgDonationTwd: 300,
  storageUsdPerGbMonth: 0.015,
  storageReplicas: 2,
  retentionMonths: 48,
  egressUsdPerGb: 0.01,
  expectedViews: 2000,
  viewPayloadMb: 5,
  computeUsdPerBlock: 0.25,
  platformFeeRate: 0,
  retryReserveRate: 0.1,
  volatilityRate: 0.05,
};

/**
 * 每一種產出存起來多大（WebP + 縮圖，位元組）。
 * 依 `providers/image.ts` 的輸出尺寸實測量級取整，寧可估大。
 */
export const ARTIFACT_BYTES: Readonly<Record<PaidStepKind, number>> = {
  PARAMS: 40_000, // JSON
  SCENE: 300_000, // 1536×864 WebP + 384 寬縮圖
  TILE: 500_000, // 1024² 以上 WebP + 縮圖
  DSM: 400_000, // 灰階高度圖（無損）
  TEXTURE: 450_000, // 1024² 可平鋪貼圖
};

/** 資料庫裡的帳務、施工紀錄等每塊的固定量 */
export const METADATA_BYTES = 200_000;

export type BudgetGroup =
  | "construction"
  | "reference"
  | "contingency"
  | "operations"
  | "collection"
  | "surplus";

export const GROUP_LABEL: Record<BudgetGroup, string> = {
  construction: "建設（Token）",
  reference: "參考資料",
  contingency: "預備",
  operations: "保存與營運",
  collection: "收款成本",
  surplus: "結餘",
};

export interface BudgetLine {
  readonly key: string;
  readonly group: BudgetGroup;
  readonly label: string;
  /** 這一行怎麼算的（顯示給捐款人看） */
  readonly basis: string;
  readonly tokensProjected: number;
  readonly tokensActual: number;
  /** 預計（已發生的取實際 + 未發生的取估計） */
  readonly microsProjected: number;
  readonly microsActual: number;
}

export interface BudgetInput {
  readonly steps: readonly PlannedStep[];
  /** 已完成幾步（前綴） */
  readonly done: number;
  readonly pick: Picker;
  readonly observed?: Observed;
  /** 實際用量 */
  readonly actual: {
    /** 成功的步驟 */
    readonly byKind: Record<PaidStepKind, KindTotals>;
    /** 失敗的嘗試（不在 byKind 裡）：token 數與花掉的錢（token 成本 + 參考影像費） */
    readonly failed: { readonly tokens: number; readonly micros: number };
  };
  /** 已入帳的捐款合計 */
  readonly received: {
    readonly count: number;
    readonly grossMicros: number;
    readonly feeMicros: number;
    readonly taxMicros: number;
    readonly chargebackMicros: number;
  };
  /** 完成時才撥付的保存與分攤（撥付前為 null） */
  readonly allocated: { readonly storageMicros: number; readonly computeMicros: number } | null;
  readonly config: BudgetConfig;
}

export interface Budget {
  readonly lines: readonly BudgetLine[];
  readonly meters: {
    readonly tokensNeeded: number;
    /** 完成這一塊需要的募款總額 */
    readonly grossNeededMicros: number;
    readonly tokensSpent: number;
    readonly moneySpentMicros: number;
  };
  readonly grossReceivedMicros: number;
  readonly netReceivedMicros: number;
  /** 已募得超過所需的部分（預計結餘）；不算進 `meters.grossNeededMicros` */
  readonly surplusProjectedMicros: number;
  /** 還要再募多少（總額） */
  readonly grossGapMicros: number;
  /** 圈出來的保存與分攤（完成前為估計，完成後為實際撥付） */
  readonly ringFencedMicros: number;
  /** 能拿來施工的餘額 */
  readonly constructionBalanceMicros: number;
  /** 下一步的估價（token + 參考影像費）；沒有下一步為 null */
  readonly nextStepMicros: number | null;
  /** 完成後沒用完的錢 */
  readonly surplusMicros: number;
}

const KIND_LABEL: Record<PaidStepKind, string> = {
  PARAMS: "地圖參數",
  SCENE: "標記座標場景圖",
  TILE: "正射地圖底圖",
  DSM: "3D 圖資（數值地表高度圖）",
  TEXTURE: "材質貼圖",
};

const KIND_BASIS: Record<PaidStepKind, string> = {
  PARAMS: "看版型與 4 張代表性街景，寫出地貌、水位、植被、材質清單與每個標記的說明（JSON）",
  SCENE: "每個標記座標一張「一千年後」的地面景像，以該點的街景為構圖參考",
  TILE: "俯視、北朝上、剛好框住這一塊的正射影像，地圖上看到的就是它",
  DSM: "灰階高度圖（含地形、殘骸與樹冠），與底圖疊合即成 3D 地景",
  TEXTURE: "參數裡列出的材質（例：苔蘚混凝土、淹水柏油），各一張可平鋪貼圖，供 3D 地景使用",
};

/**
 * 從淨額倒推募款總額。
 *
 * 總額 g 要滿足：g − 手續費(g) − 稅(g) − 準備(g) = 淨額。
 * 手續費有每筆固定費，筆數又取決於 g —— 迭代兩次就收斂（筆數是整數）。
 */
export function grossUp(netMicros: number, config: BudgetConfig): { gross: number; donations: number } {
  if (netMicros <= 0) return { gross: 0, donations: 0 };
  const rate = config.paymentFeeRate + config.taxRate + config.chargebackRate;
  const keep = 1 - rate;
  if (keep <= 0) throw new Error("手續費率 + 稅率 + 準備率 ≥ 100%，募不到任何淨額");
  const fixed = toMicros(config.paymentFeeFixedTwd, config.twdPerUsd);
  const avg = toMicros(config.avgDonationTwd, config.twdPerUsd);
  let gross = netMicros / keep;
  let n = 1;
  for (let i = 0; i < 4; i++) {
    n = Math.max(1, Math.ceil(gross / avg));
    gross = (netMicros + n * fixed) / keep;
  }
  return { gross: Math.ceil(gross), donations: n };
}

/** 四年保存費：容量 × 副本 × 單價 × 月數 + 瀏覽傳輸 */
export function storageMicros(artifactCounts: Record<PaidStepKind, number>, config: BudgetConfig): {
  micros: number;
  bytes: number;
} {
  let bytes = METADATA_BYTES;
  for (const k of PAID_STEP_KINDS) bytes += ARTIFACT_BYTES[k] * artifactCounts[k];
  const gb = bytes / 1e9;
  const storeUsd = gb * config.storageReplicas * config.storageUsdPerGbMonth * config.retentionMonths;
  const egressUsd = (config.expectedViews * config.viewPayloadMb * 1e6 * config.egressUsdPerGb) / 1e9;
  return { micros: Math.ceil((storeUsd + egressUsd) * MICROS_PER_USD), bytes };
}

export function buildBudget(input: BudgetInput): Budget {
  const { config } = input;
  const remaining = estimateRemaining(input.steps, input.done, input.pick, input.observed);

  // 每一種步驟：已發生的 + 還沒做的
  const counts = Object.fromEntries(PAID_STEP_KINDS.map((k) => [k, 0])) as Record<PaidStepKind, number>;
  for (const s of input.steps) if (s.kind !== "SURVEY") counts[s.kind]++;

  const lines: BudgetLine[] = [];
  let tokensProjected = 0;
  let tokensActual = 0;
  let tokenMicrosActual = 0;
  let referenceActual = 0;
  let referenceProjected = 0;

  const projectedByKind = emptyKindTotals();
  for (const k of PAID_STEP_KINDS) {
    const a = input.actual.byKind[k];
    const r = remaining.byKind[k];
    projectedByKind[k] = addKind(a, { ...r, count: r.count });
    tokensActual += a.tokens;
    tokenMicrosActual += a.tokenMicros;
    referenceActual += a.referenceMicros;
    referenceProjected += a.referenceMicros + r.referenceMicros;
    const p = projectedByKind[k];
    tokensProjected += p.tokens;
    if (counts[k] === 0 && a.count === 0) continue;
    lines.push({
      key: `construction.${k}`,
      group: "construction",
      label: counts[k] > 1 ? `${KIND_LABEL[k]} ×${counts[k]}` : KIND_LABEL[k],
      basis: KIND_BASIS[k],
      tokensProjected: p.tokens,
      tokensActual: a.tokens,
      microsProjected: p.tokenMicros,
      microsActual: a.tokenMicros,
    });
  }

  tokensActual += input.actual.failed.tokens;
  tokensProjected += input.actual.failed.tokens;

  const sceneRefs = counts.SCENE + (counts.PARAMS > 0 ? 4 : 0);
  const mapRefs = counts.TILE + counts.DSM + counts.PARAMS;
  lines.push({
    key: "reference",
    group: "reference",
    label: "參考影像費",
    basis: `Street View 影像 ${sceneRefs} 張（每千張 US$7）、地圖靜態圖 ${mapRefs} 張（每千張 US$2）；勘查用的 metadata 查詢免費`,
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: referenceProjected,
    microsActual: referenceActual,
  });

  // ── 預備：只對還沒做的部分提列 ──
  const retryProjected = Math.ceil(remaining.tokenMicros * config.retryReserveRate);
  const retryActual = input.actual.failed.micros;
  lines.push({
    key: "contingency.retry",
    group: "contingency",
    label: "失敗重試準備",
    basis: `剩餘 token 成本的 ${pct(config.retryReserveRate)}。內容被擋、輸出截斷、沒有回圖的那一次照樣計費；「實際」欄是已經失敗掉的花費`,
    tokensProjected: input.actual.failed.tokens,
    tokensActual: input.actual.failed.tokens,
    microsProjected: retryActual + retryProjected,
    microsActual: retryActual,
  });
  const volatility = Math.ceil((remaining.tokenMicros + remaining.referenceMicros) * config.volatilityRate);
  lines.push({
    key: "contingency.volatility",
    group: "contingency",
    label: "匯率與價格波動緩衝",
    basis: `剩餘建設成本的 ${pct(config.volatilityRate)}。成本以美元計、捐款以新台幣收，模型也可能在施工期間調價；沒用到的列入結餘`,
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: volatility,
    microsActual: 0,
  });

  // ── 保存與營運 ──
  const storage = storageMicros(counts, config);
  const computeMicros = Math.ceil(config.computeUsdPerBlock * MICROS_PER_USD);
  lines.push({
    key: "operations.storage",
    group: "operations",
    label: "地圖資料 4 年保存",
    basis: `約 ${(storage.bytes / 1e6).toFixed(1)} MB × ${config.storageReplicas} 份副本 × ${config.retentionMonths} 個月 × US$${config.storageUsdPerGbMonth}/GB‧月，加上 ${config.expectedViews.toLocaleString("en-US")} 次瀏覽的傳輸費；完成時一次撥入保存基金`,
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: input.allocated?.storageMicros ?? storage.micros,
    microsActual: input.allocated?.storageMicros ?? 0,
  });
  lines.push({
    key: "operations.compute",
    group: "operations",
    label: "伺服器運算與資料庫分攤",
    basis: "施工排程、影像轉檔與縮圖、帳務紀錄，以及四年的資料庫保存；每塊固定分攤",
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: input.allocated?.computeMicros ?? computeMicros,
    microsActual: input.allocated?.computeMicros ?? 0,
  });

  const ringFenced = input.allocated
    ? input.allocated.storageMicros + input.allocated.computeMicros
    : storage.micros + computeMicros;

  // 淨額需求（不含收款成本）
  const constructionProjected = PAID_STEP_KINDS.reduce((s, k) => s + projectedByKind[k].tokenMicros, 0);
  const netBeforePlatform =
    constructionProjected + referenceProjected + retryActual + retryProjected + volatility + ringFenced;
  const platformFee = Math.ceil(netBeforePlatform * config.platformFeeRate);
  lines.push({
    key: "operations.platform",
    group: "operations",
    label: "平台管理費",
    basis:
      config.platformFeeRate > 0
        ? `以上合計的 ${pct(config.platformFeeRate)}`
        : "0% —— 捐款全數用在這一塊上，營運方不另抽成",
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: platformFee,
    microsActual: 0,
  });
  const netNeeded = netBeforePlatform + platformFee;

  // ── 收款成本：已收的取實際，還要收的倒推 ──
  const r = input.received;
  const netReceived = r.grossMicros - r.feeMicros - r.taxMicros - r.chargebackMicros;
  const extraNet = Math.max(0, netNeeded - netReceived);
  const { gross: extraGross, donations: extraCount } = grossUp(extraNet, config);
  const extraFee =
    extraGross > 0
      ? Math.round(extraGross * config.paymentFeeRate) +
        extraCount * toMicros(config.paymentFeeFixedTwd, config.twdPerUsd)
      : 0;
  const extraTax = Math.round(extraGross * config.taxRate);
  const extraChargeback = Math.round(extraGross * config.chargebackRate);
  lines.push({
    key: "collection.fee",
    group: "collection",
    label: "金流手續費",
    basis: `募款總額的 ${pct(config.paymentFeeRate)} + 每筆 NT$${config.paymentFeeFixedTwd}（含電子收據開立）；已收的以金流商實際扣款為準`,
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: r.feeMicros + extraFee,
    microsActual: r.feeMicros,
  });
  lines.push({
    key: "collection.tax",
    group: "collection",
    label: "稅金與規費",
    basis:
      config.taxRate > 0
        ? `募款總額的 ${pct(config.taxRate)}（營業稅）。實際適用依營運主體身分，由會計師確認`
        : "營運主體免稅，不提列",
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: r.taxMicros + extraTax,
    microsActual: r.taxMicros,
  });
  lines.push({
    key: "collection.chargeback",
    group: "collection",
    label: "退款與拒付準備",
    basis: `募款總額的 ${pct(config.chargebackRate)}。信用卡爭議款與誤捐退款由此支應，期滿未動用的併入保存基金`,
    tokensProjected: 0,
    tokensActual: 0,
    microsProjected: r.chargebackMicros + extraChargeback,
    microsActual: r.chargebackMicros,
  });

  // 已募得超過所需：多的錢列為結餘，讓各行加起來剛好等於募款總額
  const surplusProjected = Math.max(0, netReceived - netNeeded);
  if (surplusProjected > 0) {
    lines.push({
      key: "surplus",
      group: "surplus",
      label: "預計結餘",
      basis: "已募得超過所需。完成後保留在這一塊的帳上，作為日後整修或延長保存之用",
      tokensProjected: 0,
      tokensActual: 0,
      microsProjected: surplusProjected,
      microsActual: 0,
    });
  }

  /**
   * ★ 「所需」不含結餘：超募的時候，所需仍然是**蓋完這一塊要花的錢**，
   *   不是已經收到的錢。把結餘算進去的話，捐得愈多「所需」就愈高，
   *   而投票畫面上「若全部由它來畫約需 NT$…」會對每一家都顯示同一個數字。
   */
  const grossNeeded = r.grossMicros + extraGross - surplusProjected;
  const constructionSpent = tokenMicrosActual + referenceActual + retryActual;
  const constructionBalance = netReceived - ringFenced - constructionSpent;
  const allocatedSpent = input.allocated ? input.allocated.storageMicros + input.allocated.computeMicros : 0;
  const moneySpent =
    constructionSpent + r.feeMicros + r.taxMicros + r.chargebackMicros + allocatedSpent;
  const nextStepMicros = remaining.next ? remaining.next.tokenMicros + remaining.next.referenceMicros : null;

  return {
    lines,
    meters: {
      tokensNeeded: tokensProjected,
      grossNeededMicros: grossNeeded,
      tokensSpent: tokensActual,
      moneySpentMicros: moneySpent,
    },
    grossReceivedMicros: r.grossMicros,
    netReceivedMicros: netReceived,
    surplusProjectedMicros: surplusProjected,
    grossGapMicros: extraGross,
    ringFencedMicros: ringFenced,
    constructionBalanceMicros: constructionBalance,
    nextStepMicros,
    surplusMicros: input.allocated ? Math.max(0, netReceived - constructionSpent - allocatedSpent) : 0,
  };
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}
