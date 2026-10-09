/**
 * 場景包 ↔ IPFS（UnixFS）。**決定性**：同樣的檔案永遠打成同一個根 CID、同一串區塊。
 * 無 DB、無網路 —— 伺服器打包、驗證工具重建、測試都用這一份。
 *
 * ## ★ 為什麼 CID 可以被任何人重算
 *
 * 用 IPIP-499 的 `unixfs-v1-2025` 設定（CIDv1、raw leaves、1 MiB 分塊、每個節點最多 1024 個連結、
 * 目錄以區塊大小判斷是否分片），而且**每一項都明寫**，不依賴函式庫的預設值 ——
 * 預設值會隨版本改變，CID 就跟著變。
 * 同一個資料夾用 Kubo 算，結果相同（CI 的 `scene-kubo` 工作會實際比對）：
 *
 *     ipfs add -r --only-hash --cid-version=1 --raw-leaves --chunker=size-1048576 <資料夾>
 *
 * 沒有 mtime、沒有 mode：那些是「這台機器上的檔案」的屬性，不是內容。
 */

import * as dagPb from "@ipld/dag-pb";
import { CarBufferReader } from "@ipld/car/buffer-reader";
import * as CarBufferWriter from "@ipld/car/buffer-writer";
import { exporter, recursive } from "ipfs-unixfs-exporter";
import { importer, type ImporterOptions } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

export const RAW_CODEC = 0x55;
export const DAG_PB_CODEC = 0x70;

export const UNIXFS_PROFILE = {
  name: "unixfs-v1-2025",
  cidVersion: 1,
  rawLeaves: true,
  chunkSize: 1_048_576,
  maxChildrenPerNode: 1_024,
  shardSplitThresholdBytes: 262_144,
} as const;

/** 給人看（也寫進 README）的等價 Kubo 指令 */
export const KUBO_ADD_FLAGS = "--cid-version=1 --raw-leaves --chunker=size-1048576";

export interface BundleFile {
  /** 相對路徑，`/` 分隔，不以 `/` 開頭 */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface IpldBlock {
  readonly cid: CID;
  readonly bytes: Uint8Array;
}

export interface PackedBundle {
  readonly root: CID;
  /** 從根開始的深度優先順序，每個區塊一次。CAR 與保存委託都用這個順序 */
  readonly blocks: readonly IpldBlock[];
  /** 所有區塊的位元組總和 */
  readonly bytes: number;
}

function options(): ImporterOptions {
  return {
    profile: UNIXFS_PROFILE.name,
    cidVersion: UNIXFS_PROFILE.cidVersion,
    rawLeaves: UNIXFS_PROFILE.rawLeaves,
    reduceSingleLeafToSelf: true,
    chunker: fixedSize({ chunkSize: UNIXFS_PROFILE.chunkSize }),
    layout: balanced({ maxChildrenPerNode: UNIXFS_PROFILE.maxChildrenPerNode }),
    shardSplitThresholdBytes: UNIXFS_PROFILE.shardSplitThresholdBytes,
    shardSplitStrategy: "block-bytes",
    fieldOrder: "links-first",
    wrapWithDirectory: true,
  };
}

function checkPath(p: string) {
  if (!p || p.startsWith("/") || p.endsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`不合法的路徑：${JSON.stringify(p)}`);
  }
}

async function collect(value: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return value;
  const parts: Uint8Array[] = [];
  for await (const p of value as AsyncIterable<Uint8Array>) parts.push(p);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 記憶體裡的區塊庫，只實作 importer 與 exporter 用得到的那兩個方法 */
export class MemoryBlocks {
  readonly map = new Map<string, IpldBlock>();
  async put(cid: CID, value: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>): Promise<CID> {
    this.map.set(cid.toString(), { cid, bytes: await collect(value) });
    return cid;
  }
  *get(cid: CID): Generator<Uint8Array> {
    const b = this.map.get(cid.toString());
    if (!b) throw new Error(`缺少區塊 ${cid.toString()}`);
    yield b.bytes;
  }
  has(cid: CID): boolean {
    return this.map.has(cid.toString());
  }
}

/** 一個區塊連到哪些區塊（只有 dag-pb 有連結；raw 是葉子） */
export function linksOf(b: IpldBlock): CID[] {
  if (b.cid.code !== DAG_PB_CODEC) return [];
  return dagPb.decode(b.bytes).Links.map((l) => l.Hash as CID);
}

/** 從根做深度優先走訪（連結依節點內的順序），每個區塊一次 */
export function dfsOrder(root: CID, get: (cid: CID) => IpldBlock | undefined): IpldBlock[] {
  const out: IpldBlock[] = [];
  const seen = new Set<string>();
  const stack: CID[] = [root];
  while (stack.length) {
    const c = stack.pop()!;
    const k = c.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    const b = get(c);
    if (!b) throw new Error(`缺少區塊 ${k}`);
    out.push(b);
    stack.push(...linksOf(b).reverse());
  }
  return out;
}

export async function packBundle(files: readonly BundleFile[]): Promise<PackedBundle> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    checkPath(sorted[i]!.path);
    if (i > 0 && sorted[i]!.path === sorted[i - 1]!.path) throw new Error(`重複的路徑：${sorted[i]!.path}`);
  }
  const store = new MemoryBlocks();
  let root: CID | null = null;
  for await (const entry of importer(
    sorted.map((f) => ({ path: f.path, content: f.bytes })),
    store,
    options(),
  )) {
    root = entry.cid;
  }
  if (!root) throw new Error("沒有任何檔案");
  const blocks = dfsOrder(root, (c) => store.map.get(c.toString()));
  return { root, blocks, bytes: blocks.reduce((s, b) => s + b.bytes.length, 0) };
}

/** 驗證一個區塊的位元組確實雜湊成它的 CID（只接受 sha2-256） */
export async function checkBlock(b: IpldBlock): Promise<boolean> {
  if (b.cid.multihash.code !== sha256.code) return false;
  const d = await sha256.digest(b.bytes);
  const a = d.digest;
  const e = b.cid.multihash.digest;
  return a.length === e.length && a.every((x, i) => x === e[i]);
}

export function writeCar(roots: readonly CID[], blocks: readonly IpldBlock[]): Uint8Array {
  const headerSize = CarBufferWriter.headerLength({ roots: [...roots] });
  const size = headerSize + blocks.reduce((s, b) => s + CarBufferWriter.blockLength(b), 0);
  const buffer = new ArrayBuffer(size);
  const w = CarBufferWriter.createWriter(buffer, { roots: [...roots], headerSize });
  for (const b of blocks) w.write(b);
  return w.close();
}

export function readCar(bytes: Uint8Array): { roots: CID[]; blocks: IpldBlock[] } {
  const r = CarBufferReader.fromBytes(bytes);
  return { roots: r.getRoots() as CID[], blocks: r.blocks().map((b) => ({ cid: b.cid as CID, bytes: b.bytes })) };
}

/** 把一個 UnixFS 目錄還原成檔案（只信任雜湊對得上的區塊） */
export async function unpackBundle(root: CID, blocks: Iterable<IpldBlock>): Promise<BundleFile[]> {
  const store = new MemoryBlocks();
  for (const b of blocks) {
    if (!(await checkBlock(b))) throw new Error(`區塊 ${b.cid.toString()} 的內容與 CID 不符`);
    await store.put(b.cid, b.bytes);
  }
  const top = await exporter(root, store);
  if (top.type !== "directory") throw new Error("根不是目錄");
  const out: BundleFile[] = [];
  for await (const e of recursive(root, store)) {
    const entry = await exporter(e.cid, store);
    if (entry.type !== "file" && entry.type !== "raw") continue;
    const rel = e.path.split("/").slice(1).join("/");
    out.push({ path: rel, bytes: await collect(entry.content()) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
