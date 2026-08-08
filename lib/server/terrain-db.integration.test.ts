import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import { MAP } from "@/lib/game/balance";
import type { World } from "@/lib/game/map/world";
import {
  CHUNK,
  readTerrainFromDb,
  serializeTerrain,
  storeTerrainInDb,
} from "@/lib/server/terrain-files";
import { createHarness, type Harness } from "@/lib/server/testing/pg-harness";

/**
 * 地形入庫的整合測試：bytea 真的存得進去、讀得回來、位元組一致。
 * 「檔案系統會蒸發，資料庫不會」—— 這一層的正確性就是 /map 的可用性。
 */

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

/** 序列化只讀這幾個欄位 —— 假世界即可，不用跑 7–20 秒的生成 */
function fakeWorld(): World {
  const cells = new Uint8Array(MAP.width * MAP.height);
  for (let i = 0; i < cells.length; i++) cells[i] = i % 7 === 0 ? 3 : 1;
  return {
    seed: 424242,
    map: { cells },
    ruins: [{ id: 1, name: "測試遺跡", x: 250, y: 250 }],
    split: { areas: { 1: 100, 2: 100, 3: 100 } },
    fairness: { pass: true, checks: [] },
    spawns: { points: [{ x: 10, y: 10, faction: 1, band: "VANGUARD" }] },
  } as unknown as World;
}

/** 整張地圖切成幾個 chunk —— 地圖尺寸改了，這裡自動跟上 */
const chunkTotal = () => Math.ceil(MAP.width / CHUNK) * Math.ceil(MAP.height / CHUNK);

describe("serializeTerrain", () => {
  it("整張圖切成 chunk（每個 64×64 bytes）+ meta.json，磁碟與資料庫共用同一份", () => {
    const files = serializeTerrain(fakeWorld());
    const bins = files.filter((f) => f.name.endsWith(".bin"));
    // chunk 數由地圖尺寸推導（900×900 → 15×15 = 225），不寫死
    expect(bins).toHaveLength(chunkTotal());
    for (const b of bins) expect(b.data).toHaveLength(CHUNK * CHUNK);

    const meta = JSON.parse(new TextDecoder().decode(files.find((f) => f.name === "meta.json")!.data));
    expect(meta.seed).toBe(424242);
    expect(meta.terrainCodes).toBeDefined();
    expect(meta.ruins).toHaveLength(1);
  });
});

describe("terrain_files：bytea 的存與讀", () => {
  it("★ 存進去、讀回來，位元組一致；重存冪等（覆蓋不疊加）", async () => {
    const files = serializeTerrain(fakeWorld());
    await h.tx((tx) => storeTerrainInDb(tx, 77, files));
    await h.tx((tx) => storeTerrainInDb(tx, 77, files)); // 冪等

    const rows = await h.db
      .select()
      .from(schema.terrainFiles)
      .where(eq(schema.terrainFiles.seasonId, 77));
    expect(rows).toHaveLength(chunkTotal() + 1); // + meta.json

    const back = await readTerrainFromDb(h.db, 77);
    const byName = new Map(back.map((f) => [f.name, f.data]));
    for (const f of files) {
      const stored = byName.get(f.name);
      expect(stored, `${f.name} 沒讀回來`).toBeDefined();
      expect(Buffer.from(stored!).equals(Buffer.from(f.data)), `${f.name} 位元組不一致`).toBe(true);
    }
  });

  it("不同賽季互不干擾", async () => {
    const files = serializeTerrain(fakeWorld());
    await h.tx((tx) => storeTerrainInDb(tx, 78, files.slice(0, 3)));
    expect(await readTerrainFromDb(h.db, 78)).toHaveLength(3);
    expect(await readTerrainFromDb(h.db, 9999)).toHaveLength(0);
  });
});
