/**
 * 正式環境的接線：環境變數 → 施工引擎與狀態推導要的依賴。**伺服器專用。**
 *
 * 測試不走這裡（它們直接組自己的依賴），所以這裡只有「從環境讀」這一件事。
 */

import "server-only";

import { getDb } from "@/lib/db";
import { withTransaction, type TxDb } from "@/lib/db/tx";
import type { Observed } from "@/lib/world/plan";
import { defaultProvider, enabledProviders, painterFor, referenceSource } from "@/lib/providers/registry";

import { swarmClient } from "@/lib/swarm/registry";

import type { ArchiveDeps } from "./archive";
import { loadObserved, type StateDeps } from "./blocks";
import type { BuilderDeps } from "./builder";
import { budgetConfig } from "./config";

export function db(): TxDb {
  return getDb() as unknown as TxDb;
}

/**
 * 全站實際用量的平均，快取五分鐘。
 * 每一次看區塊頁都掃三千列施工紀錄沒有必要 —— 平均值本來就變得很慢。
 */
let observedCache: { at: number; value: Observed } | null = null;
const OBSERVED_TTL_MS = 5 * 60 * 1000;

export async function stateDeps(): Promise<StateDeps> {
  const now = Date.now();
  if (!observedCache || now - observedCache.at > OBSERVED_TTL_MS) {
    observedCache = { at: now, value: await loadObserved(db()) };
  }
  return {
    enabled: enabledProviders(),
    fallback: defaultProvider(),
    config: budgetConfig(),
    observed: observedCache.value,
  };
}

export async function builderDeps(holder: string): Promise<BuilderDeps> {
  return {
    db: db(),
    tx: withTransaction,
    painterFor: (p) => painterFor(p),
    reference: referenceSource(),
    state: await stateDeps(),
    now: () => Date.now(),
    holder,
  };
}

export function archiveDeps(): ArchiveDeps {
  const config = budgetConfig();
  return {
    db: db(),
    tx: withTransaction,
    now: () => Date.now(),
    swarm: swarmClient(process.env, config.swarmEpochSeconds),
    config,
  };
}
