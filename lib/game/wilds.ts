/**
 * 野地：無主格的等級、守衛與生產加成。純函式，無 I/O。
 * 對應 `docs/02` §2.5 與 `docs/11` §22。
 *
 * ★ 等級**不入庫、不入地形檔**：由 (seed, x, y, terrain) 決定性推導，
 *   任何一端（客戶端顯示、行軍驗證、抵達結算、模擬）算出來都一樣。
 *   佔領那一刻抄進 `tiles.level` —— 與 terrain 同一個模式，抄一次整季不變。
 */

import { WILDS, type Terrain } from "./balance";
import type { Army } from "./army";
import { deriveSeed, mulberry32 } from "./rng";

/** 荒地與山脈沒有等級（0）：荒地可立旗直佔、山脈不可佔領 */
export function wildLevelAt(seed: number, x: number, y: number, terrain: Terrain): number {
  if (terrain === "WASTE" || terrain === "MOUNTAIN") return 0;

  // 權重輪盤：weight(L) = decay^(L-1)，低階佔多數
  const roll = mulberry32(deriveSeed(seed, `wild:${x}:${y}`))();
  let total = 0;
  const weights: number[] = [];
  for (let l = 0; l < WILDS.maxLevel; l++) {
    const w = Math.pow(WILDS.levelWeightDecay, l);
    weights.push(w);
    total += w;
  }
  let acc = 0;
  let level = 1;
  for (let l = 0; l < WILDS.maxLevel; l++) {
    acc += weights[l]! / total;
    if (roll < acc) {
      level = l + 1;
      break;
    }
  }

  // 礦脈與沼澤天生更值錢也更兇
  if (terrain === "LODE" || terrain === "MARSH") {
    level = Math.min(WILDS.maxLevel, level + WILDS.richTerrainBonus);
  }
  return level;
}

/** 這一格要不要打下來才佔得到 */
export function needsConquest(level: number): boolean {
  return level >= WILDS.guardedFromLevel;
}

/**
 * 野生守衛的規模與組成。
 * 距離 = **出兵者主堡**到目標的切比雪夫距離 —— 等級與距離是兩條獨立的軸：
 * 家門口的 lv2 一小隊民兵清得掉，40 格外的 lv5 是一場遠征。
 */
export function wildGuardsFor(level: number, distance: number): Army {
  if (!needsConquest(level)) return {};
  const population = Math.round(
    WILDS.garrison.base *
      Math.pow(WILDS.garrison.growth, level - 1) *
      (1 + Math.max(0, distance) / WILDS.distanceDivisor),
  );
  const archers = Math.round(
    population * Math.min(WILDS.archerShareMax, WILDS.archerSharePerLevel * level),
  );
  const militia = Math.max(0, population - archers);
  const out: Army = {};
  if (militia > 0) out.MILITIA = militia;
  if (archers > 0) out.ARCHER = archers;
  return out;
}

/** 巢穴的固有防禦（進戰鬥引擎的 innateDefense） */
export function wildInnateDefense(level: number): number {
  return needsConquest(level) ? WILDS.innateDefensePerLevel * level : 0;
}

/** 攻下的格子：設施產出的等級係數。lv0/lv1 = ×1.0（既有經濟曲線不動） */
export function wildProductionMultiplier(level: number): number {
  return 1 + WILDS.productionPerLevel * Math.max(0, level - 1);
}
