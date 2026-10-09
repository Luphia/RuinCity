/**
 * 依環境變數組出 SwarmStorage 用戶端。**伺服器專用**：私鑰只在這裡讀。
 *
 * | 變數 | 作用 |
 * | --- | --- |
 * | `BOLT_RPC_URL` | Boltchain JSON-RPC（送交易、讀合約） |
 * | `BOLT_STORAGE_RPC_URL` | 平台節點開了 `--rpc-storage` 的 RPC（`bolt_hostBlocks`）；預設同上 |
 * | `BOLT_PRIVATE_KEY` | 付託管款的平台錢包（0x 開頭的 32 位元組十六進位） |
 * | `BOLT_CHAIN_ID` | 預設 8018（公開測試網） |
 * | `BOLT_GATEWAYS` | 公開的 Boltchain 閘道，逗號分隔（畫面上「從 Boltchain 取回」的連結） |
 * | `SWARM_MODE=demo` | 不上鏈的示範保存（`FAKE_PROVIDERS=1` 且沒設 Boltchain 時也是這個） |
 *
 * 設了 Boltchain 就一定用真的（即使 `FAKE_PROVIDERS=1`：示範畫師 + 真的保存，本機整合測試就是這樣跑的）。
 * 都沒設 → null：場景包照樣打包、照樣能從網站下載與驗證，只是沒有付費的異地副本。
 */

import "server-only";

import type { Hex } from "viem";

import { boltchainClient, demoSwarmClient, type SwarmClient } from "./client";

type Env = Record<string, string | undefined>;

export function swarmClient(env: Env = process.env, epochSeconds = 3_600): SwarmClient | null {
  const rpcUrl = env.BOLT_RPC_URL;
  const key = env.BOLT_PRIVATE_KEY;
  if (env.SWARM_MODE === "demo" || (!rpcUrl && env.FAKE_PROVIDERS === "1")) return demoSwarmClient(epochSeconds);
  if (!rpcUrl || !key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("BOLT_PRIVATE_KEY 必須是 0x 開頭的 64 位十六進位");
  const chainId = Number(env.BOLT_CHAIN_ID ?? "8018");
  return boltchainClient({
    rpcUrl,
    storageRpcUrl: env.BOLT_STORAGE_RPC_URL || undefined,
    chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : 8018,
    privateKey: key as Hex,
    gateways: (env.BOLT_GATEWAYS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  });
}

/** 畫面用：公開的閘道（示範模式沒有） */
export function swarmGateways(env: Env = process.env): string[] {
  if (env.SWARM_MODE === "demo" || !env.BOLT_RPC_URL) return [];
  return (env.BOLT_GATEWAYS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}
