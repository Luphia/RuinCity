import "server-only";

/**
 * 把生成好的世界寫成靜態檔：64 個 chunk（每格 1 byte）+ `meta.json`。
 *
 * ## ★ 為什麼這一層存在
 *
 * 地形在賽季內永不改變（`docs/01` §3.2），所以它是**靜態資產**不是 API ——
 * 封盤期產一次，之後走 CDN 長期快取，前端只在視野進入新 chunk 時下載。
 *
 * 原本這段程式只存在於 `scripts/generate-map.ts` 裡，於是產生一個很難察覺的
 * 落差：**M5b 開出來的賽季有自己的 seed，卻沒有對應的地形檔** ——
 * `/map` 只好一直指著開發用的 `s0`，玩家看到的是一張跟自己那一局
 * 完全無關的地圖，連自己的據點都不在上面。
 *
 * ★ I/O 留在 `lib/server`。`/lib/game/map` 底下沒有任何檔案系統存取。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MAP } from "@/lib/game/balance";
import { CODE_TERRAIN, idx } from "@/lib/game/map/terrain";
import type { World } from "@/lib/game/map/world";

/** `docs/01` §3.2：切成 64×64 的 chunk */
export const CHUNK = 64;

/** 賽季 id → 靜態檔目錄名。`s0` 保留給 `pnpm map:generate` 的開發地圖 */
export function terrainDirName(seasonId: number): string {
  return `s${seasonId}`;
}

export function terrainRoot(): string {
  return join(process.cwd(), "public", "terrain");
}

export interface WriteResult {
  readonly dir: string;
  readonly chunks: number;
  readonly bytes: number;
}

/** 序列化時的地形碼對照，讓前端不必重複寫一份 */
export function terrainCodeTable(): Record<string, number> {
  const table: Record<string, number> = {};
  CODE_TERRAIN.forEach((name, code) => {
    table[name] = code;
  });
  return table;
}

export async function writeTerrainFiles(world: World, dir: string): Promise<WriteResult> {
  const cols = Math.ceil(MAP.width / CHUNK);
  const rows = Math.ceil(MAP.height / CHUNK);
  const mountain = CODE_TERRAIN.indexOf("MOUNTAIN");

  await mkdir(dir, { recursive: true });
  let bytes = 0;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const buf = new Uint8Array(CHUNK * CHUNK);
      for (let y = 0; y < CHUNK; y++) {
        for (let x = 0; x < CHUNK; x++) {
          const gx = cx * CHUNK + x;
          const gy = cy * CHUNK + y;
          // 超出地圖的部分填成山脈（深淵不可通行）
          buf[y * CHUNK + x] =
            gx < MAP.width && gy < MAP.height
              ? world.map.cells[idx(gx, gy, MAP.width)]!
              : mountain;
        }
      }
      await writeFile(join(dir, `${cx}_${cy}.bin`), buf);
      bytes += buf.length;
    }
  }

  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify(
      {
        seed: world.seed,
        width: MAP.width,
        height: MAP.height,
        chunk: CHUNK,
        chunksPerRow: cols,
        chunksPerCol: rows,
        terrainCodes: terrainCodeTable(),
        ruins: world.ruins,
        areas: world.split.areas,
        fairness: world.fairness.checks,
        spawns: world.spawns.points,
      },
      null,
      2,
    ),
  );

  return { dir, chunks: cols * rows, bytes };
}
