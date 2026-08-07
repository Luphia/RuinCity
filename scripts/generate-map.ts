/**
 * 地圖生成 CLI —— seed → 地形 → 64 個 chunk 二進位檔。
 *
 *   pnpm tsx scripts/generate-map.ts [--seed 12345] [--out public/terrain/s1] [--json]
 *
 * 地形層在賽季內永不改變（`docs/01` §3.2），所以在封盤期一次性產生成
 * 靜態檔上 CDN，前端只在視野進入新 chunk 時下載。
 *
 * ★ I/O 全部留在這一層。`/lib/game/map` 底下沒有任何檔案系統存取。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { MAP, SPAWN_BANDS, TERRAINS } from "../lib/game/balance";
import { hashSeed } from "../lib/game/rng";
import { formatFairness } from "../lib/game/map/fairness";
import { randomSquads } from "../lib/game/map/spawn";
import { generateWorld } from "../lib/game/map/world";
import { CODE_TERRAIN, idx } from "../lib/game/map/terrain";

/** `docs/01` §3.2：切成 64×64 的 chunk，每格 1 byte */
const CHUNK = 64;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function main() {
  const rawSeed = arg("seed", "12345")!;
  const seed = /^\d+$/.test(rawSeed) ? Number(rawSeed) : hashSeed(rawSeed);
  const outDir = arg("out");
  const asJson = process.argv.includes("--json");
  const squadShare = Number(arg("squadShare", "0.25"));

  const world = generateWorld(seed, {
    squads: randomSquads(seed, squadShare),
    onProgress: asJson ? undefined : (m) => console.log(`  · ${m}`),
  });

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          seed: world.seed,
          seedAttempts: world.seedAttempts,
          elapsedMs: world.elapsedMs,
          ruins: world.ruins,
          areas: world.split.areas,
          fairness: world.fairness,
          spawnCount: world.spawns.points.length,
        },
        null,
        2,
      ),
    );
    process.exit(world.fairness.pass ? 0 : 1);
  }

  const chunksPerRow = Math.ceil(MAP.width / CHUNK);
  const chunksPerCol = Math.ceil(MAP.height / CHUNK);

  console.log(`\n  RuinCity 地圖生成 · seed ${world.seed}`);
  console.log(
    `  ${world.seedAttempts} 次嘗試 · ${world.elapsedMs} ms · ${chunksPerRow}×${chunksPerCol} = ${chunksPerRow * chunksPerCol} 個 chunk\n`,
  );

  console.log("  ── 地形佔比 ──────────────────────────────────────");
  for (const t of TERRAINS) {
    const share = world.terrainStats.share[t];
    console.log(`  ${t.padEnd(9)} ${(share * 100).toFixed(2).padStart(6)}%`);
  }
  console.log(
    `  抹平孤立山塊 ${world.terrainStats.prunedBlobs} 塊 · ` +
      `為連通性鑿開 ${world.terrainStats.carvedForConnectivity} 格 · ` +
      `最大連通區佔可通行格 ${(world.terrainStats.largestPassableShare * 100).toFixed(2)}%`,
  );

  console.log("\n  ── 三座遺跡 ──────────────────────────────────────");
  for (const r of world.ruins) console.log(`  ${r.name}  (${r.x}, ${r.y})`);
  console.log(
    `  兩兩距離 ${world.ruinPlacement.pairDistances.map((d) => d.toFixed(0)).join(" / ")} 格` +
      ` · 內角 ${world.ruinPlacement.triangleAnglesDeg.map((a) => a.toFixed(0)).join(" / ")}°` +
      ` · 重心偏移 ${world.ruinPlacement.centroidOffset.toFixed(1)} 格`,
  );
  console.log(
    `  陣營可用面積 ${([1, 2, 3] as const).map((f) => world.split.areas[f].toLocaleString()).join(" / ")}`,
  );

  console.log("\n  ── 出生點 ────────────────────────────────────────");
  for (const b of SPAWN_BANDS) {
    const rows = world.spawns.fill.filter((f) => f.band === b);
    console.log(
      `  ${b.padEnd(10)} ${rows.map((r) => `陣營${r.faction} ${r.placed}/${r.quota}`).join("  ")}`,
    );
  }
  console.log(
    `  合計 ${world.spawns.points.length} 人 · 未能整組安置的小隊 ${world.spawns.brokenSquads} 組`,
  );

  console.log("\n  ── 公平性驗證（封盤期公布）──────────────────────");
  console.log(formatFairness(world.fairness));
  console.log(`\n  ${world.fairness.pass ? "✓ 全數通過" : "✗ 未全數通過"}\n`);

  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    let bytes = 0;
    for (let cy = 0; cy < chunksPerCol; cy++) {
      for (let cx = 0; cx < chunksPerRow; cx++) {
        const buf = new Uint8Array(CHUNK * CHUNK);
        for (let y = 0; y < CHUNK; y++) {
          for (let x = 0; x < CHUNK; x++) {
            const gx = cx * CHUNK + x;
            const gy = cy * CHUNK + y;
            // 超出地圖的部分填成山脈（深淵不可通行）
            buf[y * CHUNK + x] =
              gx < MAP.width && gy < MAP.height
                ? world.map.cells[idx(gx, gy, MAP.width)]!
                : CODE_TERRAIN.indexOf("MOUNTAIN");
          }
        }
        writeFileSync(join(outDir, `${cx}_${cy}.bin`), buf);
        bytes += buf.length;
      }
    }

    writeFileSync(
      join(outDir, "meta.json"),
      JSON.stringify(
        {
          seed: world.seed,
          width: MAP.width,
          height: MAP.height,
          chunk: CHUNK,
          chunksPerRow,
          chunksPerCol,
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

    console.log(
      `  已寫出 ${chunksPerRow * chunksPerCol} 個 chunk（${(bytes / 1024).toFixed(0)} KB）+ meta.json → ${outDir}\n`,
    );
  }

  process.exit(world.fairness.pass ? 0 : 1);
}

/** 序列化時的地形碼對照，讓前端不必重複寫一份 */
function terrainCodeTable(): Record<string, number> {
  return Object.fromEntries(TERRAINS.map((t, i) => [t, i]));
}

main();
