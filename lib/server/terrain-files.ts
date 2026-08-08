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

import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
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

export interface TerrainFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/**
 * 世界 → 檔案列表（64 個 chunk + meta.json）。**純序列化**，
 * 磁碟與資料庫兩個去處共用同一份 —— 兩份序列化遲早分岔。
 */
export function serializeTerrain(world: World): TerrainFile[] {
  const cols = Math.ceil(MAP.width / CHUNK);
  const rows = Math.ceil(MAP.height / CHUNK);
  const mountain = CODE_TERRAIN.indexOf("MOUNTAIN");
  const files: TerrainFile[] = [];

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
      files.push({ name: `${cx}_${cy}.bin`, data: buf });
    }
  }

  files.push({
    name: "meta.json",
    data: new TextEncoder().encode(
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
    ),
  });

  return files;
}

export async function writeTerrainFiles(world: World, dir: string): Promise<WriteResult> {
  const files = serializeTerrain(world);
  return writeFilesToDisk(files, dir);
}

async function writeFilesToDisk(files: readonly TerrainFile[], dir: string): Promise<WriteResult> {
  await mkdir(dir, { recursive: true });
  let bytes = 0;
  for (const f of files) {
    await writeFile(join(dir, f.name), f.data);
    bytes += f.data.length;
  }
  return { dir, chunks: files.length - 1, bytes };
}

// ─────────────────────────────────────────────────────────────
// 資料庫那一份：不會蒸發的地形
// ─────────────────────────────────────────────────────────────

/**
 * 把地形檔存進 `terrain_files`。封盤時與 SEALED 同一個交易呼叫 ——
 * 「賽季封盤了但地形不見了」這種半套狀態從此不存在。
 * 冪等：重跑就覆蓋。
 */
export async function storeTerrainInDb(
  tx: TxDb,
  seasonId: number,
  files: readonly TerrainFile[],
): Promise<void> {
  for (const f of files) {
    await tx
      .insert(schema.terrainFiles)
      .values({ seasonId, name: f.name, data: f.data })
      .onConflictDoUpdate({
        target: [schema.terrainFiles.seasonId, schema.terrainFiles.name],
        set: { data: f.data },
      });
  }
}

export async function readTerrainFromDb(
  db: Pick<TxDb, "select">,
  seasonId: number,
): Promise<TerrainFile[]> {
  const rows = await db
    .select({ name: schema.terrainFiles.name, data: schema.terrainFiles.data })
    .from(schema.terrainFiles)
    .where(eq(schema.terrainFiles.seasonId, seasonId));
  // bytea 經不同 driver 回來可能是 Buffer —— 一律轉成 Uint8Array
  return rows.map((r) => ({ name: r.name, data: new Uint8Array(r.data) }));
}

/**
 * ★ 啟動時呼叫（`instrumentation.ts` 與 `pnpm worker`）：
 *   確保**最新一季**的地形檔立刻可用。
 *
 *   1. 磁碟已有 → 無事（本機開發的常態）
 *   2. 資料庫有 → 實體化到磁碟（新實例、重新部署後的常態）
 *   3. 兩邊都沒有 → 用賽季的 seed **重新生成**並存進資料庫 + 磁碟
 *      （這個功能上線前就封盤的賽季，或當時寫檔失敗的）
 *
 *   重新生成走與封盤完全相同的輸入（seed + 登記者的小隊）——
 *   `generateWorld` 是決定性的，同輸入同輸出（`docs/11` §20 的 M5b 教訓：
 *   怕的是「兩次獨立計算」，所以這裡連小隊參數都從 registrations 重建）。
 */
export async function ensureLatestTerrain(log: (line: string) => void = () => {}): Promise<
  "disk" | "db" | "generated" | "none"
> {
  const { getDb } = await import("@/lib/db");
  const { desc, ne } = await import("drizzle-orm");
  const db = getDb();

  const [season] = await db
    .select({ id: schema.seasons.id, seed: schema.seasons.seed })
    .from(schema.seasons)
    .where(ne(schema.seasons.status, "ARCHIVED"))
    .orderBy(desc(schema.seasons.id))
    .limit(1);
  if (!season) return "none";

  const dir = join(terrainRoot(), terrainDirName(season.id));
  const onDisk = await access(join(dir, "meta.json")).then(
    () => true,
    () => false,
  );
  if (onDisk) return "disk";

  const [{ n }] = (await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.terrainFiles)
    .where(eq(schema.terrainFiles.seasonId, season.id))) as [{ n: number }];

  if (Number(n) > 0) {
    const files = await readTerrainFromDb(db, season.id);
    const out = await writeFilesToDisk(files, dir);
    log(`地形檔由資料庫實體化：${out.chunks} 個 chunk → ${out.dir}`);
    return "db";
  }

  // 兩邊都沒有 → 重新生成（7–20 秒，只在這個賽季第一次遇到時發生一次）
  log(`賽季 s${season.id} 的地形不在資料庫 —— 以 seed ${season.seed} 重新生成…`);
  const { generateWorld } = await import("@/lib/game/map/world");
  const { squadRequestsFrom } = await import("@/lib/game/season");
  const registrations = await db
    .select({
      faction: schema.seasonRegistrations.faction,
      spawnBand: schema.seasonRegistrations.spawnBand,
      squadCode: schema.seasonRegistrations.squadCode,
    })
    .from(schema.seasonRegistrations)
    .where(eq(schema.seasonRegistrations.seasonId, season.id));

  const world = generateWorld(Number(season.seed), {
    squads: squadRequestsFrom(
      registrations.map((r) => ({
        faction: r.faction,
        band: r.spawnBand,
        squadCode: r.squadCode,
      })),
    ),
    onProgress: log,
  });
  const files = serializeTerrain(world);

  const { withTransaction } = await import("@/lib/db/tx");
  await withTransaction((tx) => storeTerrainInDb(tx, season.id, files));
  const out = await writeFilesToDisk(files, dir).catch((e) => {
    // 唯讀檔案系統（serverless）：資料庫那份已存好，API 路由會供檔
    log(`磁碟寫入失敗（${e instanceof Error ? e.message : e}），改由 /api/terrain 供檔`);
    return null;
  });
  log(
    `地形已生成並存入資料庫（${files.length} 檔）` + (out ? `，磁碟快取 → ${out.dir}` : ""),
  );
  return "generated";
}
