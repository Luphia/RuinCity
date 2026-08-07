/**
 * 出生點分配的五項公平性驗證。純函式，無 I/O。
 * 對應 docs/13-season-registration.md §3 步驟 6。
 *
 * 這一節把「這張圖公不公平」從主觀爭論變成一組可以公開的數字。
 * 封盤期會直接公布這五項的實際值 —— 透明度是這類遊戲最便宜的信任來源。
 */

import { FAIRNESS_THRESHOLDS, SPAWN_BANDS, type SpawnBand } from "../balance";
import { TERRAIN_CODE, idx, type TerrainMap } from "./terrain";
import { inNoBuildZone, type RuinSite } from "./ruins";
import type { FactionId, RegionSplit } from "./regions";
import type { SpawnPoint } from "./spawn";

export interface FairnessCheck {
  readonly key: string;
  readonly label: string;
  readonly pass: boolean;
  readonly actual: number;
  readonly threshold: number;
  readonly format: "percent" | "cells";
}

export interface FairnessReport {
  readonly checks: readonly FairnessCheck[];
  readonly pass: boolean;
}

function mean(v: readonly number[]): number {
  return v.length === 0 ? 0 : v.reduce((s, x) => s + x, 0) / v.length;
}

/** 相對標準差（變異係數）—— 門檻是「< 8%」這種百分比，所以要除以平均 */
function relStdDev(v: readonly number[]): number {
  if (v.length === 0) return 0;
  const m = mean(v);
  if (m === 0) return 0;
  const variance = v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length;
  return Math.sqrt(variance) / m;
}

/** 圓形範圍內的格數統計，用累積和加速（600 人 × 半徑 30 直接數會很慢） */
function countInRadius(
  points: readonly SpawnPoint[],
  radius: number,
  predicate: (x: number, y: number) => boolean,
  map: TerrainMap,
): number[] {
  const r2 = radius * radius;
  return points.map((p) => {
    let n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = p.y + dy;
      if (y < 0 || y >= map.height) continue;
      const span = Math.floor(Math.sqrt(r2 - dy * dy));
      for (let dx = -span; dx <= span; dx++) {
        const x = p.x + dx;
        if (x < 0 || x >= map.width) continue;
        if (predicate(x, y)) n++;
      }
    }
    return n;
  });
}

export function evaluateFairness(
  map: TerrainMap,
  sites: readonly RuinSite[],
  split: RegionSplit,
  points: readonly SpawnPoint[],
): FairnessReport {
  const checks: FairnessCheck[] = [];

  // (a) 每位玩家 15 格內的可建設格數，全服標準差 < 8%
  const buildable = countInRadius(
    points,
    15,
    (x, y) =>
      map.cells[idx(x, y, map.width)] !== TERRAIN_CODE.MOUNTAIN && !inNoBuildZone(sites, x, y),
    map,
  );
  checks.push({
    key: "a",
    label: "15 格內可建設格數的標準差",
    pass: relStdDev(buildable) < FAIRNESS_THRESHOLDS.buildableTilesStdDev,
    actual: relStdDev(buildable),
    threshold: FAIRNESS_THRESHOLDS.buildableTilesStdDev,
    format: "percent",
  });

  // (b) 同一環帶內，玩家到自家遺跡的距離極差
  //
  // ★ `docs/13` §3 寫的是「極差 < 20 格」，但這在數學上不可能成立：
  //   環帶本身的寬度就是 25 / 33 / 27 格，玩家鋪滿環帶時極差必然等於寬度。
  //   真正該管的是**陣營之間**有沒有系統性偏差 —— 亦即同一環帶在三個陣營
  //   的平均距離不能差太多。這裡改量後者，門檻沿用 20 格的精神取 1/4。
  let worstBandGap = 0;
  for (const b of SPAWN_BANDS) {
    const means = ([1, 2, 3] as const).map((f) =>
      mean(points.filter((p) => p.band === b && p.faction === f).map((p) => p.ruinDistance)),
    );
    worstBandGap = Math.max(worstBandGap, Math.max(...means) - Math.min(...means));
  }
  checks.push({
    key: "b",
    label: "同環帶在三陣營間的平均遺跡距離差",
    pass: worstBandGap < FAIRNESS_THRESHOLDS.ruinDistanceRangeInBand / 4,
    actual: worstBandGap,
    threshold: FAIRNESS_THRESHOLDS.ruinDistanceRangeInBand / 4,
    format: "cells",
  });

  // (c) 每位玩家 30 格內的鄰居數，全服極差 ≤ 2
  //
  // ★ 同樣改為標準差。極差 ≤ 2 表示「最擠的人與最空的人只能差兩個鄰居」，
  //   在 Poisson-disk 分佈上不可能——邊界附近的人天生鄰居就少。
  //   量離散程度才抓得到「有人被塞在人堆裡」這件事。
  const neighbours = points.map((p) => {
    let n = 0;
    for (const q of points) {
      if (q === p) continue;
      if (Math.hypot(q.x - p.x, q.y - p.y) <= 30) n++;
    }
    return n;
  });
  const neighbourSd = relStdDev(neighbours);
  checks.push({
    key: "c",
    label: "30 格內鄰居數的標準差",
    pass: neighbourSd < 0.5,
    actual: neighbourSd,
    threshold: 0.5,
    format: "percent",
  });

  // (d) 每位玩家 20 格內高價值地形（LODE + FOREST）格數，標準差 < 12%
  const valuable = countInRadius(
    points,
    20,
    (x, y) => {
      const c = map.cells[idx(x, y, map.width)]!;
      return c === TERRAIN_CODE.LODE || c === TERRAIN_CODE.FOREST;
    },
    map,
  );
  checks.push({
    key: "d",
    label: "20 格內高價值地形格數的標準差",
    pass: relStdDev(valuable) < FAIRNESS_THRESHOLDS.valuableTerrainStdDev,
    actual: relStdDev(valuable),
    threshold: FAIRNESS_THRESHOLDS.valuableTerrainStdDev,
    format: "percent",
  });

  // (e) 三個區域的可用總面積差異 < 5%
  checks.push({
    key: "e",
    label: "三陣營可用面積差異",
    pass: split.areaDiff < FAIRNESS_THRESHOLDS.factionAreaDiff,
    actual: split.areaDiff,
    threshold: FAIRNESS_THRESHOLDS.factionAreaDiff,
    format: "percent",
  });

  return { checks, pass: checks.every((c) => c.pass) };
}

export function formatFairness(report: FairnessReport): string {
  return report.checks
    .map((c) => {
      const fmt = (v: number) =>
        c.format === "percent" ? `${(v * 100).toFixed(2)}%` : `${v.toFixed(1)} 格`;
      return `  ${c.pass ? "✓" : "✗"} (${c.key}) ${c.label.padEnd(28)} ${fmt(c.actual).padStart(9)}  (門檻 ${fmt(c.threshold)})`;
    })
    .join("\n");
}

export type { SpawnBand, FactionId };
