/**
 * 整合測試用的**真** Postgres。
 *
 * ## ★ 為什麼需要這個
 *
 * `docs/11` §16.1 記下了 M2 的缺口：驗收測試綁在純函式上，
 * 所以 `lib/server/*` 那一層 —— 交易邊界、`FOR UPDATE` 的鎖、
 * upsert 的衝突處理 —— **只有型別在擋**。
 * 而那一層真正會出事的地方（double-spend、半套狀態）純函式測試看不到。
 *
 * PGlite 是編進 WASM 的 Postgres，跑在測試行程裡：
 * 沒有容器、沒有連線字串，但 `SELECT ... FOR UPDATE`、
 * `ON CONFLICT`、`CHECK` 約束、交易回滾全部是真的。
 *
 * ★ 這個檔案**不會**進到應用程式的模組圖裡（沒有任何 production code
 *   import 它），所以 `@electric-sql/pglite` 留在 devDependencies。
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";

import { BALANCE_VERSION, type Terrain } from "@/lib/game/balance";
import { TERRAIN_CODE } from "@/lib/game/map/terrain";
import { CHUNK_SIZE } from "@/lib/render/chunks";
import * as schema from "@/lib/db/schema";
import * as authSchema from "@/lib/db/auth-schema";
import type { TxDb } from "@/lib/db/tx";

export interface Harness {
  readonly db: ReturnType<typeof drizzle<typeof schema & typeof authSchema>>;
  /**
   * 在一個交易裡跑一段程式，簽章與 production 的 `withTransaction` 相同。
   *
   * ★ 這裡有一個 cast：PGlite 與 neon-serverless 的 driver 型別不同，
   *   但**執行期的介面是一樣的**（都是 drizzle 的 PgTransaction）。
   *   production code 一律接 `TxDb`，所以轉一次就好，
   *   而且轉錯了測試會立刻炸給你看。
   */
  readonly tx: <T>(fn: (tx: TxDb) => Promise<T>) => Promise<T>;
  readonly close: () => Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const client = new PGlite();
  const db = drizzle(client, { schema: { ...schema, ...authSchema } });
  await migrate(db, { migrationsFolder: "drizzle" });

  return {
    db,
    tx: (fn) => db.transaction(async (t) => fn(t as unknown as TxDb)),
    close: () => client.close(),
  };
}

// ─────────────────────────────────────────────────────────────
// 種資料
// ─────────────────────────────────────────────────────────────

export interface SeedOptions {
  readonly startedAt: Date;
  readonly citadelLevel?: number;
  readonly baseX?: number;
  readonly baseY?: number;
  readonly resources?: number;
  readonly populationCap?: number;
  readonly allianceId?: number | null;
}

export interface SeededPlayer {
  readonly playerId: number;
  readonly seasonId: number;
  readonly email: string;
}

/**
 * 建一個進行中的賽季與一位玩家。
 *
 * 刻意**不用**任何 production 的初始化函式 —— 那些還不存在（M5 才做），
 * 而且測試的種資料應該獨立於被測程式碼，否則兩邊會一起錯。
 */
export async function seedSeason(h: Harness, opts: SeedOptions): Promise<number> {
  const [season] = await h.db
    .insert(schema.seasons)
    .values({
      seed: 99991n,
      status: "RUNNING",
      startedAt: opts.startedAt,
      balanceVersion: BALANCE_VERSION,
    })
    .returning({ id: schema.seasons.id });
  return season!.id;
}

let emailCounter = 0;
let allianceCounter = 0;

export async function seedPlayer(
  h: Harness,
  seasonId: number,
  opts: SeedOptions,
): Promise<SeededPlayer> {
  const email = `p${++emailCounter}@test.local`;

  const [user] = await h.db
    .insert(schema.users)
    .values({ email, provider: "email", displayName: email })
    .returning({ id: schema.users.id });

  const [player] = await h.db
    .insert(schema.players)
    .values({
      seasonId,
      userId: user!.id,
      allianceId: opts.allianceId ?? null,
      faction: 1,
      spawnBand: "HEARTLAND",
      baseX: opts.baseX ?? 100,
      baseY: opts.baseY ?? 100,
      citadelLevel: opts.citadelLevel ?? 10,
      settledAt: opts.startedAt,
      lastSeenAt: opts.startedAt,
    })
    .returning({ id: schema.players.id });

  const playerId = player!.id;
  const amount = String(opts.resources ?? 5000);

  await h.db.insert(schema.playerResources).values({
    playerId,
    grain: amount,
    timber: amount,
    stone: amount,
    iron: amount,
    settledAt: opts.startedAt,
  });

  await h.db.insert(schema.playerPopulation).values({
    playerId,
    amount: "0",
    cap: String(opts.populationCap ?? 500),
    used: "0",
    settledAt: opts.startedAt,
  });

  for (const slot of ["B", "C", "D"] as const) {
    await h.db.insert(schema.baseSlots).values({ playerId, slot, building: null, level: 0 });
  }

  return { playerId, seasonId, email };
}

/** 建一個聯盟並把成員加進去。回傳 allianceId */
export async function seedAlliance(
  h: Harness,
  seasonId: number,
  members: readonly number[],
  opts: { faction?: number; slotNo?: number; name?: string } = {},
): Promise<number> {
  // hex_code 在同一賽季內唯一（`docs/06`），所以用一個單調遞增的計數器
  const suffix = (++allianceCounter % 256).toString(16).toUpperCase().padStart(2, "0");
  const [row] = await h.db
    .insert(schema.alliances)
    .values({
      seasonId,
      faction: opts.faction ?? 1,
      slotNo: opts.slotNo ?? 1,
      name: opts.name ?? `聯盟-${seasonId}-${opts.slotNo ?? 1}`,
      tag: `T${(opts.slotNo ?? 1) % 10}`,
      hexCode: suffix,
      color: (opts.slotNo ?? 1) % 15,
      leaderId: members[0]!,
    })
    .returning({ id: schema.alliances.id });

  const allianceId = row!.id;
  for (const playerId of members) {
    await h.db.insert(schema.allianceMembers).values({ allianceId, playerId, rank: "MEMBER" });
    await h.db
      .update(schema.players)
      .set({ allianceId })
      .where(sql`${schema.players.id} = ${playerId}`);
  }
  return allianceId;
}

/** 給玩家一塊已經佔好的領土 */
export async function seedTile(
  h: Harness,
  seasonId: number,
  playerId: number,
  tile: {
    x: number;
    y: number;
    facility?: string | null;
    facilityLevel?: number;
    terrain?: (typeof schema.terrainEnum.enumValues)[number];
    state?: (typeof schema.tileStateEnum.enumValues)[number];
  },
) {
  await h.db
    .insert(schema.tiles)
    .values({
      seasonId,
      x: tile.x,
      y: tile.y,
      kind: "TERRITORY",
      playerId,
      facility: tile.facility ?? null,
      facilityLevel: tile.facilityLevel ?? 0,
      terrain: tile.terrain ?? "PLAIN",
      state: tile.state ?? "NORMAL",
    })
    .onConflictDoUpdate({
      target: [schema.tiles.seasonId, schema.tiles.x, schema.tiles.y],
      set: {
        playerId,
        facility: tile.facility ?? null,
        facilityLevel: tile.facilityLevel ?? 0,
        state: tile.state ?? "NORMAL",
      },
    });
}

/**
 * 寫一份最小的地形 fixture 並把 `TERRAIN_ROOT` 指過去。
 *
 * ★ 不跑真的地圖生成器 —— 那要 7–20 秒，而整合測試要驗的不是地形品質，
 *   是「拓荒讀得到地形嗎、地形有沒有被抄進 `tiles.terrain`」。
 *   全平原的一張圖就夠了，想測特殊地形再用 `patch` 蓋掉幾格。
 */
export async function writeTerrainFixture(
  seasonId: number,
  patch: readonly { x: number; y: number; terrain: Terrain }[] = [],
): Promise<string> {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const root = await mkdtemp(join(tmpdir(), "ruincity-terrain-"));
  const dir = join(root, `s${seasonId}`);
  await mkdir(dir, { recursive: true });

  const patched = new Map(patch.map((p) => [`${p.x},${p.y}`, p.terrain]));
  const touched = new Set(
    [...patched.keys(), "0,0"].map((k) => {
      const [x, y] = k.split(",").map(Number) as [number, number];
      return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`;
    }),
  );
  // 測試用的座標都在 (96..160) 附近，把整張 8×8 的 chunk 網格都寫出來最省事
  for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 8; cx++) touched.add(`${cx},${cy}`);

  for (const key of touched) {
    const [cx, cy] = key.split(",").map(Number) as [number, number];
    const buf = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(TERRAIN_CODE.PLAIN);
    for (const [k, terrain] of patched) {
      const [x, y] = k.split(",").map(Number) as [number, number];
      if (Math.floor(x / CHUNK_SIZE) !== cx || Math.floor(y / CHUNK_SIZE) !== cy) continue;
      buf[(y - cy * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)] = TERRAIN_CODE[terrain];
    }
    await writeFile(join(dir, `${cx}_${cy}.bin`), buf);
  }

  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ seed: 99991, ruins: [{ x: 250, y: 250 }] }),
  );

  process.env.TERRAIN_ROOT = root;
  return root;
}

/** 直接讀資源，繞過所有被測程式碼 */
export async function readResources(h: Harness, playerId: number) {
  const [row] = await h.db
    .select()
    .from(schema.playerResources)
    .where(sql`${schema.playerResources.playerId} = ${playerId}`);
  return {
    grain: Number(row!.grain),
    timber: Number(row!.timber),
    stone: Number(row!.stone),
    iron: Number(row!.iron),
    capacity: Number(row!.capacity),
    settledAt: row!.settledAt.getTime(),
  };
}
