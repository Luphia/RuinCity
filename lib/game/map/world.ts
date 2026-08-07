/**
 * 世界生成的總指揮。純函式，無 I/O。
 * 對應 docs/01-world-map.md §3 與 docs/13-season-registration.md §3。
 *
 * 一次 `generateWorld(seed)` 產出賽季開始所需的全部靜態資料：
 * 地形、三座遺跡、三分天下的 Voronoi、600 個出生點、以及五項公平性驗證的數字。
 */

import { deriveSeed } from "../rng";
import { generateTerrain, type TerrainMap, type TerrainStats } from "./terrain";
import { ruinCandidates, stampRuins, type RuinCandidate, type RuinSite } from "./ruins";
import { splitRegions, type RegionSplit } from "./regions";
import { allocateSpawns, type AllocateOptions, type SpawnAllocation } from "./spawn";
import { evaluateFairness, type FairnessReport } from "./fairness";

export interface World {
  readonly seed: number;
  readonly map: TerrainMap;
  readonly terrainStats: TerrainStats;
  readonly ruins: readonly RuinSite[];
  readonly ruinPlacement: RuinCandidate;
  readonly split: RegionSplit;
  readonly spawns: SpawnAllocation;
  readonly fairness: FairnessReport;
  /** 換了幾次 seed */
  readonly seedAttempts: number;
  readonly elapsedMs: number;
}

export interface GenerateWorldOptions extends AllocateOptions {
  /** 每張地形試幾組遺跡擺放，取面積最平衡的那一組 */
  readonly ruinCandidateCount?: number;
  /** 公平性驗證失敗時最多換幾次 seed */
  readonly maxSeedAttempts?: number;
  /** 每一步的計時與中間結果 */
  readonly onProgress?: (message: string) => void;
}

/**
 * ★ 為什麼要在候選中挑，而不是照 `docs/13` §3 那樣「不過就換 seed」。
 *
 * 只用文件上的三條遺跡約束做拒絕採樣，40 次擺放的陣營面積差異
 * 中位數是 48.7%，最好的一次 12.6% —— 通過率是 0，換一萬次 seed 也一樣。
 * 面積平衡幾乎完全由遺跡三角形的位置與朝向決定，跟地形雜訊關係不大，
 * 所以正確的做法是**在同一張地形上挑遺跡擺放**（一次 Voronoi 只要 250 ms），
 * 而不是把整張地形丟掉重生（0.8 s，而且對面積毫無幫助）。
 */
const DEFAULT_RUIN_CANDIDATES = 24;

export function generateWorld(seed: number, opts: GenerateWorldOptions = {}): World {
  const started = Date.now();
  const candidateCount = opts.ruinCandidateCount ?? DEFAULT_RUIN_CANDIDATES;
  const maxAttempts = opts.maxSeedAttempts ?? 8;
  const log = opts.onProgress ?? (() => undefined);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptSeed = attempt === 1 ? seed : deriveSeed(seed, `reseed-${attempt}`);

    const { map, stats } = generateTerrain(attemptSeed);
    log(`地形生成完成（seed ${attemptSeed}）`);

    // 遺跡擺放會改寫地圖，所以先留一份乾淨的地形
    const pristine = Uint8Array.from(map.cells);

    let best: { candidate: RuinCandidate; split: RegionSplit } | null = null;
    const candidates = ruinCandidates(attemptSeed, candidateCount);
    for (const candidate of candidates) {
      map.cells.set(pristine);
      stampRuins(map, candidate.sites);
      const split = splitRegions(map, candidate.sites);
      if (!best || split.areaDiff < best.split.areaDiff) best = { candidate, split };
    }
    if (!best) continue;

    // 用最佳擺放重建地圖（上一輪迴圈可能停在別的候選上）
    map.cells.set(pristine);
    stampRuins(map, best.candidate.sites);
    const split = splitRegions(map, best.candidate.sites);
    log(
      `遺跡擺放：${candidates.length} 組候選，最佳面積差異 ${(split.areaDiff * 100).toFixed(2)}%`,
    );

    const spawns = allocateSpawns(map, best.candidate.sites, split, attemptSeed, opts);
    log(`出生點分配：${spawns.points.length} 人`);

    const fairness = evaluateFairness(map, best.candidate.sites, split, spawns.points);
    log(`公平性驗證：${fairness.pass ? "通過" : "未通過"}`);

    const underfilled = spawns.fill.filter((f) => f.placed < f.quota);
    if (fairness.pass && underfilled.length === 0) {
      return {
        seed: attemptSeed,
        map,
        terrainStats: stats,
        ruins: best.candidate.sites,
        ruinPlacement: best.candidate,
        split,
        spawns,
        fairness,
        seedAttempts: attempt,
        elapsedMs: Date.now() - started,
      };
    }

    log(
      `第 ${attempt} 次未過${underfilled.length > 0 ? `（${underfilled.length} 個環帶名額未滿）` : ""}，換 seed`,
    );

    // 最後一次仍未過就把結果交出去，讓呼叫端看到數字而不是拿到例外
    if (attempt === maxAttempts) {
      return {
        seed: attemptSeed,
        map,
        terrainStats: stats,
        ruins: best.candidate.sites,
        ruinPlacement: best.candidate,
        split,
        spawns,
        fairness,
        seedAttempts: attempt,
        elapsedMs: Date.now() - started,
      };
    }
  }

  throw new Error("世界生成失敗");
}
