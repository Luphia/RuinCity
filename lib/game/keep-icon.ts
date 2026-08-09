/**
 * 地圖上的**主城**圖示。純函式，無 I/O。
 *
 * ## ★ 為什麼不是一個色塊
 *
 * 在這之前，六百個據點在地圖上都是「一個聯盟色的 2×2 方塊，
 * 上緣加一小條當屋頂」。它答得出「那裡有人」，答不出**那是什麼**——
 * 一個方塊跟遺跡的方塊、跟被選取的格子長得太像。
 * 而主城是這張地圖上唯一「打爆就出局」的東西（`docs/13` §8），
 * 它值得一個自己的輪廓。
 *
 * ## ★ 佔滿 2×2，不多一格
 *
 * 核心據點就是 2×2（`docs/02` §1），所以圖示的單位座標 0..1
 * 對到的是**那四格的外框**。圖示不准溢出去：溢出去就會蓋到
 * 鄰格的地貌與領土框，而那一圈正是「這裡是誰的地」的答案。
 * （測試會擋下任何一個超出 0..1 的點。）
 *
 * ## ★ 三種樣式來自**城牆等級**（RAMPART），不是主堡等級
 *
 * 主堡等級是經濟的深度，城牆等級是**這座城好不好打** ——
 * 而地圖上那一眼要回答的問題只有一個：「我打得下來嗎」。
 * 所以分段的依據是城牆：
 *
 * | 段 | 城牆等級 | 樣式 | 輪廓的訊號 |
 * | --- | --- | --- | --- |
 * | 1 | 0–10 | 木寨 | 上緣是一排**尖樁**（鋸齒） |
 * | 2 | 11–22 | 石垣 | 上緣是**方齒女牆**，兩側各一座角樓 |
 * | 3 | 23–33 | 鐵壁 | 角樓戴尖頂、中央主樓**高過城牆**、鐵箍門 |
 *
 * 分段用的是比例（`CITADEL.maxLevel` 的三等分）而不是寫死的數字 ——
 * 天花板動的時候（33 是 M2 之後才從 30 改上來的）這裡不必跟著改。
 *
 * ★ 三段的**輪廓**必須不同，不能只是換顏色：地圖上同一個聯盟色的
 *   三座城如果只差色階，那等於沒有分段（`sprite.ts` 的同一條規則）。
 */

import { CITADEL } from "./balance";
import {
  polyOf,
  rectOf,
  type IconShapeOf,
} from "./icon-shape";

export type KeepTone =
  | "shadow" // 底下那圈暗影
  | "dark" // 描邊、門洞
  | "wood"
  | "woodDark"
  | "stone"
  | "stoneDark"
  | "metal"
  | "metalDark"
  | "roof" // 屋頂（鏽紅）
  | "roofDark"
  | "light" // 高光
  /** ★ 聯盟色 —— 由渲染層代入。`/lib/game` 不知道任何一個色碼 */
  | "banner";

export type KeepShape = IconShapeOf<KeepTone>;

export type KeepTier = 1 | 2 | 3;

export const KEEP_TIER_LABEL: Record<KeepTier, string> = {
  1: "木寨",
  2: "石垣",
  3: "鐵壁",
};

const rect = (x: number, y: number, w: number, h: number, tone: KeepTone) =>
  rectOf<KeepTone>(x, y, w, h, tone);
const poly = (points: readonly number[], tone: KeepTone) => polyOf<KeepTone>(points, tone);

/**
 * 城牆等級 → 三段。
 *
 * 界線是 `CITADEL.maxLevel` 的三等分（33 → 11 / 22）。
 * 沒有城牆（等級 0，玩家還沒把 RAMPART 蓋進 B/C/D 任一格）也是第 1 段 ——
 * 「還沒有牆」與「牆很矮」在地圖那個距離上是同一件事。
 */
export function keepTier(wallLevel: number): KeepTier {
  const max = Math.max(3, CITADEL.maxLevel);
  const level = Math.max(0, Math.min(max, Math.round(wallLevel || 0)));
  if (level < max / 3) return 1;
  if (level < (max * 2) / 3) return 2;
  return 3;
}

/** 一排尖樁／方齒的上緣。`teeth` 個、跨 [x0,x1]、高 `h` */
function crest(
  x0: number,
  x1: number,
  y: number,
  h: number,
  teeth: number,
  pointed: boolean,
  tone: KeepTone,
): KeepShape[] {
  const out: KeepShape[] = [];
  const span = (x1 - x0) / teeth;
  for (let i = 0; i < teeth; i++) {
    const left = x0 + i * span;
    if (pointed) {
      // 尖樁：三角形，頂點在中間
      out.push(poly([left, y, left + span, y, left + span / 2, y - h], tone));
    } else {
      // 女牆：方齒，齒與齒之間留一半的縫
      out.push(rect(left + span * 0.12, y - h, span * 0.62, h, tone));
    }
  }
  return out;
}

/**
 * 第 1 段 · 木寨（城牆 0–10）。
 *
 * 一圈尖樁圍著一座木造主樓。上緣的鋸齒是這一段唯一需要的訊號 ——
 * 遠遠看過去「毛毛的」就是還沒砌牆的城。
 */
const TIER1: readonly KeepShape[] = [
  // ── 主樓（在牆後面，所以先畫）──
  poly([0.50, 0.10, 0.74, 0.32, 0.26, 0.32], "roof"),
  poly([0.50, 0.10, 0.50, 0.32, 0.26, 0.32], "roofDark"),
  rect(0.30, 0.31, 0.40, 0.26, "wood"),
  rect(0.30, 0.31, 0.10, 0.26, "woodDark"),
  rect(0.44, 0.38, 0.12, 0.12, "dark"),
  // 旗桿與三角旗
  rect(0.485, 0.02, 0.03, 0.12, "woodDark"),
  poly([0.515, 0.025, 0.72, 0.065, 0.515, 0.105], "banner"),

  // ── 木柵（前緣）──
  rect(0.06, 0.56, 0.88, 0.28, "wood"),
  rect(0.06, 0.56, 0.88, 0.04, "light"),
  ...crest(0.06, 0.94, 0.56, 0.09, 11, true, "wood"),
  // 柵欄的直紋 —— 少了它是一塊木板，不是一排樁
  rect(0.19, 0.58, 0.025, 0.26, "woodDark"),
  rect(0.32, 0.58, 0.025, 0.26, "woodDark"),
  rect(0.645, 0.58, 0.025, 0.26, "woodDark"),
  rect(0.775, 0.58, 0.025, 0.26, "woodDark"),
  // 門
  rect(0.42, 0.62, 0.16, 0.22, "dark"),
  rect(0.44, 0.66, 0.12, 0.18, "woodDark"),
  // 地基的一線陰影
  rect(0.06, 0.84, 0.88, 0.05, "shadow"),
];

/**
 * 第 2 段 · 石垣（城牆 11–22）。
 *
 * 尖樁換成**方齒女牆**，兩側各長出一座角樓。
 * 輪廓從「毛毛的」變成「有稜有角的」—— 這就是「砌起來了」。
 */
const TIER2: readonly KeepShape[] = [
  // ── 主樓 ──
  poly([0.50, 0.08, 0.72, 0.28, 0.28, 0.28], "roof"),
  poly([0.50, 0.08, 0.50, 0.28, 0.28, 0.28], "roofDark"),
  rect(0.32, 0.27, 0.36, 0.30, "stone"),
  rect(0.32, 0.27, 0.09, 0.30, "stoneDark"),
  rect(0.445, 0.34, 0.11, 0.13, "dark"),
  rect(0.485, 0.00, 0.03, 0.11, "metalDark"),
  poly([0.515, 0.005, 0.71, 0.045, 0.515, 0.085], "banner"),

  // ── 城牆本體 ──
  rect(0.04, 0.55, 0.92, 0.30, "stone"),
  rect(0.04, 0.55, 0.92, 0.035, "light"),
  rect(0.04, 0.72, 0.92, 0.04, "stoneDark"), // 一道橫向的砌縫
  ...crest(0.10, 0.90, 0.55, 0.10, 7, false, "stone"),

  // ── 角樓（左右）──
  rect(0.02, 0.44, 0.16, 0.41, "stoneDark"),
  rect(0.02, 0.44, 0.16, 0.035, "light"),
  ...crest(0.02, 0.18, 0.44, 0.08, 2, false, "stoneDark"),
  rect(0.075, 0.52, 0.05, 0.09, "dark"),
  rect(0.82, 0.44, 0.16, 0.41, "stoneDark"),
  rect(0.82, 0.44, 0.16, 0.035, "light"),
  ...crest(0.82, 0.98, 0.44, 0.08, 2, false, "stoneDark"),
  rect(0.875, 0.52, 0.05, 0.09, "dark"),

  // ── 城門 ──
  rect(0.40, 0.60, 0.20, 0.25, "dark"),
  poly([0.42, 0.66, 0.50, 0.60, 0.58, 0.66, 0.58, 0.85, 0.42, 0.85], "woodDark"),
  rect(0.40, 0.585, 0.20, 0.03, "metalDark"),
  rect(0.04, 0.85, 0.92, 0.05, "shadow"),
];

/**
 * 第 3 段 · 鐵壁（城牆 23–33）。
 *
 * 角樓戴上尖頂、中央主樓**高過城牆**、城門加鐵箍。
 * 這一段的訊號是**天際線**：它是全圖唯一會在 2×2 裡長出尖塔的東西，
 * 遠遠看過去就知道「那座不好打」。
 */
const TIER3: readonly KeepShape[] = [
  // ── 中央尖塔（最高、最窄）──
  //   ★ 與第 2 段的差別刻意做在**比例**上，不只在細節上：
  //     石垣是一座矮胖的堡，鐵壁是一根戳出去的塔。
  //     32px 下細節全糊掉，只剩比例還說得出話。
  rect(0.485, 0.00, 0.03, 0.09, "metalDark"),
  poly([0.515, 0.005, 0.74, 0.045, 0.515, 0.085], "banner"),
  poly([0.50, 0.04, 0.64, 0.27, 0.36, 0.27], "roof"),
  poly([0.50, 0.04, 0.50, 0.27, 0.36, 0.27], "roofDark"),
  rect(0.37, 0.26, 0.26, 0.31, "stone"),
  rect(0.37, 0.26, 0.07, 0.31, "stoneDark"),
  rect(0.37, 0.35, 0.26, 0.035, "metalDark"), // 鐵箍
  rect(0.45, 0.41, 0.10, 0.13, "dark"),
  rect(0.45, 0.41, 0.10, 0.03, "light"),

  // ── 城牆本體（厚，兩層砌縫）──
  rect(0.02, 0.57, 0.96, 0.29, "stone"),
  rect(0.02, 0.57, 0.96, 0.035, "light"),
  rect(0.02, 0.66, 0.96, 0.035, "metalDark"),
  rect(0.02, 0.77, 0.96, 0.035, "stoneDark"),
  ...crest(0.08, 0.92, 0.57, 0.09, 6, false, "stone"),

  // ── 角樓：戴尖頂 ──
  rect(0.00, 0.40, 0.18, 0.46, "stoneDark"),
  rect(0.00, 0.40, 0.18, 0.035, "light"),
  poly([0.09, 0.24, 0.20, 0.40, -0.02, 0.40], "roof"),
  poly([0.09, 0.24, 0.09, 0.40, -0.02, 0.40], "roofDark"),
  rect(0.055, 0.48, 0.07, 0.10, "dark"),
  rect(0.82, 0.40, 0.18, 0.46, "stoneDark"),
  rect(0.82, 0.40, 0.18, 0.035, "light"),
  poly([0.91, 0.24, 1.02, 0.40, 0.80, 0.40], "roof"),
  poly([0.91, 0.24, 0.91, 0.40, 0.80, 0.40], "roofDark"),
  rect(0.87, 0.48, 0.07, 0.10, "dark"),

  // ── 鐵箍城門 ──
  rect(0.38, 0.62, 0.24, 0.24, "dark"),
  poly([0.40, 0.69, 0.50, 0.62, 0.60, 0.69, 0.60, 0.86, 0.40, 0.86], "metal"),
  rect(0.40, 0.74, 0.20, 0.03, "metalDark"),
  rect(0.40, 0.81, 0.20, 0.03, "metalDark"),
  rect(0.02, 0.86, 0.96, 0.05, "shadow"),
];

const ART: Record<KeepTier, readonly KeepShape[]> = { 1: TIER1, 2: TIER2, 3: TIER3 };

/**
 * 這一段的主城長什麼樣。單位座標 0..1 = 核心據點那 2×2 格的外框。
 *
 * ★ 尖頂的角樓會讓幾個點落在 [-0.02, 1.02] —— 那是**刻意**的：
 *   斜屋頂的兩個下角要壓在牆外緣才看得出屋簷。回傳前統一夾回 0..1，
 *   於是「輪廓有屋簷」與「不溢出 2×2」兩件事同時成立。
 */
export function keepIconShapes(tier: KeepTier): readonly KeepShape[] {
  return ART[tier].map(clampShape);
}

function clampShape(shape: KeepShape): KeepShape {
  const c = (v: number) => Math.max(0, Math.min(1, v));
  if (shape.kind === "rect") {
    const x = c(shape.x);
    const y = c(shape.y);
    return rect(x, y, c(shape.x + shape.w) - x, c(shape.y + shape.h) - y, shape.tone);
  }
  return poly(shape.points.map(c), shape.tone);
}
