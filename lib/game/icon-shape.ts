/**
 * 圖示的幾何基元。純資料，無 I/O。
 *
 * 地圖上的圖示（資源地貌、主城、交戰）一律是**單位座標 0..1 的形狀清單**，
 * 不是像素網格 —— 理由見 `map-icon.ts`：一格 16×16 的網格等於幾萬個 rect，
 * 而十幾個形狀放大到 64px 仍然銳利。
 *
 * ## ★ 為什麼 tone 是泛型
 *
 * 顏色一律是**語意 token**，而 token 的集合每一種圖示各自不同 ——
 * 地貌講的是樹冠與岩體，主城講的是城牆與旗幟，刀劍講的是刃與火花。
 * 硬把它們併成一個大 union，等於讓「森林」拿得到「旗幟」的顏色，
 * 而那種錯誤編譯器本來擋得住。
 *
 * 幾何共用、語意各自定義：`/lib/game` 仍然不知道任何一個色碼，
 * 對照表在 `lib/render/scene.ts`。
 */

export interface IconRectOf<Tone> {
  readonly kind: "rect";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly tone: Tone;
}

export interface IconPolyOf<Tone> {
  readonly kind: "poly";
  /** [x0,y0, x1,y1, …]，單位座標 0..1，y 向下 */
  readonly points: readonly number[];
  readonly tone: Tone;
}

export type IconShapeOf<Tone> = IconRectOf<Tone> | IconPolyOf<Tone>;

export function rectOf<Tone>(
  x: number,
  y: number,
  w: number,
  h: number,
  tone: Tone,
): IconRectOf<Tone> {
  return { kind: "rect", x, y, w, h, tone };
}

export function polyOf<Tone>(points: readonly number[], tone: Tone): IconPolyOf<Tone> {
  return { kind: "poly", points, tone };
}

/**
 * rect → poly。
 *
 * ★ 旋轉之前一定要先攤平：一個 `rect` 只有 x/y/w/h，**沒有角度**，
 *   轉了之後它已經不是軸對齊的矩形了。硬把旋轉塞回 rect 的欄位裡，
 *   畫出來會是一個「位置對、角度沒轉」的方塊 —— 而那種錯很難一眼看穿。
 */
export function toPoly<Tone>(shape: IconShapeOf<Tone>): IconPolyOf<Tone> {
  if (shape.kind === "poly") return shape;
  const { x, y, w, h, tone } = shape;
  return polyOf([x, y, x + w, y, x + w, y + h, x, y + h], tone);
}

export interface ShapeTransform {
  /** 弧度，正值為順時針（y 向下的座標系） */
  readonly angle?: number;
  readonly scale?: number;
  /** 先對 pivotX 鏡射（左右手的刀共用同一份幾何） */
  readonly flipX?: boolean;
  readonly pivotX?: number;
  readonly pivotY?: number;
  readonly dx?: number;
  readonly dy?: number;
}

/**
 * 鏡射 → 縮放 → 旋轉（都繞 pivot）→ 平移。
 *
 * 順序是刻意的：pivot 是「握把那一點」，刀要繞著握把揮，
 * 所以旋轉必須發生在平移之前。反過來的話刀會繞著格子中心公轉。
 */
export function transformShapes<Tone>(
  shapes: readonly IconShapeOf<Tone>[],
  t: ShapeTransform,
): IconPolyOf<Tone>[] {
  const {
    angle = 0,
    scale = 1,
    flipX = false,
    pivotX = 0.5,
    pivotY = 0.5,
    dx = 0,
    dy = 0,
  } = t;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return shapes.map((shape) => {
    const src = toPoly(shape).points;
    const out: number[] = new Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      let px = src[i]!;
      const py = src[i + 1]!;
      if (flipX) px = 2 * pivotX - px;
      const rx = (px - pivotX) * scale;
      const ry = (py - pivotY) * scale;
      out[i] = pivotX + rx * cos - ry * sin + dx;
      out[i + 1] = pivotY + rx * sin + ry * cos + dy;
    }
    return polyOf(out, shape.tone);
  });
}
