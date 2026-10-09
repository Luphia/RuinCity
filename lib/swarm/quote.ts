/**
 * SwarmStorage 的計價與期間。純函式，無 I/O —— 預算書（估計）與上鏈（實付）用同一份算式。
 *
 * 合約（`SwarmStorage.createDeal`）的算法，逐字照抄：
 *
 *     MiB      = ceil(size / 2^20)
 *     perEpoch = ceil(price × MiB / 1024)          // wei，每個副本每個 epoch
 *     escrow   = perEpoch × replicas × epochs
 *
 * ★ 一筆委託的**總長度**（含之後的 extendDeal）不能超過 `MAX_DEAL_EPOCHS`（3,650）。
 *   公開測試網一個 epoch 約 1 小時，四年 ≈ 35,000 個 epoch —— 遠超過一筆委託的上限。
 *   所以四年保存是**一串接力的委託**（同一個委託索引，到期前開下一筆），不是一直延長同一筆。
 */

export const MAX_DEAL_EPOCHS = 3_650;
export const MAX_REPLICAS = 16;
export const WEI_PER_BOLT = 10n ** 18n;

/** 「0.25」BOLT → wei（不經過浮點數） */
export function boltToWei(bolt: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,18}))?$/.exec(bolt.trim());
  if (!m) throw new Error(`不是合法的 BOLT 數量：${bolt}`);
  return BigInt(m[1]!) * WEI_PER_BOLT + BigInt((m[2] ?? "").padEnd(18, "0") || "0");
}

export function weiToBolt(wei: bigint, digits = 6): string {
  const whole = wei / WEI_PER_BOLT;
  const frac = (wei % WEI_PER_BOLT).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function dealCost(input: { sizeBytes: number; replicas: number; epochs: number; priceWei: bigint }): {
  mib: bigint;
  perEpochWei: bigint;
  totalWei: bigint;
} {
  const mib = (BigInt(input.sizeBytes) + (1n << 20n) - 1n) >> 20n;
  const perEpochWei = (input.priceWei * mib + 1023n) / 1024n;
  return { mib, perEpochWei, totalWei: perEpochWei * BigInt(input.replicas) * BigInt(input.epochs) };
}

/** 保存 `months` 個月需要幾個 epoch（一個月以 30.436875 天計） */
export function epochsFor(months: number, epochSeconds: number): number {
  return Math.ceil((months * 30.436875 * 86_400) / epochSeconds);
}

/** 總共要保存的 epoch 數 → 一串委託，各自不超過上限 */
export function dealChain(totalEpochs: number): number[] {
  const out: number[] = [];
  for (let left = totalEpochs; left > 0; left -= MAX_DEAL_EPOCHS) out.push(Math.min(MAX_DEAL_EPOCHS, left));
  return out;
}

/** 平台用的 SwarmStorage 參數（`lib/server/config.ts` 從環境變數讀） */
export interface SwarmTerms {
  /** 副本數（1–16） */
  readonly replicas: number;
  /** 出價：BOLT / GiB / epoch（字串，避免浮點） */
  readonly priceBolt: string;
  /** 一個 epoch 幾秒（公開測試網 PoS 階段約 3,600） */
  readonly epochSeconds: number;
  /** 保存幾個月 */
  readonly months: number;
  /** 下一筆委託要在前一筆結束前幾個 epoch 開好（給新保存者取資料的時間） */
  readonly renewLeadEpochs: number;
}

export function quoteRetention(sizeBytes: number, t: SwarmTerms) {
  const epochs = epochsFor(t.months, t.epochSeconds);
  const chain = dealChain(epochs);
  const priceWei = boltToWei(t.priceBolt);
  const totalWei = chain.reduce((s, e) => s + dealCost({ sizeBytes, replicas: t.replicas, epochs: e, priceWei }).totalWei, 0n);
  return { epochs, deals: chain.length, priceWei, totalWei };
}

/** 1 GiB 是多少 GB（S3 以 10^9 計價，合約以 2^30 計價） */
export const GB_PER_GIB = 2 ** 30 / 1e9;

/**
 * S3 parity 的出價：讓每一個副本每個 epoch 拿到的錢，等於同樣容量放在 S3 同樣時間的價格。
 *   BOLT / GiB / epoch = 美元/GB/月 × GB/GiB × (epoch 秒數 / 一個月秒數) ÷ 美元/BOLT
 */
export function s3ParityPriceBolt(usdPerGbMonth: number, epochSeconds: number, boltUsd: number): number {
  if (!(boltUsd > 0)) throw new Error("boltUsd 必須大於 0");
  return (usdPerGbMonth * GB_PER_GIB * (epochSeconds / (30.436875 * 86_400))) / boltUsd;
}
