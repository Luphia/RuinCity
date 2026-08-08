/**
 * 由玩家的建築與領土推導出**速率**。純函式，無 I/O。
 *
 * 這是「快照 + 速率」模型裡的**速率**那一半：
 * 每當建築完成、領土變動、或設施升級，都要重算一次並寫回資料庫。
 * 讀取時就只要 `快照 + 速率 × 時間`（見 `settle.ts`）。
 */

import {
  CITADEL,
  CORE_BUILDING_EFFECT,
  FACILITY,
  OUTPOST,
  POPULATION,
  TIME_SCALE,
  type Facility,
} from "./balance";
import {
  citadelBaseYieldPerHour,
  populationCap,
  populationGrowthPerHour,
  storageCapacity,
  territoryCapacity,
  tileYieldPerHour,
} from "./formulas";
import type { Amounts } from "./settle";
import { zeroAmounts } from "./settle";
import { yieldMultiplierFor, type OwnedTile } from "./territory";
import { TILE_RESOURCE, type Terrain } from "./balance";

export interface TileWithFacility extends OwnedTile {
  readonly facility: Facility | null;
  readonly facilityLevel: number;
  readonly terrain: Terrain;
  /** 野地等級（docs/02 §2.5），佔領時抄定。1 = 無加成；征服來的 2–5 有生產加成 */
  readonly level?: number;
}

export interface EconomyInputs {
  readonly citadel: number;
  readonly depotLevel: number;
  readonly tiles: readonly TileWithFacility[];
  /** 科技加成，例如耕作 Lv5 → 0.2 */
  readonly cultivationBonus?: number;
  readonly extractionBonus?: number;
  /**
   * 出生環帶的領土容量加成（前線 +1，見 `lib/game/season.ts`）。
   * 這是常數，賽季一開始就固定，但它必須流進速率推導 ——
   * 否則 `docs/13` §5 承諾的補償只存在於文件裡。
   */
  readonly bandBonus?: number;
}

export interface DerivedRates {
  /** 每真實小時的基準產出（尚未套用季節係數） */
  readonly baseRates: Amounts;
  readonly capacity: number;
  readonly populationCap: number;
  readonly populationRate: number;
  readonly territoryCapacity: number;
  /** 前哨營等級總和，儲存上限要用 */
  readonly outpostLevels: number;
}

/**
 * 重算全部速率。
 *
 * 每一項都必須可追溯到 `docs/11`：
 * - 主堡保底產出 `5 × L`／種／小時（讓玩家永遠不會完全餓死）
 * - 設施產出 `係數 × L^1.35`，乘地形修正與孤立懲罰
 * - 儲存上限 = `(2000 + 150×主堡) × (1 + 0.4×倉庫) + 5000×前哨營等級`
 * - 人口上限由主堡決定、成長率由領土決定
 */
export function deriveRates(input: EconomyInputs): DerivedRates {
  const baseRates = zeroAmounts();

  // 主堡保底：每種資源 5 × 等級 /h（已含 TIME_SCALE）
  const floor = citadelBaseYieldPerHour(input.citadel);
  for (const r of ["grain", "timber", "stone", "iron"] as const) baseRates[r] += floor;

  let outpostLevels = 0;
  let normalTiles = 0;

  for (const tile of input.tiles) {
    if (tile.facility === "OUTPOST") outpostLevels += tile.facilityLevel;
    if (tile.state !== "ISOLATED") normalTiles++;

    /**
     * ★ 格子是資源，設施是開採（docs/11 §22.4）：
     *   每一格領地本身就有固定產出（base × 野地等級，佔領即有），
     *   對口的開採設施把它放大（滿級 ×5）。荒地回 null —— 不產。
     */
    const y = tileYieldPerHour(tile.terrain, tile.level ?? 1, tile.facility, tile.facilityLevel, {
      techBonus:
        (TILE_RESOURCE[tile.terrain]?.resource ?? "grain") === "grain"
          ? (input.cultivationBonus ?? 0)
          : (input.extractionBonus ?? 0),
    });
    if (!y) continue;

    // 孤立領土產出減半（`docs/02` §2.4）
    baseRates[y.resource] += y.perHour * yieldMultiplierFor(tile.state);
  }

  return {
    baseRates,
    capacity: storageCapacity(input.citadel, input.depotLevel, outpostLevels),
    populationCap: populationCap(input.citadel),
    // 成長率由**連通的**領土決定 —— 被切斷的地不生人
    populationRate: populationGrowthPerHour(input.citadel, normalTiles),
    territoryCapacity: territoryCapacity(input.citadel, input.bandBonus ?? 0),
    outpostLevels,
  };
}

/** 前哨營的糧食維護費，單獨算出來塞進 `baseUpkeep` */
export function outpostUpkeep(outpostLevels: number): Amounts {
  const up = zeroAmounts();
  if (outpostLevels > 0) up.grain = OUTPOST.upkeepGrainPerHour * TIME_SCALE * outpostLevels;
  return up;
}

/**
 * 地窖保護量：被掠奪時保得住多少。春季 ×2（`docs/11` §11）。
 */
export function vaultAmount(
  citadelLevel: number,
  depotLevel: number,
  springMultiplier: number,
): number {
  return Math.round(
    (300 + CORE_BUILDING_EFFECT.depotVaultPerLevel * depotLevel + 30 * citadelLevel) *
      springMultiplier,
  );
}

/** UI 用的摘要 */
export interface EconomySummary {
  readonly perHour: Amounts;
  readonly capacity: number;
  readonly territoryUsed: number;
  readonly territoryCap: number;
  readonly popCap: number;
  readonly popRate: number;
}

export function summarise(input: EconomyInputs, seasonProduction: number): EconomySummary {
  const derived = deriveRates(input);
  const perHour = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    perHour[r] = derived.baseRates[r] * seasonProduction;
  }
  perHour.grain -= outpostUpkeep(derived.outpostLevels).grain;

  return {
    perHour,
    capacity: derived.capacity,
    territoryUsed: input.tiles.length,
    territoryCap: derived.territoryCapacity,
    popCap: derived.populationCap,
    popRate: derived.populationRate,
  };
}

export { CITADEL, FACILITY, POPULATION };
