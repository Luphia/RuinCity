/**
 * Boltchain SwarmStorage 的委託索引（`DealIndex`，Boltchain ADR 0014 §4）。純函式，無 I/O。
 *
 * 一筆保存委託在鏈上只記一個 CID：委託索引的根。索引是 dag-cbor：
 *
 *   根   {v: 1, size, count, groups: [分組 CID…], root: 應用層入口}
 *   分組 [區塊 CID…]（每組最多 1024 個）
 *
 * 保存者要保存根、所有分組與分組列出的每一個區塊；審計者抽一個區塊向保存者要。
 *
 * ★ 我們的「應用層入口」（`root`）是場景包的 UnixFS 根 CID，分組列出那個 DAG 的**每一個**區塊。
 *   Boltchain 的閘道匯出 CAR 時只跟隨 dag-cbor 的連結（不懂 UnixFS 的 dag-pb），
 *   但分組是 dag-cbor 的 CID 清單 —— 所以 `GET /ipfs/<委託索引>?format=car`
 *   會把整個場景包一起帶出來。這是「從任何一個 Boltchain 節點拿回整包」的那條路。
 *
 * ★ 場景包**不加密**。Boltchain 的 `storage put` 會用 bolt-vault 加密，那是給私人檔案的；
 *   完成的地圖本來就公開，加密了就沒有人能重建。合約與抽查只看區塊，不在乎內容是不是密文。
 */

import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

import type { IpldBlock } from "@/lib/ipfs/pack";

export const DEAL_GROUP = 1024;
export const DAG_CBOR_CODEC = dagCbor.code;

export interface DealIndex {
  readonly v: 1;
  readonly size: number;
  readonly count: number;
  readonly groups: readonly CID[];
  readonly root: CID | null;
}

async function cborBlock(value: unknown): Promise<IpldBlock> {
  const bytes = dagCbor.encode(value);
  return { cid: CID.create(1, dagCbor.code, await sha256.digest(bytes)), bytes };
}

/**
 * 替 `blocks`（依序）建立索引，入口為 `root`。
 * 回傳索引根的 CID、索引本身，以及索引自己的區塊（分組在前、根在最後；與 Rust 版相同）。
 */
export async function buildDealIndex(
  blocks: readonly IpldBlock[],
  root: CID | null,
): Promise<{ cid: CID; index: DealIndex; indexBlocks: IpldBlock[] }> {
  const indexBlocks: IpldBlock[] = [];
  const groups: CID[] = [];
  for (let i = 0; i < blocks.length; i += DEAL_GROUP) {
    const g = await cborBlock(blocks.slice(i, i + DEAL_GROUP).map((b) => b.cid));
    groups.push(g.cid);
    indexBlocks.push(g);
  }
  const index: DealIndex = {
    v: 1,
    size: blocks.reduce((s, b) => s + b.bytes.length, 0),
    count: blocks.length,
    groups,
    root,
  };
  const top = await cborBlock(index);
  indexBlocks.push(top);
  return { cid: top.cid, index, indexBlocks };
}

/** 解碼索引根（驗證工具從 Boltchain 閘道拿到 CAR 時用） */
export function decodeDealIndex(bytes: Uint8Array): DealIndex | null {
  try {
    const v = dagCbor.decode<Record<string, unknown>>(bytes);
    if (
      v?.v !== 1 ||
      typeof v.size !== "number" ||
      typeof v.count !== "number" ||
      !Array.isArray(v.groups) ||
      v.groups.length !== Math.ceil(v.count / DEAL_GROUP)
    ) {
      return null;
    }
    const root = v.root === null || v.root === undefined ? null : CID.asCID(v.root);
    return { v: 1, size: v.size, count: v.count, groups: v.groups.map((g) => CID.asCID(g)!), root };
  } catch {
    return null;
  }
}

export function decodeDealGroup(bytes: Uint8Array): CID[] {
  const v = dagCbor.decode<unknown[]>(bytes);
  return v.map((c) => {
    const cid = CID.asCID(c);
    if (!cid) throw new Error("分組裡有不是 CID 的東西");
    return cid;
  });
}
