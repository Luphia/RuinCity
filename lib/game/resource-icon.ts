/**
 * 四種資源的 12×12 像素圖示。純函式，無 I/O。
 * 對應 `docs/09` §2（像素規範）與 §3（調色盤）。
 *
 * ## ★ 為什麼要圖示
 *
 * 「糧 473」在一條 40px 的 HUD 上是一個中文字加一串數字 ——
 * 掃視的時候得**讀**它才知道是哪一種。像素圖示是形狀，
 * 而形狀在餘光裡就分得出來：麥穗、木頭、石塊、鐵錠。
 *
 * 圖示同時解掉一個文字解不掉的問題：戰報、集市、簡報裡的
 * 「木 120 石 80」在窄螢幕上會斷行成沒有意義的碎片。
 *
 * ## ★ 為什麼不用 emoji
 *
 * emoji 由系統字型決定長相 —— 同一段文字在 iOS、Android、桌面
 * 是三種畫風，而這個遊戲的視覺定位是**廢土像素**（`docs/09` §1）。
 * 12×12 的程式生成圖示跟士兵、建築、頭像走同一套調色盤，
 * 而且放大之後仍然是銳利的方塊。
 *
 * 一格一個字元，對照 `SPRITE_PALETTE` 的索引 —— 讀原始碼就看得出形狀。
 */

import { RESOURCE_LABEL } from "./balance";
import { SPRITE_PALETTE } from "./sprite";

export const RESOURCE_ICON_SIZE = 12;

export type ResourceKind = "grain" | "timber" | "stone" | "iron";

/** 字元 → 調色盤索引。`.` 是透明 */
const INK: Record<string, number> = {
  ".": 0,
  "#": 1, // 描邊（最深）
  o: 13, // 沙土深 —— 麥稈陰影
  O: 12, // 沙土淺 —— 麥稈
  g: 15, // 苔綠深
  G: 14, // 苔綠淺
  w: 7, // 木質深
  W: 6, // 木質
  s: 11, // 石灰深
  S: 10, // 石灰淺
  m: 4, // 金屬灰
  M: 5, // 金屬亮
};

/**
 * ★ 四個形狀要在 12px 下**一眼分得開**：
 *   麥穗是尖的、木頭是躺著的圓柱、石塊是不規則多邊形、鐵錠是梯形。
 *   輪廓不同比顏色不同重要 —— 色弱玩家只剩輪廓可以依靠。
 */
const ART: Record<ResourceKind, readonly string[]> = {
  // 麥穗：**高而細**的麥頭 + 綠稈與一片葉
  grain: [
    ".....OO.....",
    "....OOOO....",
    "...OOoOOO...",
    "...OOoOOO...",
    "...OOoOOO...",
    "....OOOO....",
    ".....OO.....",
    ".....GG.....",
    "..GGGGG.....",
    ".gG..GG.....",
    ".....GG.....",
    ".....gg.....",
  ],
  // 原木：**長而扁**的一段，左端露出年輪
  timber: [
    "............",
    "............",
    "...WWWWWWW..",
    "..WWWWWWWWW.",
    ".WwWWWWWWWWW",
    ".wWwWWWWWWWW",
    ".WwWWWWWWWWW",
    ".wWwWWWWWWWW",
    "..WWWWWWWWW.",
    "...WWWWWWW..",
    "............",
    "............",
  ],
  // 石塊：**尖頂的多邊形**，帶一道裂縫
  stone: [
    "............",
    "....SS......",
    "...SSSSS....",
    "..SSSSSSS...",
    ".SSSSsSSSS..",
    ".SSSSsSSSSS.",
    ".SSSsSSSSSS.",
    ".SSsSSSSSSS.",
    "..SSSSSSSS..",
    "...SSSSSS...",
    "............",
    "............",
  ],
  // 鐵錠：**兩塊疊起來的梯形**，上緣有高光
  iron: [
    "............",
    "............",
    ".....MMMMM..",
    "....mmmmmmm.",
    "....mmmmmmm.",
    "............",
    "...MMMMM....",
    "..mmmmmmm...",
    "..mmmmmmm...",
    "............",
    "............",
    "............",
  ],
};

export type IconGrid = Uint8Array;

/** 12×12 的調色盤索引網格 */
export function resourceIconGrid(kind: ResourceKind): IconGrid {
  const rows = ART[kind];
  const g = new Uint8Array(RESOURCE_ICON_SIZE * RESOURCE_ICON_SIZE);
  for (let y = 0; y < RESOURCE_ICON_SIZE; y++) {
    const row = rows[y] ?? "";
    for (let x = 0; x < RESOURCE_ICON_SIZE; x++) {
      g[y * RESOURCE_ICON_SIZE + x] = INK[row[x] ?? "."] ?? 0;
    }
  }
  return g;
}

/**
 * 畫成 SVG。同一列連續同色會合併成一個 `rect`（12×12 大約 30–40 個），
 * 與 `soldierSvg` 同一招。
 */
export function resourceIconSvg(kind: ResourceKind, pixelSize = 1): string {
  const g = resourceIconGrid(kind);
  const N = RESOURCE_ICON_SIZE;
  const rects: string[] = [];
  for (let y = 0; y < N; y++) {
    let x = 0;
    while (x < N) {
      const v = g[y * N + x]!;
      if (v === 0) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < N && g[y * N + x + run] === v) run++;
      rects.push(
        `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${run * pixelSize}" ` +
          `height="${pixelSize}" fill="${SPRITE_PALETTE[v]}"/>`,
      );
      x += run;
    }
  }
  const side = N * pixelSize;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="${RESOURCE_NAME[kind]}">${rects.join("")}</svg>`
  );
}

/**
 * 無障礙與 tooltip 用的名字 —— 圖示不能是唯一的資訊來源。
 *
 * ★ 名字**不在這裡定義**：`balance/economy.ts` 的 `RESOURCE_LABEL`
 *   才是那份規格（`docs/11` §1）。在這裡再寫一份，兩邊遲早分岔，
 *   而症狀是「同一種資源在兩個畫面上叫不同的名字」。
 */
export const RESOURCE_NAME: Record<ResourceKind, string> = {
  grain: RESOURCE_LABEL.grain,
  timber: RESOURCE_LABEL.timber,
  stone: RESOURCE_LABEL.stone,
  iron: RESOURCE_LABEL.iron,
};

export const RESOURCE_KINDS = ["grain", "timber", "stone", "iron"] as const;
