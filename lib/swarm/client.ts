/**
 * Boltchain SwarmStorage 用戶端。**伺服器專用**（拿著平台錢包的私鑰）。
 *
 * 一筆保存委託的流程（Boltchain ADR 0014 §5）：
 *
 * 1. `bolt_hostBlocks(委託索引, [[cid, bytes], …])`：把區塊交給**平台自己的** Boltchain 節點
 *    （那個節點要開 `--rpc-storage`，RPC 只綁內網）。節點逐一核對 CID 後存下，
 *    並在 storage topic 上公告三天：「這個委託的資料在我這裡」。
 * 2. `SwarmStorage.createDeal(索引 CID, 區塊數, 位元組, 副本數, epoch 數, 單價)`，附上託管款。
 *    合約從開放報價的提供者中隨機抽出保存者；他們來平台節點取走資料，之後每個 epoch 接受抽查。
 * 3. 交易確認後從 `DealCreated` 事件讀出委託編號。
 *
 * 之後任何人都能從任何 Boltchain 節點的閘道取回：`GET /ipfs/<委託索引>?format=car`。
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  parseAbi,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { CID } from "multiformats/cid";

import type { IpldBlock } from "@/lib/ipfs/pack";

export const SWARM_ADDRESS = "0xb017000000000000000000000000000000000005" as const;
export const CONSENSUS_ADDRESS = "0xb017000000000000000000000000000000000002" as const;

export const SWARM_ABI = parseAbi([
  "function createDeal(bytes root, uint64 blocks, uint64 size, uint8 replicas, uint64 epochs, uint128 price) payable returns (uint256 id)",
  "function deal(uint256 id) view returns (address owner, bytes root, uint64 blocks, uint64 size, uint8 replicas, uint64 startEpoch, uint64 endEpoch, uint128 price, uint128 perEpoch, uint256 escrow, bool closed)",
  "function dealSlots(uint256 id) view returns (uint32[] providers, uint64[] since, uint64[] paidThrough, bool[] open)",
  "event DealCreated(uint256 indexed id, address indexed owner, bytes root, uint64 blocks, uint64 size, uint8 replicas, uint64 startEpoch, uint64 endEpoch, uint128 price)",
  "error BadDeal()",
  "error NoProviders()",
  "error Underpaid()",
  "error DealOver()",
  "error NotOwner()",
]);

const CONSENSUS_ABI = parseAbi(["function currentEpoch() view returns (uint64)"]);

export interface DealSlot {
  readonly provider: number;
  readonly since: number;
  readonly paidThrough: number;
  readonly open: boolean;
}

export type DealReceipt =
  | { readonly state: "PENDING" }
  | { readonly state: "FAILED"; readonly error: string }
  | { readonly state: "ACTIVE"; readonly dealId: bigint; readonly startEpoch: number; readonly endEpoch: number };

export interface SwarmClient {
  /** `boltchain:<chainId>` 或 `demo` */
  readonly network: string;
  /** 公開的 Boltchain 閘道（給「怎麼取回」的連結用） */
  readonly gateways: readonly string[];
  host(dealIndex: CID, blocks: readonly IpldBlock[]): Promise<void>;
  currentEpoch(): Promise<number>;
  /** 送出交易，回傳交易雜湊（不等確認） */
  createDeal(args: {
    readonly dealIndex: CID;
    readonly blocks: number;
    readonly size: number;
    readonly replicas: number;
    readonly epochs: number;
    readonly priceWei: bigint;
    readonly valueWei: bigint;
  }): Promise<Hex>;
  receipt(txHash: Hex): Promise<DealReceipt>;
  slots(dealId: bigint): Promise<{ readonly closed: boolean; readonly endEpoch: number; readonly slots: DealSlot[] }>;
}

export class SwarmError extends Error {
  constructor(
    readonly code: "NO_PROVIDERS" | "UNDERPAID" | "BAD_DEAL" | "RPC" | "HOST",
    message: string,
  ) {
    super(message);
  }
}

/** 一次 `bolt_hostBlocks` 最多帶多少位元組（hex 之後加倍；節點的請求上限約 10 MiB） */
export const HOST_BATCH_BYTES = 3 * 1024 * 1024;

export function hostBatches(blocks: readonly IpldBlock[], limit = HOST_BATCH_BYTES): IpldBlock[][] {
  const out: IpldBlock[][] = [];
  let cur: IpldBlock[] = [];
  let size = 0;
  for (const b of blocks) {
    if (cur.length && size + b.bytes.length > limit) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(b);
    size += b.bytes.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

function explain(e: unknown): SwarmError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/NoProviders/.test(msg)) return new SwarmError("NO_PROVIDERS", "沒有符合單價與容量的提供者（調高 SWARM_PRICE_BOLT 或減少副本數）");
  if (/Underpaid/.test(msg)) return new SwarmError("UNDERPAID", "託管款不足");
  if (/BadDeal/.test(msg)) return new SwarmError("BAD_DEAL", "合約拒絕了委託參數");
  return new SwarmError("RPC", msg.split("\n")[0]!.slice(0, 300));
}

export function boltchainClient(opts: {
  readonly rpcUrl: string;
  /** 平台節點的 RPC（開了 --rpc-storage）。預設同 rpcUrl */
  readonly storageRpcUrl?: string;
  readonly chainId: number;
  readonly privateKey: Hex;
  readonly gateways?: readonly string[];
  readonly fetchImpl?: typeof fetch;
}): SwarmClient {
  const chain = defineChain({
    id: opts.chainId,
    name: `Boltchain ${opts.chainId}`,
    nativeCurrency: { name: "BOLT", symbol: "BOLT", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const account = privateKeyToAccount(opts.privateKey);
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  const wallet = createWalletClient({ chain, account, transport: http(opts.rpcUrl) });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const storageRpc = opts.storageRpcUrl ?? opts.rpcUrl;

  return {
    network: `boltchain:${opts.chainId}`,
    gateways: opts.gateways ?? [],

    async host(dealIndex, blocks) {
      let id = 1;
      for (const batch of hostBatches(blocks)) {
        const res = await fetchImpl(storageRpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: id++,
            method: "bolt_hostBlocks",
            params: [dealIndex.toString(), batch.map((b) => [b.cid.toString(), toHex(b.bytes)])],
          }),
        });
        if (!res.ok) throw new SwarmError("HOST", `bolt_hostBlocks HTTP ${res.status}`);
        const json = (await res.json()) as { result?: boolean; error?: { message?: string } };
        if (json.error || json.result !== true) {
          throw new SwarmError("HOST", `bolt_hostBlocks：${json.error?.message ?? "沒有回傳 true"}`);
        }
      }
    },

    async currentEpoch() {
      try {
        return Number(await pub.readContract({ address: CONSENSUS_ADDRESS, abi: CONSENSUS_ABI, functionName: "currentEpoch" }));
      } catch (e) {
        throw explain(e);
      }
    },

    async createDeal(a) {
      try {
        const args = [
          toHex(a.dealIndex.bytes),
          BigInt(a.blocks),
          BigInt(a.size),
          a.replicas,
          BigInt(a.epochs),
          a.priceWei,
        ] as const;
        // 先模擬：沒有提供者、單價太低之類的錯誤在這裡就讀得懂，不必花 gas 換一筆失敗的交易
        const { request } = await pub.simulateContract({
          address: SWARM_ADDRESS,
          abi: SWARM_ABI,
          functionName: "createDeal",
          args,
          value: a.valueWei,
          account,
        });
        // ★ 抽保存者用的是 `block.prevrandao`：估 gas 的那一塊與真正上鏈的那一塊抽法不同，
        //   重抽的次數也不同。照估計值送出會不時 out of gas（實測：用量 = 上限，回退），所以加倍。
        const gas = await pub.estimateContractGas({
          address: SWARM_ADDRESS,
          abi: SWARM_ABI,
          functionName: "createDeal",
          args,
          value: a.valueWei,
          account,
        });
        return await wallet.writeContract({ ...request, gas: gas * 2n + 100_000n });
      } catch (e) {
        throw explain(e);
      }
    },

    async receipt(txHash) {
      let r;
      try {
        r = await pub.getTransactionReceipt({ hash: txHash });
      } catch (e) {
        if (/could not be found|not found/i.test(e instanceof Error ? e.message : "")) return { state: "PENDING" };
        throw explain(e);
      }
      if (r.status !== "success") return { state: "FAILED", error: "交易被回退（reverted）" };
      for (const log of r.logs) {
        if (log.address.toLowerCase() !== SWARM_ADDRESS.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: SWARM_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === "DealCreated") {
            return {
              state: "ACTIVE",
              dealId: ev.args.id,
              startEpoch: Number(ev.args.startEpoch),
              endEpoch: Number(ev.args.endEpoch),
            };
          }
        } catch {
          // 其他事件
        }
      }
      return { state: "FAILED", error: "交易成功但沒有 DealCreated 事件" };
    },

    async slots(dealId) {
      try {
        const [d, s] = await Promise.all([
          pub.readContract({ address: SWARM_ADDRESS, abi: SWARM_ABI, functionName: "deal", args: [dealId] }),
          pub.readContract({ address: SWARM_ADDRESS, abi: SWARM_ABI, functionName: "dealSlots", args: [dealId] }),
        ]);
        const [providers, since, paidThrough, open] = s;
        return {
          closed: d[10],
          endEpoch: Number(d[6]),
          slots: providers.map((p, i) => ({
            provider: p,
            since: Number(since[i]),
            paidThrough: Number(paidThrough[i]),
            open: open[i]!,
          })),
        };
      } catch (e) {
        throw explain(e);
      }
    },
  };
}

/**
 * 示範用：不連任何鏈。區塊收下就算「保存」，委託立即生效。
 * 讓示範模式（與 E2E）走完整條保存流程，畫面上會標明這不是真的上鏈。
 *
 * 無狀態（伺服器重啟、多個執行個體都不影響）：交易雜湊本身就編碼了委託的內容 ——
 *   0x | 起始 epoch (16) | epoch 數 (8) | 副本數 (4) | 亂數 (36)
 */
export function demoSwarmClient(epochSeconds = 3_600, now: () => number = Date.now): SwarmClient {
  const epoch = () => Math.floor(now() / 1000 / epochSeconds);
  const decode = (tx: string) => ({
    start: Number.parseInt(tx.slice(2, 18), 16),
    epochs: Number.parseInt(tx.slice(18, 26), 16),
    replicas: Number.parseInt(tx.slice(26, 30), 16),
    id: BigInt(Number.parseInt(tx.slice(-6), 16)),
  });
  return {
    network: "demo",
    gateways: [],
    async host() {},
    async currentEpoch() {
      return epoch();
    },
    async createDeal(a) {
      const rand = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `0x${epoch().toString(16).padStart(16, "0")}${a.epochs.toString(16).padStart(8, "0")}${a.replicas.toString(16).padStart(4, "0")}${rand}` as Hex;
    },
    async receipt(txHash) {
      if (!/^0x[0-9a-f]{64}$/.test(txHash)) return { state: "FAILED", error: "不是示範模式的交易" };
      const d = decode(txHash);
      return { state: "ACTIVE", dealId: d.id, startEpoch: d.start, endEpoch: d.start + d.epochs };
    },
    async slots() {
      return { closed: false, endEpoch: epoch(), slots: [] };
    },
  };
}
