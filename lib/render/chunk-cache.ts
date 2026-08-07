/**
 * 地形 chunk 的取得與快取。**瀏覽器端專用**（用到 IndexedDB 與 fetch）。
 *
 * 地形層在賽季內永不改變（`docs/01` §3.2），所以它是快取的完美對象：
 * 抓過一次就再也不用抓。64 個 chunk 全下載也只有 256 KB，
 * 但在手機網路上那仍然是好幾秒 —— 所以第二次進遊戲要直接從 IndexedDB 讀。
 */

import { CHUNK_SIZE, chunkKey } from "./chunks";

const DB_NAME = "ruincity-terrain";
const DB_VERSION = 1;
const STORE = "chunks";

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** IndexedDB 不一定可用（無痕模式、舊瀏覽器）—— 失敗就退回純網路 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

function idbGet(db: IDBDatabase, key: string): Promise<ArrayBuffer | undefined> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
    req.onerror = () => resolve(undefined);
  });
}

function idbPut(db: IDBDatabase, key: string, value: ArrayBuffer) {
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
  } catch {
    // 配額用完之類的 —— 快取失敗不該讓地圖掛掉
  }
}

export interface ChunkSource {
  readonly seasonId: string;
  readonly baseUrl: string;
}

/** 記憶體內的一層，避免同一個 chunk 在同一次瀏覽中重複解碼 */
const memory = new Map<string, Uint8Array>();

/** 同一個 chunk 被同時要求時只發一次請求 */
const inflight = new Map<string, Promise<Uint8Array>>();

export function cacheKey(source: ChunkSource, cx: number, cy: number): string {
  return `${source.seasonId}/${chunkKey(cx, cy)}`;
}

export function peekChunk(source: ChunkSource, cx: number, cy: number): Uint8Array | undefined {
  return memory.get(cacheKey(source, cx, cy));
}

/**
 * 取得一個 chunk 的地形碼。順序：記憶體 → IndexedDB → 網路。
 */
export async function loadChunk(
  source: ChunkSource,
  cx: number,
  cy: number,
): Promise<Uint8Array> {
  const key = cacheKey(source, cx, cy);
  const cached = memory.get(key);
  if (cached) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const db = await openDb();
    if (db) {
      const stored = await idbGet(db, key);
      if (stored && stored.byteLength === CHUNK_SIZE * CHUNK_SIZE) {
        const bytes = new Uint8Array(stored);
        memory.set(key, bytes);
        return bytes;
      }
    }

    const res = await fetch(`${source.baseUrl}/${chunkKey(cx, cy)}.bin`, { cache: "force-cache" });
    if (!res.ok) throw new Error(`chunk ${key} 下載失敗：${res.status}`);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    memory.set(key, bytes);
    if (db) idbPut(db, key, buf);
    return bytes;
  })().finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/** 測試與「換賽季」時用 */
export function clearMemoryCache() {
  memory.clear();
  inflight.clear();
}
