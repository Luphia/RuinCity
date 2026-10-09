/**
 * 伺服器端設定：預算參數（環境變數可覆寫）。
 *
 * 每一個參數的預設值與理由在 `lib/world/budget.ts` 的 `BudgetConfig`。
 * 這裡只負責「從環境變數讀、讀不到或不合理就用預設」——
 * 一個打錯的環境變數不該讓整份預算書變成 NaN。
 */

import "server-only";

import { DEFAULT_BUDGET_CONFIG, type BudgetConfig } from "@/lib/world/budget";

type Env = Record<string, string | undefined>;

const ENV_NAME: Record<keyof BudgetConfig, string> = {
  twdPerUsd: "TWD_PER_USD",
  paymentFeeRate: "PAYMENT_FEE_RATE",
  paymentFeeFixedTwd: "PAYMENT_FEE_FIXED_TWD",
  taxRate: "TAX_RATE",
  chargebackRate: "CHARGEBACK_RATE",
  avgDonationTwd: "AVG_DONATION_TWD",
  storageUsdPerGbMonth: "STORAGE_USD_PER_GB_MONTH",
  storageReplicas: "STORAGE_REPLICAS",
  swarmReplicas: "SWARM_REPLICAS",
  swarmPriceBolt: "SWARM_PRICE_BOLT",
  swarmEpochSeconds: "SWARM_EPOCH_SECONDS",
  boltUsd: "BOLT_USD",
  boltGasPerDeal: "BOLT_GAS_PER_DEAL",
  retentionMonths: "RETENTION_MONTHS",
  egressUsdPerGb: "EGRESS_USD_PER_GB",
  expectedViews: "EXPECTED_VIEWS_PER_BLOCK",
  viewPayloadMb: "VIEW_PAYLOAD_MB",
  computeUsdPerBlock: "COMPUTE_USD_PER_BLOCK",
  platformFeeRate: "PLATFORM_FEE_RATE",
  retryReserveRate: "RETRY_RESERVE_RATE",
  volatilityRate: "VOLATILITY_RATE",
};

/** 比率類的參數必須在 [0, 1) */
const RATE_KEYS: readonly (keyof BudgetConfig)[] = [
  "paymentFeeRate",
  "taxRate",
  "chargebackRate",
  "platformFeeRate",
  "retryReserveRate",
  "volatilityRate",
];

/** 為 0 就沒有意義（除以零、或保存零份）的參數 */
const NONZERO_KEYS: readonly (keyof BudgetConfig)[] = [
  "twdPerUsd",
  "avgDonationTwd",
  "storageReplicas",
  "swarmReplicas",
  "swarmPriceBolt",
  "swarmEpochSeconds",
];

export function budgetConfig(env: Env = process.env): BudgetConfig {
  const out: Record<string, number> = { ...DEFAULT_BUDGET_CONFIG };
  for (const key of Object.keys(ENV_NAME) as (keyof BudgetConfig)[]) {
    const raw = env[ENV_NAME[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) continue;
    if (RATE_KEYS.includes(key) && v >= 1) continue;
    if (NONZERO_KEYS.includes(key) && v === 0) continue;
    if (key === "swarmReplicas" && (v > 16 || !Number.isInteger(v))) continue;
    out[key] = v;
  }
  return out as unknown as BudgetConfig;
}

/** 單筆捐款的上下限（新台幣）。下限避免手續費比捐款還多 */
export const DONATION_MIN_TWD = 30;
export const DONATION_MAX_TWD = 100_000;
