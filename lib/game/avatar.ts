/**
 * 執政官的 32×32 像素頭像。純函式，無 I/O。
 * 對應 docs/18-steward.md §9。
 *
 * ## ★ 為什麼用程式生成而不是畫 600 張圖
 *
 * 每一場賽季有 600 位領主，各配一位執政官，而賽季每 7 天開一輪。
 * 手繪的話不是畫 600 張，是畫到永遠。
 *
 * 組合式生成給的是**同一個東西**：性別中立的兜帽、面罩、義眼、傷疤
 * 各挑一種，湊出足夠多的臉讓「灰喉」與「斷指」看起來是兩個人。
 * 美術之後可以把每一個部件換成手繪的 32×32 圖層，
 * **組合邏輯不用改**。
 *
 * ## ★ 為什麼回傳索引陣列而不是圖片
 *
 * 這一層只決定「哪一格是什麼顏色」。要畫成 SVG、canvas、
 * 還是 PixiJS 的貼圖，是渲染層的事 —— 而 `/lib/game` 不碰渲染。
 */

import { deriveSeed, mulberry32 } from "./rng";

export const AVATAR_SIZE = 32;

/**
 * 調色盤索引。0 = 透明。
 *
 * 只有八色，因為這是廢土：`docs/09` §3 的 24 色調色盤裡，
 * 人物用得到的就是這幾階。
 */
export const AVATAR_PALETTE = [
  "transparent",
  "#1a1614", // 0 背景輪廓
  "#4a413a", // 1 兜帽陰影
  "#6e5c4a", // 2 兜帽
  "#8a7355", // 3 兜帽亮部
  "#c8b39a", // 4 皮膚
  "#9a8570", // 5 皮膚陰影
  "#d9a441", // 6 義眼／金屬
  "#c4442f", // 7 傷疤／布條
] as const;

export type PaletteIndex = number;

export interface AvatarParts {
  readonly hood: 0 | 1 | 2 | 3;
  readonly mask: 0 | 1 | 2 | 3;
  readonly eye: 0 | 1 | 2;
  readonly scar: 0 | 1 | 2;
  /** 兜帽的色階偏移，讓同款兜帽也不會撞色 */
  readonly hoodShade: 0 | 1 | 2;
}

/** 由 seed 決定的部件組合。4 × 4 × 3 × 3 × 3 = 432 種 */
export function avatarParts(seed: number): AvatarParts {
  const rng = mulberry32(deriveSeed(seed, "steward-avatar-parts"));
  const pick = <T extends number>(n: number): T => Math.floor(rng() * n) as T;
  return {
    hood: pick<0 | 1 | 2 | 3>(4),
    mask: pick<0 | 1 | 2 | 3>(4),
    eye: pick<0 | 1 | 2>(3),
    scar: pick<0 | 1 | 2>(3),
    hoodShade: pick<0 | 1 | 2>(3),
  };
}

/**
 * 畫出 32×32 的調色盤索引。
 *
 * ★ 一律左右對稱地畫：只算左半邊（x < 16）再鏡射。
 *   人臉本來就大致對稱，而對稱也讓隨機組合看起來像「一張臉」
 *   而不是「一堆雜訊」—— 這是像素頭像生成最關鍵的一招。
 *   刻意不對稱的部件（傷疤、義眼）在鏡射之後才畫上去。
 */
export function renderAvatar(seed: number): Uint8Array {
  const p = avatarParts(seed);
  const g = new Uint8Array(AVATAR_SIZE * AVATAR_SIZE); // 0 = 透明
  const set = (x: number, y: number, v: PaletteIndex) => {
    if (x < 0 || y < 0 || x >= AVATAR_SIZE || y >= AVATAR_SIZE) return;
    g[y * AVATAR_SIZE + x] = v;
  };
  const at = (x: number, y: number) => g[y * AVATAR_SIZE + x] ?? 0;

  const hoodMain = (2 + p.hoodShade) as PaletteIndex;
  const hoodLight = Math.min(4, hoodMain + 1) as PaletteIndex;

  // ── 兜帽外廓（左半邊）────────────────────────────────
  // 四款的差別在肩線高度與帽緣寬度
  const brim = [3, 4, 2, 5][p.hood]!;
  const shoulder = [24, 22, 25, 21][p.hood]!;

  for (let y = 4; y < AVATAR_SIZE - 2; y++) {
    // 頭部是一個上窄下寬的梯形，肩線之後外擴成披風
    const half =
      y < shoulder
        ? Math.min(11, 5 + Math.floor((y - 4) * 0.55))
        : Math.min(15, 11 + (y - shoulder));
    for (let x = 16 - half; x < 16; x++) {
      const edge = x < 16 - half + 1;
      set(x, y, edge ? 1 : hoodMain);
    }
  }

  // 帽緣：亮一階，讓臉有一圈陰影邊
  for (let y = 6; y < 6 + brim; y++) {
    for (let x = 16 - 10; x < 16; x++) set(x, y, hoodLight);
  }

  // ── 臉（左半邊）──────────────────────────────────────
  const faceTop = 6 + brim;
  const faceBottom = faceTop + 9;
  for (let y = faceTop; y < faceBottom; y++) {
    for (let x = 16 - 6; x < 16; x++) {
      set(x, y, y >= faceBottom - 2 ? 5 : 4);
    }
  }

  // ── 面罩（左半邊）────────────────────────────────────
  // 0 = 沒有；1 = 布條；2 = 半臉；3 = 全罩
  if (p.mask > 0) {
    const maskTop = p.mask === 3 ? faceTop + 1 : faceTop + 5;
    const colour = (p.mask === 1 ? 7 : 1) as PaletteIndex;
    for (let y = maskTop; y < faceBottom; y++) {
      for (let x = 16 - 6; x < 16; x++) set(x, y, colour);
    }
  }

  // ── 鏡射 ─────────────────────────────────────────────
  for (let y = 0; y < AVATAR_SIZE; y++) {
    for (let x = 0; x < 16; x++) set(AVATAR_SIZE - 1 - x, y, at(x, y));
  }

  // ── 不對稱的部件，鏡射之後才畫 ───────────────────────
  const eyeY = faceTop + 3;
  // 兩眼一律有，但義眼只有一邊
  set(13, eyeY, 1);
  set(18, eyeY, 1);
  if (p.eye > 0) set(p.eye === 1 ? 13 : 18, eyeY, 6);

  if (p.scar > 0) {
    // 一道斜疤，從眉骨劃到臉頰
    const x0 = p.scar === 1 ? 12 : 19;
    const dir = p.scar === 1 ? 1 : -1;
    for (let i = 0; i < 5; i++) set(x0 + i * dir, eyeY - 1 + i, 7);
  }

  return g;
}

/**
 * 把索引陣列畫成一張 SVG。
 *
 * ★ 同色的橫向連續格會被併成一個 `<rect>` —— 32×32 = 1,024 個
 *   `<rect>` 的 SVG 在手機上會明顯拖慢首屏，合併之後通常只剩兩三百個。
 */
export function avatarSvg(seed: number, pixelSize = 1): string {
  const g = renderAvatar(seed);
  const rects: string[] = [];

  for (let y = 0; y < AVATAR_SIZE; y++) {
    let x = 0;
    while (x < AVATAR_SIZE) {
      const v = g[y * AVATAR_SIZE + x] ?? 0;
      if (v === 0) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < AVATAR_SIZE && (g[y * AVATAR_SIZE + x + run] ?? 0) === v) run++;
      rects.push(
        `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${run * pixelSize}" height="${pixelSize}" fill="${AVATAR_PALETTE[v]}"/>`,
      );
      x += run;
    }
  }

  const side = AVATAR_SIZE * pixelSize;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">${rects.join("")}</svg>`
  );
}

/**
 * 玩家重新命名執政官（`docs/18` §9：純外觀、免費）。
 *
 * 只做長度與空白的整理 —— 內容審查是另一回事，
 * 而且執政官的名字只有領主自己看得到。
 */
export const STEWARD_NAME_MAX = 12;

export function sanitiseStewardName(raw: string): string | null {
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return [...trimmed].slice(0, STEWARD_NAME_MAX).join("");
}
