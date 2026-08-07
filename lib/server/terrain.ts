import "server-only";

/**
 * 伺服器端的地形查詢。
 *
 * ★ 為什麼在這裡而不是 `/lib/game`：這裡要讀檔，而 `/lib/game` 不得有 I/O
 *   （CLAUDE.md 第一條界線）。純函式那邊拿到的一律是「已經查好的地形」。
 *
 * 地形整季不變，所以 chunk 讀進來就一直留在 process 記憶體裡。
 * 一個 chunk 是 64×64 = 4 KB，整張圖 64 個 chunk 共 256 KB ——
 * 全部載入也只有 256 KB，不需要淘汰策略。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { MAP, type Terrain } from "@/lib/game/balance";
import { CODE_TERRAIN } from "@/lib/game/map/terrain";
import { CHUNK_SIZE, chunkKey, chunkOfTile } from "@/lib/render/chunks";

/** `seasonDir` → `chunkKey` → 4096 bytes */
const cache = new Map<string, Map<string, Uint8Array>>();

/** 地形靜態檔的目錄名。M5 的賽季登記接上之後改由賽季紀錄提供 */
export function terrainDirFor(seasonId: number | string): string {
  return `s${seasonId}`;
}

async function loadChunk(dir: string, cx: number, cy: number): Promise<Uint8Array | null> {
  let perSeason = cache.get(dir);
  if (!perSeason) {
    perSeason = new Map();
    cache.set(dir, perSeason);
  }
  const k = chunkKey(cx, cy);
  const hit = perSeason.get(k);
  if (hit) return hit;

  try {
    const buf = await readFile(join(process.cwd(), "public", "terrain", dir, `${k}.bin`));
    const bytes = new Uint8Array(buf);
    perSeason.set(k, bytes);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 一張**只讀取需要的 chunk** 的地形查詢表。
 *
 * 拓荒一次只看一格，但 `planClaim` 的簽章要的是同步的 `terrainAt`——
 * 所以先把要用到的格預載進來，再交出一個同步的查詢函式。
 */
export interface TerrainLookup {
  readonly at: (x: number, y: number) => Terrain;
  /** 地形檔不存在時為 false —— 呼叫端要決定是拒絕還是退回 PLAIN */
  readonly loaded: boolean;
}

export async function loadTerrainAround(
  seasonDir: string,
  points: readonly { x: number; y: number }[],
): Promise<TerrainLookup> {
  const needed = new Set<string>();
  for (const p of points) {
    const c = chunkOfTile(p.x, p.y);
    needed.add(`${c.cx},${c.cy}`);
  }

  const chunks = new Map<string, Uint8Array>();
  let loaded = needed.size > 0;
  for (const key of needed) {
    const [cx, cy] = key.split(",").map(Number) as [number, number];
    const bytes = await loadChunk(seasonDir, cx, cy);
    if (!bytes) loaded = false;
    else chunks.set(key, bytes);
  }

  const at = (x: number, y: number): Terrain => {
    if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return "MOUNTAIN";
    const c = chunkOfTile(x, y);
    const bytes = chunks.get(`${c.cx},${c.cy}`);
    if (!bytes) return "PLAIN";
    const lx = x - c.cx * CHUNK_SIZE;
    const ly = y - c.cy * CHUNK_SIZE;
    return CODE_TERRAIN[bytes[ly * CHUNK_SIZE + lx] ?? 0] ?? "PLAIN";
  };

  return { at, loaded };
}

/**
 * 這一季三座遺跡的座標。
 *
 * 真相同樣在地圖靜態檔的 `meta.json`（`generate-map.ts` 寫出來的），
 * 整季不變，所以讀一次就快取起來。
 */
const ruinCache = new Map<string, readonly { x: number; y: number }[]>();

export async function loadRuins(
  seasonDir: string,
): Promise<readonly { x: number; y: number }[]> {
  const hit = ruinCache.get(seasonDir);
  if (hit) return hit;

  try {
    const raw = await readFile(
      join(process.cwd(), "public", "terrain", seasonDir, "meta.json"),
      "utf8",
    );
    const meta = JSON.parse(raw) as { ruins?: { x?: unknown; y?: unknown }[] };
    const ruins = (meta.ruins ?? []).flatMap((r) =>
      typeof r.x === "number" && typeof r.y === "number" ? [{ x: r.x, y: r.y }] : [],
    );
    ruinCache.set(seasonDir, ruins);
    return ruins;
  } catch {
    return [];
  }
}
