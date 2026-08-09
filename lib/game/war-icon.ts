/**
 * 地圖上的**交戰中**動畫：兩把刀互相劈砍。純函式，無 I/O。
 * 對應 `docs/04` §3d（交戰是一段兩分鐘的窗口，不是一瞬間）。
 *
 * ## ★ 為什麼要動
 *
 * 在這之前，正在打的格子與打完的格子都是一個紅 ✕，
 * 差別只有「正在打的多一圈白環」。而這兩件事的意義差很多：
 * 打完的只是情報，**正在打的是還來得及參加的邀請**（`docs/09` §12.5）。
 * 一個會動的東西在一張靜止的地圖上是抓得住眼睛的，靜止的紅 ✕ 不是 ——
 * 所以「還打得到」值得一個動畫，而「打過了」不值得。
 *
 * ## ★ 一格就是一格
 *
 * 單位座標 0..1 對到的是**那一格的外框**，不多一個像素。
 * 溢出去就會蓋到鄰格 —— 而交戰常常發生在別人城牆邊上，
 * 一個溢出的圖示會讓玩家分不清打的是哪一格。
 * （測試掃過整個週期的每一幀，任何一個點超出 0..1 就會壞掉。）
 *
 * 至於**遠景**：L3（2px/格）不畫這個動畫，那個距離下 2px 的刀
 * 只是一顆會抖的雜點。戰略視圖仍然用脈動的紅 ✕ 加白環
 * —— 一格一格的細節與「哪一帶在燒」本來就是兩個問題。
 *
 * ## ★ 這裡沒有戰鬥引擎
 *
 * 這支動畫是**裝飾**，不讀任何戰鬥狀態：它不知道誰在打、誰要贏。
 * 與 `battlefield.ts` 的「進行中的動畫 losses 是空的」同一條規矩 ——
 * 畫面提前演出結果就等於第二個戰鬥引擎。
 * 它唯一需要知道的是「這一格還在打嗎」，而那是呼叫端的事
 * （`engagements.endsAt` 到了就不要再叫這個函式）。
 */

import {
  polyOf,
  rectOf,
  transformShapes,
  type IconPolyOf,
  type IconShapeOf,
} from "./icon-shape";

export type WarTone =
  | "shadow" // 底下那層暗色剪影（任何地形上都要看得見）
  | "blade" // 刃身
  | "bladeDark" // 刃的暗面
  | "edge" // 開鋒的那一線高光
  | "guard" // 護手與柄頭
  | "grip" // 握把
  | "spark" // 火花的外圈
  | "sparkCore"; // 火花的核心

export type WarShape = IconShapeOf<WarTone>;
/**
 * ★ 畫出來的東西一律是多邊形：刀是轉過的，而轉過的矩形已經不是
 *   軸對齊的矩形了（`icon-shape.ts` 的 `toPoly`）。呼叫端因此只需要
 *   一條路徑 —— 不必再問「這一塊是 rect 還是 poly」。
 */
export type WarPoly = IconPolyOf<WarTone>;

const rect = (x: number, y: number, w: number, h: number, tone: WarTone) =>
  rectOf<WarTone>(x, y, w, h, tone);
const poly = (points: readonly number[], tone: WarTone) => polyOf<WarTone>(points, tone);

/**
 * 一把刀的幾何：刃朝上，握把在下。
 *
 * 三個明度是必要的：只有一個色的刀在任何地形上都是一根棍子。
 * 暗面在左、高光在右 —— 兩把刀鏡射之後光源仍然一致（都從右上來）。
 */
const SWORD: readonly WarShape[] = [
  // 刃身
  rect(0.44, 0.16, 0.12, 0.46, "blade"),
  rect(0.44, 0.16, 0.045, 0.46, "bladeDark"),
  rect(0.525, 0.16, 0.035, 0.46, "edge"),
  // 刀尖
  poly([0.44, 0.17, 0.56, 0.17, 0.50, 0.05], "blade"),
  // 護手
  rect(0.31, 0.62, 0.38, 0.065, "guard"),
  // 握把
  rect(0.455, 0.685, 0.09, 0.16, "grip"),
  // 柄頭
  rect(0.435, 0.845, 0.13, 0.06, "guard"),
];

/** 握把在刀的局部座標裡的位置 —— 刀繞著這一點揮 */
const GRIP_X = 0.5;
const GRIP_Y = 0.88;

/** 兩把刀的握把落在格子的哪裡（左手／右手），以及刀有多大 */
const LEFT_HAND_X = 0.22;
const RIGHT_HAND_X = 0.78;
const HAND_Y = 0.88;
const SWORD_SCALE = 0.72;

/** 一次完整的劈砍。0.8 秒：慢到看得出是刀，快到讀得出是打鬥 */
export const WAR_ICON_PERIOD_MS = 800;

const DEG = Math.PI / 180;
/** 收刀（交叉的 ✕ 姿勢）、舉刀（分開）、劈中（交得最深） */
const ANGLE_REST = 42 * DEG;
const ANGLE_RAISED = 22 * DEG;
const ANGLE_STRIKE = 54 * DEG;

const easeOut = (k: number) => 1 - (1 - k) * (1 - k);
const easeIn = (k: number) => k * k;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export interface WarFrame {
  /** 刀與垂直線的夾角（弧度）。愈大交得愈深 */
  readonly angle: number;
  /** 火花強度 0..1。只有劈中的那一瞬間不是 0 */
  readonly spark: number;
  /** 劈中後的震動（格子高度的比例） */
  readonly shake: number;
  /** 舉刀時整把刀往上帶一點 —— 少了它像在原地轉，不像在揮 */
  readonly lift: number;
}

/**
 * 這一刻的姿勢。
 *
 * 節奏刻意不對稱：**舉刀慢、劈下快**。等速的來回讀起來像鐘擺，
 * 而鐘擺不像在打架。
 */
export function warIconFrame(elapsedMs: number): WarFrame {
  const p = elapsedMs / WAR_ICON_PERIOD_MS;
  const t = p - Math.floor(p); // 負數的 elapsed 也要落在 [0,1)

  if (t < 0.42) {
    // 舉刀：慢，尾段更慢（蓄力）
    const k = easeOut(t / 0.42);
    return {
      angle: lerp(ANGLE_REST, ANGLE_RAISED, k),
      spark: 0,
      shake: 0,
      lift: 0.035 * k,
    };
  }
  if (t < 0.55) {
    // 劈下：快，愈往下愈快
    const k = easeIn((t - 0.42) / 0.13);
    return {
      angle: lerp(ANGLE_RAISED, ANGLE_STRIKE, k),
      spark: 0,
      shake: 0,
      lift: 0.035 * (1 - k),
    };
  }
  if (t < 0.72) {
    // 劈中：火花在這裡，然後彈開一點
    const k = (t - 0.55) / 0.17;
    return {
      angle: lerp(ANGLE_STRIKE, ANGLE_REST - 2 * DEG, easeOut(k)),
      spark: 1 - easeIn(k),
      shake: 0.03 * (1 - k) * (1 - k),
      lift: 0,
    };
  }
  // 回到收刀
  const k = easeOut((t - 0.72) / 0.28);
  return { angle: lerp(ANGLE_REST - 2 * DEG, ANGLE_REST, k), spark: 0, shake: 0, lift: 0 };
}

/**
 * 兩把刀交會的那一點（格子座標）。
 *
 * 由對稱性 x 恆為 0.5；y 由夾角推出來 —— 交得愈深（角度愈大），
 * 交會點愈低。火花必須畫在**這一點**上：畫在格子中央的話，
 * 舉刀的那半個週期火花會浮在兩把刀中間的空氣裡。
 */
export function warClashPoint(angle: number): { x: number; y: number } {
  const halfSpan = (RIGHT_HAND_X - LEFT_HAND_X) / 2;
  return { x: 0.5, y: HAND_Y - halfSpan / Math.tan(angle) };
}

/** 火花：一顆四角星 + 四根飛出去的碎屑 */
function sparkShapes(cx: number, cy: number, intensity: number): WarPoly[] {
  if (intensity <= 0.02) return [];
  const r = 0.12 + 0.16 * intensity;
  const w = 0.035 + 0.03 * intensity;
  const out: WarPoly[] = [
    poly([cx, cy - r, cx + w, cy, cx, cy + r, cx - w, cy], "spark"),
    poly([cx - r, cy, cx, cy - w, cx + r, cy, cx, cy + w], "spark"),
    poly(
      [cx, cy - r * 0.45, cx + w * 0.6, cy, cx, cy + r * 0.45, cx - w * 0.6, cy],
      "sparkCore",
    ),
  ];
  // 斜著飛出去的碎屑 —— 只有正十字的話讀起來像個記號，不像撞擊
  const d = r * 0.62;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    out.push(
      poly(
        [
          cx + sx * d * 0.45,
          cy + sy * d * 0.45,
          cx + sx * d,
          cy + sy * d,
          cx + sx * d * 0.7 + 0.02,
          cy + sy * d * 0.7 + 0.02,
        ],
        "spark",
      ),
    );
  }
  return out;
}

/**
 * 這一刻該畫什麼。全部是 0..1 的多邊形（`rect` 已攤平 —— 轉過的矩形
 * 不再是軸對齊的矩形），呼叫端只要乘上格子的像素尺寸。
 *
 * ★ 先畫兩把刀的**暗色剪影**再畫刀本身。地形色有淺有深，
 *   少了這一層，金屬色的刀畫在礦脈（也是金屬色）上會整個消失 ——
 *   與資源地貌那層暗影同一個理由。
 */
export function warIconShapes(elapsedMs: number): readonly WarPoly[] {
  const frame = warIconFrame(elapsedMs);
  const shakeY = frame.shake * Math.sin(elapsedMs * 0.09);

  const place = (handX: number, flipX: boolean) =>
    transformShapes(SWORD, {
      angle: flipX ? -frame.angle : frame.angle,
      scale: SWORD_SCALE,
      flipX,
      pivotX: GRIP_X,
      pivotY: GRIP_Y,
      dx: handX - GRIP_X,
      dy: HAND_Y - GRIP_Y - frame.lift + shakeY,
    });

  const left = place(LEFT_HAND_X, false);
  const right = place(RIGHT_HAND_X, true);

  const silhouette = [...left, ...right].map((s) =>
    poly(
      s.points.map((v, i) => v + (i % 2 === 0 ? 0.022 : 0.028)),
      "shadow" as const,
    ),
  );

  const clash = warClashPoint(frame.angle);
  return [
    ...silhouette,
    ...left,
    ...right,
    ...sparkShapes(clash.x, clash.y + shakeY, frame.spark),
  ];
}
