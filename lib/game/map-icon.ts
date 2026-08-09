/**
 * 地圖上的資源地圖示。純函式，無 I/O。
 *
 * ## ★ 為什麼不是 pips
 *
 * 第一版在資源格下緣畫「等級幾就幾顆點」。它回答得了「這一格幾級」，
 * 但答不出**那是什麼資源** —— 而玩家在地圖上找的從來不是等級，
 * 是「哪裡有木頭」。四種點排在一起長得一模一樣，
 * 要知道是哪一種只能點下去看 footer。
 *
 * 改成**地貌圖示**：稻田、森林、山洞、礦坑。它們不是 HUD 上那組
 * 商品圖示（麥穗／原木／石塊／鐵錠，`resource-icon.ts`）——
 * 那一組講的是「倉庫裡有什麼」，這一組講的是「地上長什麼」。
 * 同一個概念在兩種語境下該有兩種畫法：一個是貨物，一個是地景。
 *
 * ## ★ 等級用**大小**表示，不用數量
 *
 * 「等級愈高佔格子比例愈大」同時解掉兩件事：
 *
 *   1. 一眼看得出強弱 —— 面積是最容易比較的視覺量
 *   2. **密度自己收斂** —— lv1 的圖示只佔 38%，讀起來像地表的紋理；
 *      lv5 佔 92%，在一片碎點裡自己跳出來。
 *      「全圖都是重點就沒有一格是重點」（`docs/09` §12.5）
 *      這一版是用尺寸解的，不是用「只畫高等級」解的。
 *
 * ## 形狀而不是像素
 *
 * 這一層回傳的是**單位座標（0..1）的幾何形狀**，不是像素網格。
 * 地圖一次要畫幾百格，一格 16×16 的像素網格等於幾萬個 rect；
 * 而這四個圖示各只有十幾個形狀，而且放大到 32px 仍然銳利。
 *
 * 顏色是**語意 token**，由 `lib/render` 對到調色盤 ——
 * `/lib/game` 不該知道 PixiJS 或色碼。
 */

import {
  polyOf,
  rectOf,
  type IconPolyOf,
  type IconRectOf,
  type IconShapeOf,
} from "./icon-shape";

export type IconTone =
  | "shadow" // 底下那圈暗影（任何地形上都要看得見）
  | "dark" // 描邊／陰影面
  | "leaf" // 樹冠
  | "leafDark"
  | "wood" // 樹幹、木料
  | "crop" // 稻穗
  | "field" // 稻田的田面
  | "water" // 田埂前緣的一線水光
  | "rock" // 岩體
  | "rockDark"
  | "metal" // 礦坑的金屬構件
  | "hole"; // 洞口（最深）

/** 幾何基元共用（`icon-shape.ts`），語意 token 各自定義 */
export type IconRect = IconRectOf<IconTone>;
export type IconPoly = IconPolyOf<IconTone>;
export type IconShape = IconShapeOf<IconTone>;

export type TileResource = "grain" | "timber" | "stone" | "iron";

const rect = (x: number, y: number, w: number, h: number, tone: IconTone): IconRect =>
  rectOf(x, y, w, h, tone);
const poly = (points: readonly number[], tone: IconTone): IconPoly => polyOf(points, tone);

/**
 * ★ 稻田：三層梯田，由後往前愈來愈寬。
 *
 * 立體感來自三件事，缺一個就變成三條橫線：
 *   1. 每一層是**梯形**（前緣比後緣寬）—— 這就是俯視的透視
 *   2. 每一層下方有一道暗色的**田埂**（土牆的側面）
 *   3. 田埂上緣有一線水光，稻穗壓在田面上
 *
 * ★ 田面是**綠的不是藍的**。地圖上藍色已經是河與湖 ——
 *   把水田畫成一塊藍會讓玩家以為那裡有水域，而那是導航等級的誤導。
 *   水只留田埂上那一線，剛好夠讀出「這是水田不是旱地」。
 */
const PADDY: readonly IconShape[] = [
  poly([0.30, 0.16, 0.70, 0.16, 0.75, 0.32, 0.25, 0.32], "field"),
  rect(0.25, 0.30, 0.5, 0.03, "water"),
  rect(0.25, 0.33, 0.5, 0.05, "dark"),
  rect(0.36, 0.19, 0.03, 0.1, "crop"),
  rect(0.48, 0.19, 0.03, 0.1, "crop"),
  rect(0.60, 0.19, 0.03, 0.1, "crop"),

  poly([0.22, 0.39, 0.78, 0.39, 0.85, 0.57, 0.15, 0.57], "field"),
  rect(0.15, 0.55, 0.7, 0.03, "water"),
  rect(0.15, 0.58, 0.7, 0.06, "dark"),
  rect(0.28, 0.43, 0.035, 0.11, "crop"),
  rect(0.43, 0.43, 0.035, 0.11, "crop"),
  rect(0.58, 0.43, 0.035, 0.11, "crop"),
  rect(0.70, 0.43, 0.035, 0.11, "crop"),

  poly([0.12, 0.65, 0.88, 0.65, 0.96, 0.86, 0.04, 0.86], "field"),
  rect(0.04, 0.84, 0.92, 0.03, "water"),
  rect(0.04, 0.87, 0.92, 0.07, "dark"),
  rect(0.18, 0.69, 0.04, 0.13, "crop"),
  rect(0.34, 0.69, 0.04, 0.13, "crop"),
  rect(0.50, 0.69, 0.04, 0.13, "crop"),
  rect(0.66, 0.69, 0.04, 0.13, "crop"),
  rect(0.80, 0.69, 0.04, 0.13, "crop"),
];

/** 森林：兩棵後排 + 一棵前排大的。輪廓是三角形的疊影，遠看就是「一片林」 */
const FOREST: readonly IconShape[] = [
  // 後排左
  rect(0.20, 0.55, 0.05, 0.14, "wood"),
  poly([0.225, 0.14, 0.36, 0.44, 0.09, 0.44], "leafDark"),
  poly([0.225, 0.30, 0.40, 0.60, 0.05, 0.60], "leafDark"),
  // 後排右
  rect(0.74, 0.55, 0.05, 0.14, "wood"),
  poly([0.765, 0.16, 0.90, 0.46, 0.63, 0.46], "leafDark"),
  poly([0.765, 0.32, 0.94, 0.62, 0.59, 0.62], "leafDark"),
  // 前排（最大、最亮）
  rect(0.46, 0.72, 0.08, 0.18, "wood"),
  poly([0.50, 0.22, 0.70, 0.52, 0.30, 0.52], "leaf"),
  poly([0.50, 0.40, 0.76, 0.76, 0.24, 0.76], "leaf"),
];

/**
 * ★ 山洞：一座岩丘 + 底部的黑色拱口。
 *
 * 洞口必須**貼著底邊**：懸在半空的黑弧看起來像污漬，
 * 貼著地面才讀得出「可以走進去」。左側留一道亮面當受光，
 * 否則整塊岩體是一片平的灰。
 */
const CAVE: readonly IconShape[] = [
  poly([0.50, 0.12, 0.90, 0.62, 0.94, 0.88, 0.06, 0.88, 0.10, 0.62], "rock"),
  // 受光的左facet
  poly([0.50, 0.12, 0.10, 0.62, 0.30, 0.88, 0.42, 0.40], "rockDark"),
  // 洞口：上緣收成拱形
  poly([0.50, 0.50, 0.66, 0.66, 0.66, 0.88, 0.34, 0.88, 0.34, 0.66], "hole"),
];

/**
 * ★ 礦坑：A 字形井架 + 底下的豎井口。
 *
 * 不用「山＋十字鎬」是因為十字鎬在 16px 下只剩兩根斜線，
 * 跟森林的樹幹分不開。井架的三角形骨架與豎井的黑口是這個圖示
 * 唯一需要的兩個訊號。
 */
const MINE: readonly IconShape[] = [
  // 土堆
  poly([0.06, 0.90, 0.20, 0.72, 0.80, 0.72, 0.94, 0.90], "rockDark"),
  // 豎井口
  rect(0.36, 0.68, 0.28, 0.22, "hole"),
  // A 字井架
  poly([0.50, 0.10, 0.58, 0.14, 0.34, 0.72, 0.24, 0.72], "metal"),
  poly([0.50, 0.10, 0.42, 0.14, 0.66, 0.72, 0.76, 0.72], "metal"),
  rect(0.32, 0.44, 0.36, 0.06, "metal"),
  // 井口的橫梁
  rect(0.32, 0.64, 0.36, 0.05, "wood"),
];

const ART: Record<TileResource, readonly IconShape[]> = {
  grain: PADDY,
  timber: FOREST,
  stone: CAVE,
  iron: MINE,
};

/** 這種資源長什麼樣。荒地／山脈沒有資源，呼叫端就不會問到這裡 */
export function tileIconShapes(resource: TileResource): readonly IconShape[] {
  return ART[resource];
}

/**
 * 等級 → 圖示佔格子的比例。
 *
 * lv1 = 0.38、lv5 = 0.92，線性。★ 下限刻意不更小：
 * 再小就變成一顆看不出形狀的雜點，而「看不出是什麼」正是 pips 的毛病。
 */
export function iconScaleFor(level: number): number {
  const l = Math.max(1, Math.min(5, Math.round(level)));
  return 0.38 + ((l - 1) / 4) * 0.54;
}
