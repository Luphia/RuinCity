/**
 * 據點的 32×32 像素建築。純函式，無 I/O。
 * 對應 `docs/09` §2（像素規範）與 §3（24 色調色盤）。
 *
 * ## ★ 為什麼用程式生成
 *
 * 與執政官頭像（`avatar.ts`）同一個理由，但更強：
 * 八種建築 × 每種要看得出等級差異 × 兩幀閒置動畫，
 * 手繪是幾十張圖，而現在還沒有美術。
 *
 * 這一層只決定「哪一格是什麼顏色」，回傳調色盤索引 ——
 * 要畫成 SVG、canvas 還是 PixiJS 貼圖是渲染層的事。
 * 美術之後可以把 `paint*` 逐一換成手繪的 32×32 圖層，
 * **等級分段與組合邏輯不用改**。
 *
 * ## ★ 等級必須看得出來
 *
 * `docs/09` §6 說「2×2 核心放大顯示，四格可直接點擊升級」——
 * 如果 Lv1 與 Lv30 長得一模一樣，那個畫面就只是四個可點的方塊。
 * 每種建築都依 `tier()` 分五段，段與段之間**輪廓要不同**
 * （多一層樓、多一根煙囪、多一面旗），不能只是換個顏色。
 */

import { CORE_BUILDING, type CoreBuilding } from "./balance";

export const SPRITE_SIZE = 32;

/**
 * 調色盤索引。0 = 透明。
 *
 * 取自 `docs/09` §3 的 24 色，只留結構與地面用得到的那些。
 * ★ 不要在這裡發明新顏色 —— 那份調色盤是整個遊戲的視覺一致性來源。
 */
export const SPRITE_PALETTE = [
  "transparent",
  "#1a1614", // 1  最深（描邊）
  "#2e2723", // 2  深
  "#4a413a", // 3  中
  "#7d8087", // 4  金屬灰
  "#a8aab0", // 5  金屬亮
  "#7a5a3c", // 6  木質
  "#4d3826", // 7  木質深
  "#a35a3a", // 8  鏽紅
  "#6e3a26", // 9  鏽紅深
  "#9a958c", // 10 石灰淺
  "#6b6862", // 11 石灰深
  "#b8a07e", // 12 沙土淺（地面）
  "#8c7758", // 13 沙土深（地面陰影）
  "#6b7f4a", // 14 苔綠淺
  "#47562f", // 15 苔綠深
  "#d9a441", // 16 遺物金
  "#c4442f", // 17 警示紅
  "#4a8fa8", // 18 生機藍
  "#e8dcc0", // 19 羊皮紙
] as const;

export type PaletteIndex = number;

/** A 格恆為主堡；B/C/D 是七選三 */
export type SlotBuilding = CoreBuilding | "CITADEL";

export interface SlotArt {
  readonly building: SlotBuilding | null;
  readonly level: number;
  /** 建造／升級中 —— 疊上鷹架 */
  readonly building_: boolean;
  /** 閒置動畫的幀。`docs/09` §2：2 幀、0.8s/幀 */
  readonly frame: 0 | 1;
}

/**
 * 等級 → 五段外觀。
 *
 * 主堡上限 33、核心建築上限各異，所以用比例而不是絕對值 ——
 * 這樣「看起來蓋得很高」對每一種建築都代表「快到頂了」。
 */
export function tier(level: number, maxLevel = 30): 0 | 1 | 2 | 3 | 4 {
  if (level <= 0) return 0;
  const r = level / maxLevel;
  if (r < 0.2) return 1;
  if (r < 0.45) return 2;
  if (r < 0.75) return 3;
  return 4;
}

// ─────────────────────────────────────────────────────────────
// 畫布
// ─────────────────────────────────────────────────────────────

interface Canvas {
  readonly g: Uint8Array;
  set(x: number, y: number, v: PaletteIndex): void;
  rect(x: number, y: number, w: number, h: number, v: PaletteIndex): void;
  /** 帶 1px 深色描邊的方塊（`docs/09` §2：確保在任何地形上都可辨識） */
  box(x: number, y: number, w: number, h: number, fill: PaletteIndex, shade?: PaletteIndex): void;
}

function canvas(): Canvas {
  const g = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE);
  const set = (x: number, y: number, v: PaletteIndex) => {
    if (x < 0 || y < 0 || x >= SPRITE_SIZE || y >= SPRITE_SIZE) return;
    g[y * SPRITE_SIZE + x] = v;
  };
  const rect = (x: number, y: number, w: number, h: number, v: PaletteIndex) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) set(x + dx, y + dy, v);
  };
  return {
    g,
    set,
    rect,
    box(x, y, w, h, fill, shade) {
      rect(x, y, w, h, fill);
      // 右側與底部一階陰影，讓方塊有體積
      if (shade !== undefined) {
        rect(x + w - 2, y + 1, 2, h - 1, shade);
        rect(x + 1, y + h - 2, w - 1, 2, shade);
      }
      // 1px 描邊
      for (let dx = -1; dx <= w; dx++) {
        set(x + dx, y - 1, 1);
        set(x + dx, y + h, 1);
      }
      for (let dy = -1; dy <= h; dy++) {
        set(x - 1, y + dy, 1);
        set(x + w, y + dy, 1);
      }
    },
  };
}

/** 地面：所有建築共用的底座，讓四格拼起來像同一塊地 */
function paintGround(c: Canvas) {
  c.rect(0, 24, SPRITE_SIZE, 8, 12);
  c.rect(0, 28, SPRITE_SIZE, 4, 13);
  // 幾撮苔，位置固定 —— 這是背景，不需要隨機
  c.set(3, 26, 14);
  c.set(4, 26, 14);
  c.set(27, 27, 15);
  c.set(28, 27, 15);
  c.set(14, 30, 15);
}

// ─────────────────────────────────────────────────────────────
// 各建築
// ─────────────────────────────────────────────────────────────

/** 主堡：一座塔，每一段多一層樓，滿級時掛上遺物金的旗 */
function paintCitadel(c: Canvas, t: number, frame: 0 | 1) {
  const floors = 1 + t; // 1–5 層
  const w = 14;
  const x = 9;
  let y = 24;

  for (let f = 0; f < floors; f++) {
    const h = 4;
    y -= h;
    c.box(x, y, w, h, 10, 11);
    // 窗
    if (f < floors - 1 || floors === 1) {
      c.set(x + 4, y + 1, 2);
      c.set(x + 9, y + 1, 2);
    }
  }

  // 城垛
  const top = y - 1;
  for (let i = 0; i < w; i += 4) {
    c.rect(x + i, top - 2, 2, 2, 10);
    c.set(x + i, top - 3, 1);
    c.set(x + i + 1, top - 3, 1);
  }

  // 側塔：t3 才有，讓 t2 與 t3 的輪廓分開
  if (t >= 3) {
    c.box(4, 16, 4, 8, 10, 11);
    c.set(4, 15, 1);
    c.set(7, 15, 1);
  }

  // 旗：t≥2 才有，兩幀之間飄動一格
  if (t >= 2) {
    const fx = x + w - 2;
    const fy = top - 8;
    c.rect(fx, fy, 1, 7, 7);
    const flag = frame === 0 ? 4 : 3;
    c.rect(fx + 1, fy, flag, 3, t >= 4 ? 16 : 8);
  }
}

/** 兵營：矮長屋 + 靶場，等級高了多一排帳篷 */
function paintBarracks(c: Canvas, t: number, frame: 0 | 1) {
  c.box(4, 14, 16, 10, 6, 7);
  // 屋頂斜線
  for (let i = 0; i < 16; i++) c.set(4 + i, 14 + (i % 2), 7);
  // 門
  c.rect(10, 19, 4, 5, 2);
  // 兵器架
  c.rect(22, 16, 1, 8, 7);
  c.rect(25, 16, 1, 8, 7);
  c.set(22, 15, 4);
  c.set(25, 15, 4);
  if (t >= 2) {
    c.box(22, 19, 7, 5, 8, 9); // 帳篷
  }
  if (t >= 3) {
    // 哨塔：t3 一定要有自己的輪廓，否則 t2 與 t3 是同一張圖
    c.box(6, 7, 6, 7, 6, 7);
    c.rect(7, 9, 4, 2, 2);
    c.set(8, 6, 1);
    c.set(9, 6, 1);
  }
  if (t >= 4) {
    // 訓練用的煙，兩幀交錯
    c.set(frame === 0 ? 7 : 8, 11, 3);
    c.set(frame === 0 ? 8 : 7, 9, 3);
  }
}

/** 獸廄：柵欄 + 馬廄，高等級加一個水槽 */
function paintStable(c: Canvas, t: number) {
  c.box(3, 15, 13, 9, 6, 7);
  c.rect(6, 19, 3, 5, 2);
  c.rect(11, 19, 3, 5, 2);
  // 柵欄長度隨等級 —— 每一段都要換輪廓，不能只換顏色
  const fenceEnd = 21 + t * 3;
  for (let x = 18; x < fenceEnd; x += 3) c.rect(x, 18, 1, 6, 7);
  c.rect(18, 19, fenceEnd - 18, 1, 7);
  c.rect(18, 22, fenceEnd - 18, 1, 7);
  if (t >= 2) {
    // 屋頂通風口
    c.rect(6, 12, 3, 3, 7);
    c.set(6, 11, 1);
    c.set(8, 11, 1);
  }
  if (t >= 3) c.box(24, 21, 5, 3, 4, 3); // 水槽
  if (t >= 4) {
    c.box(2, 8, 5, 7, 6, 7); // 乾草塔
    c.rect(3, 10, 3, 1, 16);
  }
}

/** 工坊：帶煙囪的廠房，煙隨幀上升 */
function paintWorkshop(c: Canvas, t: number, frame: 0 | 1) {
  c.box(5, 13, 18, 11, 4, 3);
  // 鋸齒屋頂
  for (let i = 0; i < 18; i += 4) {
    c.rect(5 + i, 11, 2, 2, 5);
    c.set(5 + i, 10, 1);
    c.set(5 + i + 1, 10, 1);
  }
  c.rect(9, 18, 4, 6, 2);
  // 煙囪
  c.box(24, 10, 4, 14, 9, 1);
  const puff = frame === 0 ? 0 : -2;
  c.rect(25, 6 + puff, 2, 2, 3);
  if (t >= 3) c.rect(24, 2 + puff, 3, 2, 3);
  if (t >= 2) c.rect(15, 19, 6, 5, 8); // 熔爐口
  if (t >= 4) c.rect(16, 20, 4, 3, 17); // 燒紅
}

/** 倉庫：堆疊的箱子，等級越高堆越滿 */
function paintDepot(c: Canvas, t: number) {
  c.box(4, 12, 24, 12, 6, 7);
  c.rect(4, 12, 24, 2, 7);
  // 箱子按等級補滿
  const crates: [number, number][] = [
    [6, 17],
    [13, 17],
    [20, 17],
    [6, 11],
    [13, 11],
    [20, 11],
  ];
  const n = Math.min(crates.length, 2 + t);
  for (let i = 0; i < n; i++) {
    const [x, y] = crates[i]!;
    c.box(x, y, 5, 5, 8, 9);
    c.rect(x, y + 2, 5, 1, 9);
  }
}

/** 檔案館：帶拱窗的石屋，高等級亮起藍色的燈 */
function paintArchive(c: Canvas, t: number, frame: 0 | 1) {
  c.box(6, 10, 20, 14, 10, 11);
  // 柱
  for (const x of [8, 13, 18, 23]) c.rect(x, 14, 2, 10, 11);
  // 拱窗
  c.rect(10, 12, 3, 2, 2);
  c.rect(19, 12, 3, 2, 2);
  // 山牆
  for (let i = 0; i < 10; i++) {
    c.rect(6 + i, 9 - Math.floor(i / 2), 20 - i * 2, 1, 10);
  }
  if (t >= 2) {
    // 側翼書庫
    c.box(2, 16, 4, 8, 10, 11);
    c.box(26, 16, 4, 8, 10, 11);
  }
  if (t >= 3) {
    const lit = frame === 0 ? 18 : 4;
    c.rect(10, 12, 3, 2, lit);
    c.rect(19, 12, 3, 2, lit);
  }
  if (t >= 4) {
    // 屋脊上的天文儀
    c.rect(15, 4, 2, 4, 4);
    c.rect(13, 2, 6, 2, 16);
  }
}

/** 城牆：一段帶垛口的牆，等級高了加厚並長出塔樓 */
function paintRampart(c: Canvas, t: number) {
  const h = 8 + t;
  const y = 24 - h;
  c.box(2, y, 28, h, 10, 11);
  // 垛口
  for (let i = 0; i < 28; i += 4) {
    c.rect(2 + i, y - 3, 2, 3, 10);
    c.set(2 + i, y - 4, 1);
    c.set(2 + i + 1, y - 4, 1);
  }
  // 石縫
  for (let ry = y + 2; ry < 24; ry += 3) c.rect(3, ry, 26, 1, 11);
  if (t >= 3) {
    c.box(24, y - 6, 6, 6, 10, 11);
  }
}

/** 醫療帳：白帳篷加紅十字（廢土版：布條） */
function paintInfirmary(c: Canvas, t: number) {
  // 帳篷三角
  for (let i = 0; i < 11; i++) {
    c.rect(16 - i, 13 + i, i * 2 + 1, 1, i % 3 === 0 ? 10 : 19);
  }
  c.rect(6, 23, 21, 1, 1);
  // 布條十字
  c.rect(15, 17, 3, 7, 17);
  c.rect(12, 19, 9, 3, 17);
  if (t >= 2) {
    c.box(2, 18, 6, 6, 6, 7); // 補給箱
  }
  if (t >= 3) {
    // 旗竿：傷兵回收的標記
    c.rect(29, 10, 1, 14, 7);
    c.rect(26, 10, 3, 3, 19);
  }
  if (t >= 4) {
    c.rect(24, 16, 6, 8, 19);
    c.rect(24, 16, 6, 1, 1);
  }
}

/**
 * 空格：**空地**，不是建築。
 *
 * ★ 第一版畫成一整塊帶輪廓的方形，結果在 2×2 裡看起來就像一座矮牆 ——
 *   玩家會以為那一格已經蓋了東西。空的就要看起來是空的：
 *   只有地面、幾塊瓦礫，加一圈虛線標出「這裡可以蓋」。
 */
function paintEmpty(c: Canvas) {
  // 幾塊散落的瓦礫，貼著地面
  for (const [x, y, w] of [
    [10, 21, 3],
    [15, 22, 2],
    [20, 20, 3],
    [13, 19, 2],
  ] as const) {
    c.rect(x, y, w, 2, 11);
    c.rect(x, y + 2, w, 1, 1);
  }

  // 虛線地基框：四邊都要有，才讀得出是「一塊預留的地」而不是一道牆
  const [l, t, r, bt] = [7, 15, 25, 24];
  for (let x = l; x < r; x += 3) {
    c.set(x, t, 3);
    c.set(x + 1, t, 3);
    c.set(x, bt, 3);
    c.set(x + 1, bt, 3);
  }
  for (let y = t; y < bt; y += 3) {
    c.set(l, y, 3);
    c.set(l, y + 1, 3);
    c.set(r, y, 3);
    c.set(r, y + 1, 3);
  }
}

/** 鷹架：疊在建築上，表示施工中 */
function paintScaffold(c: Canvas, frame: 0 | 1) {
  for (const x of [5, 26]) c.rect(x, 6, 1, 18, 6);
  for (const y of [10, 16, 22]) c.rect(5, y, 22, 1, 6);
  // 吊掛的重物，兩幀之間上下擺
  const hy = frame === 0 ? 12 : 14;
  c.rect(15, 10, 1, hy - 10, 3);
  c.box(14, hy, 4, 3, 4, 3);
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

/** 各建築的等級上限。`tier()` 用比例分段，所以要知道每一種的上限 */
export const MAX_LEVEL: Record<SlotBuilding, number> = {
  CITADEL: 33,
  BARRACKS: 30,
  STABLE: 30,
  WORKSHOP: 30,
  DEPOT: 30,
  ARCHIVE: 30,
  RAMPART: 30,
  INFIRMARY: 30,
};

/** 落在第 n 段的一個代表性等級。測試與預覽用 */
export function levelForTier(building: SlotBuilding, t: 1 | 2 | 3 | 4): number {
  const max = MAX_LEVEL[building];
  const lo = [0, 0.2, 0.45, 0.75][t - 1]!;
  const hi = [0.2, 0.45, 0.75, 1][t - 1]!;
  return Math.max(1, Math.ceil(((lo + hi) / 2) * max));
}

export function renderSlot(art: SlotArt): Uint8Array {
  const c = canvas();
  paintGround(c);

  if (art.building === null) {
    paintEmpty(c);
  } else {
    const t = tier(art.level, MAX_LEVEL[art.building]);
    switch (art.building) {
      case "CITADEL":
        paintCitadel(c, t, art.frame);
        break;
      case "BARRACKS":
        paintBarracks(c, t, art.frame);
        break;
      case "STABLE":
        paintStable(c, t);
        break;
      case "WORKSHOP":
        paintWorkshop(c, t, art.frame);
        break;
      case "DEPOT":
        paintDepot(c, t);
        break;
      case "ARCHIVE":
        paintArchive(c, t, art.frame);
        break;
      case "RAMPART":
        paintRampart(c, t);
        break;
      case "INFIRMARY":
        paintInfirmary(c, t);
        break;
    }
  }

  if (art.building_) paintScaffold(c, art.frame);
  return c.g;
}

/**
 * 調色盤索引 → SVG。
 *
 * 同一列連續同色的格子合併成一個 `<rect>`（run-length），
 * 32×32 全滿最多 1024 個矩形，實測建築約 60–120 個。
 * `shape-rendering="crispEdges"` 讓縮放後不糊 —— 這與
 * `docs/09` §2 的 `image-rendering: pixelated` 是同一件事的 SVG 版。
 */
export function slotSvg(art: SlotArt, pixelSize = 4): string {
  const g = renderSlot(art);
  const rects: string[] = [];

  for (let y = 0; y < SPRITE_SIZE; y++) {
    let x = 0;
    while (x < SPRITE_SIZE) {
      const v = g[y * SPRITE_SIZE + x] ?? 0;
      if (v === 0) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < SPRITE_SIZE && (g[y * SPRITE_SIZE + x + run] ?? 0) === v) run++;
      rects.push(
        `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${run * pixelSize}" ` +
          `height="${pixelSize}" fill="${SPRITE_PALETTE[v]}"/>`,
      );
      x += run;
    }
  }

  const side = SPRITE_SIZE * pixelSize;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">${rects.join("")}</svg>`
  );
}

/** 給 UI 用的名稱。主堡不在 `CORE_BUILDING` 裡 */
export function slotLabel(building: SlotBuilding | null): string {
  if (building === null) return "空地";
  if (building === "CITADEL") return "主堡";
  return CORE_BUILDING[building].label;
}
