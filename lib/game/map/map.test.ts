import { describe, expect, it } from "vitest";

import {
  FAIRNESS_THRESHOLDS,
  MAP,
  RUIN_PLACEMENT,
  SPAWN_BAND,
  SPAWN_BANDS,
  ROSTER,
  TERRAIN,
  TERRAINS,
} from "../balance";
import { deriveSeed, hashSeed, mulberry32 } from "../rng";
import { discCountField } from "./field";
import { evaluateFairness } from "./fairness";
import { quantile } from "./noise";
import { splitRegions } from "./regions";
import { inNoBuildZone, ruinCandidates, triangleAngles } from "./ruins";
import { allocateSpawns, isLegalSpawn, randomSquads } from "./spawn";
import { CODE_TERRAIN, TERRAIN_CODE, generateTerrain, idx, terrainAt } from "./terrain";
import { buildProfiles, terrainMultiplier } from "./profile";
import { generateWorld } from "./world";

/** 生成一次就好 —— 整份測試共用，否則每個 case 都要付 0.8 秒 */
const SEED = 99991;
const world = generateWorld(SEED, { squads: randomSquads(SEED, 0.25) });

describe("決定性亂數", () => {
  it("同一個 seed 產生同一個序列", () => {
    const a = Array.from({ length: 8 }, mulberry32(42));
    const b = Array.from({ length: 8 }, mulberry32(42));
    expect(a).toEqual(b);
    expect(a).not.toEqual(Array.from({ length: 8 }, mulberry32(43)));
  });

  it("字串 seed 穩定，且不同標籤衍生出不同的子 seed", () => {
    expect(hashSeed("S01-2026-08")).toBe(hashSeed("S01-2026-08"));
    expect(deriveSeed(1, "terrain")).not.toBe(deriveSeed(1, "spawn"));
  });
});

describe("分位數", () => {
  it("回傳指定分位的值，且不改動輸入", () => {
    const v = new Float32Array([5, 1, 4, 2, 3]);
    expect(quantile(v, 0)).toBe(1);
    expect(quantile(v, 1)).toBe(5);
    expect(Array.from(v)).toEqual([5, 1, 4, 2, 3]);
  });
});

describe("地形生成", () => {
  it("★ 佔比精準命中 docs/01 §2，因為門檻取的是分位數而不是硬寫的雜訊值", () => {
    for (const t of TERRAINS) {
      const actual = world.terrainStats.share[t];
      // 山脈會因為遺跡整地與連通性打通而略減，所以只設下限
      if (t === "MOUNTAIN") {
        expect(actual).toBeLessThanOrEqual(TERRAIN[t].share);
        expect(actual).toBeGreaterThan(TERRAIN[t].share * 0.85);
      } else {
        expect(actual, t).toBeCloseTo(TERRAIN[t].share, 2);
      }
    }
  });

  it("★ 所有可通行格連成一塊 —— 不會有玩家被山圍死", () => {
    expect(world.terrainStats.largestPassableShare).toBe(1);
  });

  it("同一個 seed 生成同一張圖", () => {
    const a = generateTerrain(555);
    const b = generateTerrain(555);
    expect(Array.from(a.map.cells)).toEqual(Array.from(b.map.cells));
  });

  it("界外一律視為山脈（深淵不可通行）", () => {
    expect(terrainAt(world.map, -1, 0)).toBe("MOUNTAIN");
    expect(terrainAt(world.map, MAP.width, 0)).toBe("MOUNTAIN");
  });
});

describe("遺跡放置", () => {
  it("滿足 docs/01 §4 的全部約束", () => {
    const p = world.ruinPlacement;
    for (const d of p.pairDistances) {
      expect(d).toBeGreaterThanOrEqual(RUIN_PLACEMENT.minPairDistance);
      expect(d).toBeLessThanOrEqual(RUIN_PLACEMENT.maxPairDistance);
    }
    for (const a of p.triangleAnglesDeg) {
      expect(a).toBeGreaterThanOrEqual(RUIN_PLACEMENT.minTriangleAngleDeg);
    }
    for (const s of world.ruins) {
      expect(Math.min(s.x, s.y, MAP.width - 1 - s.x, MAP.height - 1 - s.y)).toBeGreaterThanOrEqual(
        RUIN_PLACEMENT.minDistanceToEdge,
      );
    }
  });

  it("遺跡本體 3×3 被整平為平原，周圍 2 格沒有山脈", () => {
    for (const s of world.ruins) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          expect(terrainAt(world.map, s.x + dx, s.y + dy)).toBe("PLAIN");
        }
      }
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          expect(terrainAt(world.map, s.x + dx, s.y + dy)).not.toBe("MOUNTAIN");
        }
      }
    }
  });

  it("禁建圈半徑 12", () => {
    const s = world.ruins[0]!;
    expect(inNoBuildZone(world.ruins, s.x, s.y)).toBe(true);
    expect(inNoBuildZone(world.ruins, s.x + RUIN_PLACEMENT.noBuildRadius, s.y)).toBe(true);
    expect(inNoBuildZone(world.ruins, s.x + RUIN_PLACEMENT.noBuildRadius + 1, s.y)).toBe(false);
  });

  it("三角形內角加總為 180°", () => {
    const sum = triangleAngles(world.ruins).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(180, 4);
  });

  it("★ 候選必須靠近地圖中心，否則面積永遠不平衡", () => {
    // 只靠 docs/01 §4 的三條約束，40 次擺放的面積差異中位數是 48.7%，
    // 沒有一次進得了公平性檢查 (e) 的 5%
    const candidates = ruinCandidates(4242, 5);
    const cx = (MAP.width - 1) / 2;
    const cy = (MAP.height - 1) / 2;
    for (const c of candidates) {
      const gx = c.sites.reduce((s, p) => s + p.x, 0) / 3;
      const gy = c.sites.reduce((s, p) => s + p.y, 0) / 3;
      expect(Math.hypot(gx - cx, gy - cy)).toBeLessThanOrEqual(30);
      expect(c.centroidOffset).toBeCloseTo(Math.hypot(gx - cx, gy - cy), 5);
    }
  });
});

describe("三分天下（行軍成本 Voronoi）", () => {
  it("每個可通行格都屬於某個陣營，山脈不屬於任何一方", () => {
    let assigned = 0;
    let mountains = 0;
    for (let i = 0; i < world.map.cells.length; i++) {
      const isMountain = world.map.cells[i] === TERRAIN_CODE.MOUNTAIN;
      const owner = world.split.owner[i]!;
      if (isMountain) {
        mountains++;
        expect(owner).toBe(-1);
      } else {
        expect(owner).toBeGreaterThanOrEqual(1);
        assigned++;
      }
    }
    expect(assigned + mountains).toBe(MAP.width * MAP.height);
  });

  it("遺跡所在格屬於自己的陣營，成本距離為 0", () => {
    for (const s of world.ruins) {
      const i = idx(s.x, s.y, MAP.width);
      expect(world.split.owner[i]).toBe(s.id);
      expect(world.split.costDistance[i]).toBe(0);
    }
  });

  it("★ 成本距離必須用 Float64 存 —— Float32 的捨入會讓 Dijkstra 不收斂", () => {
    // 捨入後的值可能大於實際值，同一條邊會被無限重複鬆弛
    expect(world.split.costDistance).toBeInstanceOf(Float64Array);
    // 可通行格一定算得出距離；山脈永遠是 Infinity（到不了就是到不了）
    for (let i = 0; i < world.map.cells.length; i++) {
      const isMountain = world.map.cells[i] === TERRAIN_CODE.MOUNTAIN;
      expect(Number.isFinite(world.split.costDistance[i]!)).toBe(!isMountain);
    }
  });

  it("重跑同一組輸入得到同一個分割", () => {
    const again = splitRegions(world.map, world.ruins);
    expect(again.areas).toEqual(world.split.areas);
  });
});

describe("出生點分配", () => {
  it("恰好 600 人，每個環帶名額填滿", () => {
    expect(world.spawns.points.length).toBe(ROSTER.playersTotal);
    for (const f of world.spawns.fill) expect(f.placed).toBe(f.quota);
  });

  it("每個出生點都合法：非山脈、不在禁建圈、離邊界 ≥ 10", () => {
    for (const p of world.spawns.points) {
      expect(isLegalSpawn(world.map, world.ruins, p.x, p.y)).toBe(true);
    }
  });

  it("沒有兩個人生在同一格", () => {
    const seen = new Set(world.spawns.points.map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(world.spawns.points.length);
  });

  it("每個人都落在自己陣營的區域裡，且距離符合所選環帶", () => {
    const ruinOf = new Map(world.ruins.map((r) => [r.id, r]));
    for (const p of world.spawns.points) {
      expect(world.split.owner[idx(p.x, p.y, MAP.width)]).toBe(p.faction);
      const home = ruinOf.get(p.faction)!;
      const d = Math.hypot(p.x - home.x, p.y - home.y);
      const [lo, hi] = SPAWN_BAND[p.band].radius;
      expect(d).toBeGreaterThanOrEqual(lo);
      expect(d).toBeLessThan(hi);
    }
  });

  it("同行小隊的成員彼此在 8–15 格的群集內", () => {
    const squads = new Map<number, (typeof world.spawns.points)[number][]>();
    for (const p of world.spawns.points) {
      if (p.squad === null) continue;
      const list = squads.get(p.squad) ?? [];
      list.push(p);
      squads.set(p.squad, list);
    }
    expect(squads.size).toBeGreaterThan(0);
    for (const members of squads.values()) {
      expect(members.length).toBeLessThanOrEqual(8);
      // 每位成員至少有一個隊友在群集距離內
      for (const m of members) {
        if (members.length === 1) continue;
        const nearest = Math.min(
          ...members.filter((q) => q !== m).map((q) => Math.hypot(q.x - m.x, q.y - m.y)),
        );
        expect(nearest).toBeLessThanOrEqual(30);
      }
    }
  });

  it("分配是決定性的", () => {
    const again = allocateSpawns(world.map, world.ruins, world.split, world.seed, {
      squads: randomSquads(world.seed, 0.25),
    });
    expect(again.points.map((p) => `${p.x},${p.y}`)).toEqual(
      world.spawns.points.map((p) => `${p.x},${p.y}`),
    );
  });
});

describe("公平性驗證", () => {
  it("五項全數通過", () => {
    for (const c of world.fairness.checks) {
      expect(c.pass, `${c.key} ${c.label} = ${c.actual}`).toBe(true);
    }
    expect(world.fairness.pass).toBe(true);
  });

  it("(a) 與 (d) 沿用 docs/13 的門檻", () => {
    const byKey = new Map(world.fairness.checks.map((c) => [c.key, c]));
    expect(byKey.get("a")!.threshold).toBe(FAIRNESS_THRESHOLDS.buildableTilesStdDev);
    expect(byKey.get("d")!.threshold).toBe(FAIRNESS_THRESHOLDS.valuableTerrainStdDev);
    expect(byKey.get("e")!.threshold).toBe(FAIRNESS_THRESHOLDS.factionAreaDiff);
  });

  it("★ 對隨機（未經公平性篩選）的出生點應該要失敗", () => {
    // 這保證檢查本身是有鑑別力的，而不是恆真
    const rng = mulberry32(7);
    const legal = [] as { x: number; y: number }[];
    for (let k = 0; k < 60000 && legal.length < 600; k++) {
      const x = Math.floor(rng() * MAP.width);
      const y = Math.floor(rng() * MAP.height);
      if (isLegalSpawn(world.map, world.ruins, x, y)) legal.push({ x, y });
    }
    const fake = legal.map((p, i) => ({
      ...world.spawns.points[i]!,
      x: p.x,
      y: p.y,
    }));
    const report = evaluateFairness(world.map, world.ruins, world.split, fake);
    expect(report.pass).toBe(false);
  });
});

describe("圓盤鄰域統計", () => {
  it("與逐格暴力計算一致", () => {
    const mask = new Uint8Array(MAP.width * MAP.height);
    for (let i = 0; i < mask.length; i++) mask[i] = world.map.cells[i] === TERRAIN_CODE.LODE ? 1 : 0;
    const field = discCountField(mask, 6);

    for (const [cx, cy] of [
      [100, 100],
      [3, 3],
      [MAP.width - 2, MAP.height - 2],
    ] as const) {
      let brute = 0;
      for (let dy = -6; dy <= 6; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          if (dx * dx + dy * dy > 36) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) continue;
          brute += mask[idx(x, y, MAP.width)]!;
        }
      }
      expect(field.counts[idx(cx, cy, MAP.width)]).toBe(brute);
    }
  });
});

describe("玩家空間資料", () => {
  const spatial = buildProfiles(world);

  it("每個陣營恰好 5 個聯盟、每盟 40 人", () => {
    const counts = new Map<string, number>();
    for (const p of spatial.players) {
      const k = `${p.faction}-${p.alliance}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(ROSTER.alliancesTotal);
    for (const n of counts.values()) expect(n).toBe(ROSTER.playersPerAlliance);
  });

  it("★ 可用地是有限的：有人的地圖空間遠少於主堡能給的領土容量", () => {
    const tiles = spatial.players.map((p) => p.availableTiles);
    const min = Math.min(...tiles);
    expect(min).toBeGreaterThan(0);
    // 主堡 Lv27 給 81 塊容量，但最擠的那位周圍分不到那麼多地
    expect(min).toBeLessThan(81);
  });

  it("地形倍率隨著要蓋的數量增加而下降 —— 好地是有限的", () => {
    for (const p of spatial.players.slice(0, 50)) {
      // 前綴和存在 Float32 裡，所以留一點捨入餘裕
      expect(terrainMultiplier(p, "SAWMILL", 5) + 1e-4).toBeGreaterThanOrEqual(
        terrainMultiplier(p, "SAWMILL", 60),
      );
    }
  });

  it("鄰居關係是對稱的", () => {
    for (const p of spatial.players) {
      for (const n of p.neighbours) {
        const back = spatial.players[n.index]!.neighbours.find((m) => m.index === p.index);
        expect(back).toBeDefined();
        expect(back!.distance).toBeCloseTo(n.distance, 6);
      }
    }
  });

  it("所有人都在 8 小時行軍上限內打得到自家遺跡", () => {
    // 環帶外半徑 105 格，帶攻城單位也該進得去 —— 否則自家遺跡是拿不到的
    for (const p of spatial.players) expect(p.ruinReachableWithSiege).toBe(true);
  });

  it("主堡所在格的地形不是山脈", () => {
    for (const p of spatial.players) expect(p.homeTerrain).not.toBe("MOUNTAIN");
  });
});

describe("整體世界生成", () => {
  it("在驗收預算（90 秒）內完成", () => {
    expect(world.elapsedMs).toBeLessThan(90_000);
  });

  it("地形碼與 TERRAINS 的索引一致（序列化格式的契約）", () => {
    for (const [i, t] of TERRAINS.entries()) {
      expect(TERRAIN_CODE[t]).toBe(i);
      expect(CODE_TERRAIN[i]).toBe(t);
    }
  });

  it("三個出生帶的名額加總為每陣營 200 人", () => {
    const total = SPAWN_BANDS.reduce((s, b) => s + SPAWN_BAND[b].quota, 0);
    expect(total).toBe(ROSTER.playersPerFaction);
  });
});
