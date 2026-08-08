/**
 * 據點的俯視全景。純函式，無 I/O。
 * 對應 `docs/09` §6（據點）、§2（像素規範）、§3（24 色調色盤）。
 *
 * ## ★ 版面：50 × 50 的格，主城佔 10 × 10
 *
 * 整個畫面是 50×50 格；主城置中佔 10×10，**最外圈那一圈格就是城牆**，
 * 內部 8×8 才是可以蓋東西的地。城外的 40 格寬留給地形與駐軍 ——
 * 那片空間不是留白，它就是「你守著的東西有多大」這個訊息本身。
 *
 * 一格 = `TILE` px，所以畫布是 300×300 px。用格當單位而不是像素，
 * 因為版面規則（「主城 10×10」「最外圈是牆」）講的是格；
 * 換算成像素是最後一步。
 *
 * ## ★ 投影：正俯視
 *
 * `sprite.ts` 的建築是立面（看得到屋頂斜面與煙囪），那是給「單棟放大」
 * 用的。這裡所有東西都從正上方看 —— **兩種投影不能混在同一張圖裡**，
 * 混了之後陰影方向會互相打架。共用的只有調色盤。
 *
 * ## ★ 座標同時是點擊區
 *
 * `PLOTS` 既是畫圖的位置，也是 UI 疊按鈕的位置。
 * 兩份座標遲早分岔，而分岔的症狀是「點了 A 卻升級了 B」。
 */

import { UNIT, UNITS, type Unit } from "./balance";
import { SPRITE_PALETTE, type PaletteIndex } from "./sprite";
import type { SlotBuilding } from "./sprite";

/** 畫面是 50×50 格 */
export const GRID = 50;
/** 一格幾個像素 */
export const TILE = 8;
export const SCENE_SIZE = GRID * TILE;

export { SPRITE_PALETTE };

/** 主城：置中的 10×10。最外圈是牆，內部 8×8 可蓋 */
export const CITADEL = { x: 20, y: 20, w: 10, h: 10 } as const;
/** 城牆就是主城的最外圈 —— 兩者是同一個矩形 */
export const WALL = CITADEL;
export const INNER = {
  x: CITADEL.x + 1,
  y: CITADEL.y + 1,
  w: CITADEL.w - 2,
  h: CITADEL.h - 2,
} as const;

/** 城門：南牆正中兩格 */
export const GATE = { x: CITADEL.x + 4, y: CITADEL.y + CITADEL.h - 1, w: 2 } as const;

export interface Plot {
  readonly slot: "A" | "B" | "C" | "D";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 內部 8×8 的四塊地（格座標）。
 *
 * 主堡 4×4 佔東南，其餘三塊 3×3 —— 中間留出十字街，
 * 讓「城裡有路」這件事看得出來。
 */
export const PLOTS: readonly Plot[] = [
  { slot: "A", x: 24, y: 24, w: 4, h: 4 },
  { slot: "B", x: 21, y: 21, w: 3, h: 3 },
  { slot: "C", x: 26, y: 21, w: 3, h: 3 },
  { slot: "D", x: 21, y: 26, w: 3, h: 3 },
] as const;

/** 牆外的四支部隊。順序＝北、東、南、西 */
export const TROOP_GROUPS = ["ARCHER", "SIEGE", "INFANTRY", "CAVALRY"] as const;
export type TroopGroup = (typeof TROOP_GROUPS)[number];

export const TROOP_LABEL: Record<TroopGroup, string> = {
  CAVALRY: "騎兵",
  ARCHER: "弓兵",
  INFANTRY: "步兵",
  SIEGE: "器械",
};

/**
 * 四支部隊的營區（格座標）。
 *
 * ★ 圍著城牆的四面，不是排成一列。
 *   排成一列看起來像列隊校閱；圍成一圈才看得出「這座城被守著」，
 *   而且哪一面兵力薄弱一眼就知道。
 *
 *   步兵在南面 —— 城門在南牆，主力擋在門前是唯一合理的擺法。
 */
export const CAMPS: Record<TroopGroup, { x: number; y: number; w: number; h: number }> = {
  ARCHER: { x: 19, y: 13, w: 12, h: 5 },
  SIEGE: { x: 32, y: 19, w: 6, h: 12 },
  INFANTRY: { x: 18, y: 32, w: 14, h: 6 },
  CAVALRY: { x: 12, y: 19, w: 6, h: 12 },
};

/**
 * 兵種 → 牆外的哪一支。
 *
 * ★ 依 `attackClass` 分，但**弓手要單獨拉出來**：
 *   它在戰鬥模型裡屬於 INFANTRY（`docs/04`），在畫面上卻是自己一支 ——
 *   玩家問「我有多少弓」的時候，答案不該藏在步兵裡。
 *
 *   偵查兵（`attackClass: NONE`）併進步兵：它是徒步的，
 *   而且不該憑空多一支不存在的部隊。數字仍會逐兵種列在圖下方。
 */
export function groupOf(unit: Unit): TroopGroup {
  if (unit === "ARCHER") return "ARCHER";
  const cls = UNIT[unit].attackClass;
  if (cls === "CAVALRY") return "CAVALRY";
  if (cls === "SIEGE") return "SIEGE";
  return "INFANTRY";
}

export interface GroupTally {
  readonly group: TroopGroup;
  readonly label: string;
  readonly total: number;
  readonly units: readonly { unit: Unit; label: string; count: number }[];
}

export function garrisonGroups(
  army: Readonly<Partial<Record<Unit, number>>>,
): readonly GroupTally[] {
  return TROOP_GROUPS.map((group) => {
    const units = UNITS.filter((u) => groupOf(u) === group)
      .map((unit) => ({ unit, label: UNIT[unit].label, count: army[unit] ?? 0 }))
      .filter((u) => u.count > 0);
    return {
      group,
      label: TROOP_LABEL[group],
      total: units.reduce((s, u) => s + u.count, 0),
      units,
    };
  });
}

/**
 * 一支部隊畫幾個小人。
 *
 * ★ 不是「一人一點」—— 一萬名步兵畫不下，而且也沒有意義。
 *   用對數：玩家要看的是「多不多」，精確的數字在圖下方的文字裡。
 */
export function markCount(total: number, max = 14): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.min(max, Math.round(Math.log10(total + 1) * 4) + 1));
}

// ─────────────────────────────────────────────────────────────
// 畫布（像素）
// ─────────────────────────────────────────────────────────────

interface Canvas {
  readonly g: Uint8Array;
  px(x: number, y: number, v: PaletteIndex): void;
  /** 以**格**為單位填一塊 */
  cell(cx: number, cy: number, cw: number, ch: number, v: PaletteIndex): void;
  /** 像素矩形 */
  rect(x: number, y: number, w: number, h: number, v: PaletteIndex): void;
  frame(x: number, y: number, w: number, h: number, v: PaletteIndex, thick?: number): void;
}

function canvas(): Canvas {
  const g = new Uint8Array(SCENE_SIZE * SCENE_SIZE);
  const px = (x: number, y: number, v: PaletteIndex) => {
    if (x < 0 || y < 0 || x >= SCENE_SIZE || y >= SCENE_SIZE) return;
    g[y * SCENE_SIZE + x] = v;
  };
  const rect = (x: number, y: number, w: number, h: number, v: PaletteIndex) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) px(x + dx, y + dy, v);
  };
  return {
    g,
    px,
    rect,
    cell: (cx, cy, cw, ch, v) => rect(cx * TILE, cy * TILE, cw * TILE, ch * TILE, v),
    frame(x, y, w, h, v, thick = 1) {
      rect(x, y, w, thick, v);
      rect(x, y + h - thick, w, thick, v);
      rect(x, y, thick, h, v);
      rect(x + w - thick, y, thick, h, v);
    },
  };
}

/** 決定性的雜訊 —— 背景不需要隨機，但需要不規則 */
function hash(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// ─────────────────────────────────────────────────────────────
// 地形
// ─────────────────────────────────────────────────────────────

function paintTerrain(c: Canvas) {
  c.rect(0, 0, SCENE_SIZE, SCENE_SIZE, 14);

  /**
   * ★ 草地要用**成片**的斑塊，不是逐格雜訊。
   *
   *   第一版一格一擲，結果整張圖是綠土交錯的棋盤 —— 城被雜訊淹掉，
   *   眼睛不知道該看哪裡。改成以 3×3 為單位擲一次，
   *   而且離城越近越被踩成土：城外那一圈空地本身就是構圖，
   *   它把視線收束到城牆上。
   */
  const cx0 = CITADEL.x + CITADEL.w / 2;
  const cy0 = CITADEL.y + CITADEL.h / 2;
  for (let cy = 0; cy < GRID; cy += 1) {
    for (let cx = 0; cx < GRID; cx += 1) {
      const d = Math.hypot(cx - cx0, cy - cy0);
      const patch = hash(Math.floor(cx / 3), Math.floor(cy / 3));
      if (d < 9) {
        // 城外的踏平地
        c.cell(cx, cy, 1, 1, patch > 0.75 ? 13 : 12);
      } else if (d < 13) {
        c.cell(cx, cy, 1, 1, patch > 0.55 ? 12 : 14);
      } else if (patch > 0.78) {
        c.cell(cx, cy, 1, 1, 15);
      }
    }
  }

  // 河：從西北切到東南，繞過城
  for (let cy = 0; cy < GRID; cy++) {
    const cx = Math.round(3 + cy * 0.14 + Math.sin(cy * 0.35) * 1.6);
    c.cell(cx, cy, 2, 1, 18);
    c.px(cx * TILE, cy * TILE + 2, 4);
  }

  // 林地：東南角與東北角
  for (const [ox, oy, n] of [
    [40, 36, 22],
    [38, 4, 14],
    [3, 40, 10],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const cx = ox + Math.floor(hash(i, ox) * 9);
      const cy = oy + Math.floor(hash(ox, i) * 9);
      if (cx >= GRID - 1 || cy >= GRID - 1) continue;
      const x = cx * TILE;
      const y = cy * TILE;
      // 樹要比草**暗一階**又有樹幹，否則整片林地會融進草地看不見
      c.rect(x + 1, y + 2, 6, 5, 15);
      c.rect(x + 2, y, 4, 4, 14);
      c.rect(x + 3, y + 6, 2, 2, 7);
      c.frame(x + 1, y + 2, 6, 5, 1, 1);
    }
  }

  // 彈坑：戰場的痕跡
  for (const [cx, cy] of [
    [8, 8],
    [42, 22],
    [10, 34],
    [36, 44],
    [45, 12],
  ] as const) {
    const x = cx * TILE;
    const y = cy * TILE;
    c.rect(x, y + 1, 10, 7, 13);
    c.rect(x + 1, y + 2, 8, 5, 11);
    c.rect(x + 3, y + 4, 4, 2, 2);
  }
}

/** 通往城門的大路 */
function paintRoad(c: Canvas) {
  const gx = GATE.x * TILE;
  for (let y = (CITADEL.y + CITADEL.h) * TILE; y < SCENE_SIZE; y++) {
    c.rect(gx - 2, y, TILE * GATE.w + 4, 1, 13);
  }
  // 城裡的十字街
  c.cell(CITADEL.x + 4, CITADEL.y + 1, 2, CITADEL.h - 2, 13);
  c.cell(CITADEL.x + 1, CITADEL.y + 4, CITADEL.w - 2, 2, 13);
}

// ─────────────────────────────────────────────────────────────
// 城牆
// ─────────────────────────────────────────────────────────────

/**
 * 城牆 = 主城的最外圈那一圈格。
 *
 * 沒蓋 `RAMPART` 時是木柵，蓋了是石牆；等級高了長出角塔與旗。
 */
function paintWall(c: Canvas, level: number) {
  const built = level > 0;
  const body = built ? 10 : 6;
  const edge = built ? 11 : 7;
  const x = CITADEL.x * TILE;
  const y = CITADEL.y * TILE;
  const w = CITADEL.w * TILE;
  const h = CITADEL.h * TILE;

  c.rect(x, y, w, TILE, body);
  c.rect(x, y + h - TILE, w, TILE, body);
  c.rect(x, y, TILE, h, body);
  c.rect(x + w - TILE, y, TILE, h, body);

  // 石縫／木紋
  for (let i = 0; i < CITADEL.w; i++) {
    c.rect(x + i * TILE, y, 1, TILE, edge);
    c.rect(x + i * TILE, y + h - TILE, 1, TILE, edge);
  }
  for (let i = 0; i < CITADEL.h; i++) {
    c.rect(x, y + i * TILE, TILE, 1, edge);
    c.rect(x + w - TILE, y + i * TILE, TILE, 1, edge);
  }

  c.frame(x, y, w, h, 1, 1);
  c.frame(x + TILE - 1, y + TILE - 1, w - TILE * 2 + 2, h - TILE * 2 + 2, 1, 1);

  // 垛口：外緣一格一凸
  for (let i = 0; i < CITADEL.w; i += 2) {
    c.rect(x + i * TILE + 1, y - 2, TILE - 2, 2, body);
    c.rect(x + i * TILE + 1, y + h, TILE - 2, 2, body);
  }
  for (let i = 0; i < CITADEL.h; i += 2) {
    c.rect(x - 2, y + i * TILE + 1, 2, TILE - 2, body);
    c.rect(x + w, y + i * TILE + 1, 2, TILE - 2, body);
  }

  // 城門
  const gx = GATE.x * TILE;
  c.rect(gx, y + h - TILE, GATE.w * TILE, TILE, 13);
  c.rect(gx - 2, y + h - TILE - 1, 2, TILE + 2, 7);
  c.rect(gx + GATE.w * TILE, y + h - TILE - 1, 2, TILE + 2, 7);

  if (!built) return;

  // 角塔（四角），Lv10 起加四面中塔
  const towers: [number, number][] = [
    [CITADEL.x, CITADEL.y],
    [CITADEL.x + CITADEL.w - 2, CITADEL.y],
    [CITADEL.x, CITADEL.y + CITADEL.h - 2],
    [CITADEL.x + CITADEL.w - 2, CITADEL.y + CITADEL.h - 2],
  ];
  if (level >= 10) {
    towers.push(
      [CITADEL.x + 4, CITADEL.y - 1],
      [CITADEL.x - 1, CITADEL.y + 4],
      [CITADEL.x + CITADEL.w - 1, CITADEL.y + 4],
    );
  }
  for (const [tx, ty] of towers) {
    const px = tx * TILE - 1;
    const py = ty * TILE - 1;
    c.rect(px, py, TILE * 2 + 2, TILE * 2 + 2, 11);
    c.frame(px, py, TILE * 2 + 2, TILE * 2 + 2, 1, 1);
    c.rect(px + 3, py + 3, TILE * 2 - 4, TILE * 2 - 4, 10);
  }
}

// ─────────────────────────────────────────────────────────────
// 建築（格為單位的俯視外觀）
// ─────────────────────────────────────────────────────────────

function roof(c: Canvas, p: Plot, fill: PaletteIndex, shade: PaletteIndex) {
  const x = p.x * TILE;
  const y = p.y * TILE;
  const w = p.w * TILE;
  const h = p.h * TILE;
  c.rect(x, y, w, h, fill);
  c.frame(x, y, w, h, shade, 2);
  c.frame(x, y, w, h, 1, 1);
  return { x, y, w, h };
}

function paintCitadelTop(c: Canvas, p: Plot, t: number, frame: 0 | 1) {
  const { x, y, w, h } = roof(c, p, 11, 10);
  /**
   * ★ 等級越高，中央的天守越**大而亮**，不是越暗。
   *   第一版用內縮的深色矩形，結果滿級的主堡看起來像一個洞 ——
   *   玩家花了整個賽季升級，畫面回饋卻是越蓋越空。
   */
  const layers = 1 + t;
  for (let i = 0; i < layers; i++) {
    const inset = 3 + i * 3;
    const iw = w - inset * 2;
    const ih = h - inset * 2;
    if (iw < 6 || ih < 6) break;
    c.rect(x + inset, y + inset, iw, ih, i % 2 === 0 ? 10 : 11);
    c.frame(x + inset, y + inset, iw, ih, 1, 1);
  }
  // 角樓
  for (const [dx, dy] of [
    [0, 0],
    [w - 5, 0],
    [0, h - 5],
    [w - 5, h - 5],
  ] as const) {
    c.rect(x + dx, y + dy, 5, 5, 10);
    c.frame(x + dx, y + dy, 5, 5, 1, 1);
  }
  // 主旗：t≥2 才有，兩幀之間飄動；滿級換遺物金
  if (t >= 2) {
    const fx = x + w / 2;
    const fy = y + h / 2;
    c.rect(fx - 1, fy - 2, 2, 5, 1);
    const dir = frame === 0 ? 1 : -1;
    c.rect(dir > 0 ? fx + 1 : fx - 6, fy - 2, 5, 4, t >= 4 ? 16 : 8);
  }
}

function paintBarracksTop(c: Canvas, p: Plot, t: number) {
  const { x, y, w, h } = roof(c, p, 6, 7);
  c.rect(x + 2, y + h / 2 - 1, w - 4, 2, 7);
  for (let i = 0; i < Math.min(4, 1 + t); i++) {
    const bx = x + 2 + (i % 2) * (w / 2);
    const by = y + 2 + Math.floor(i / 2) * (h / 2);
    c.rect(bx, by, 4, 4, 8);
    c.px(bx + 1, by + 1, 17);
  }
}

function paintStableTop(c: Canvas, p: Plot, t: number) {
  const { x, y, w, h } = roof(c, p, 6, 7);
  c.rect(x + 2, y + 2, w - 4, 3, 7);
  for (let i = 0; i < 2 + t && x + 3 + i * 4 < x + w - 3; i++) {
    c.rect(x + 3 + i * 4, y + h - 6, 2, 4, 7);
  }
}

function paintWorkshopTop(c: Canvas, p: Plot, t: number, frame: 0 | 1) {
  const { x, y, w, h } = roof(c, p, 4, 3);
  for (let i = 0; i < 3 && x + 3 + i * 5 < x + w - 3; i++) {
    c.rect(x + 3 + i * 5, y + 3, 4, 4, 5);
  }
  c.rect(x + w - 8, y + h - 8, 6, 6, 9);
  c.frame(x + w - 8, y + h - 8, 6, 6, 1, 1);
  if (t >= 2) {
    const d = frame === 0 ? 0 : 2;
    c.rect(x + w - 7, y + h - 12 - d, 4, 3, 3);
  }
  if (t >= 4) c.rect(x + w - 7, y + h - 7, 4, 4, 17);
}

function paintDepotTop(c: Canvas, p: Plot, t: number) {
  const { x, y, w, h } = roof(c, p, 6, 7);
  let n = 0;
  for (let dy = 2; dy + 5 <= h - 2 && n < 2 + t * 2; dy += 6) {
    for (let dx = 2; dx + 5 <= w - 2 && n < 2 + t * 2; dx += 6) {
      c.rect(x + dx, y + dy, 5, 5, 8);
      c.frame(x + dx, y + dy, 5, 5, 9, 1);
      n++;
    }
  }
}

function paintArchiveTop(c: Canvas, p: Plot, t: number, frame: 0 | 1) {
  const { x, y, w, h } = roof(c, p, 10, 11);
  c.rect(x + 4, y + 4, w - 8, h - 8, 12);
  c.frame(x + 4, y + 4, w - 8, h - 8, 1, 1);
  if (t >= 3) {
    const lit = frame === 0 ? 18 : 4;
    c.rect(x + w / 2 - 2, y + h / 2 - 2, 4, 4, lit);
  }
}

function paintRampartTop(c: Canvas, p: Plot, t: number) {
  const { x, y, w, h } = roof(c, p, 11, 10);
  let n = 0;
  for (let dy = 2; dy + 5 <= h - 2 && n < 3 + t; dy += 6) {
    for (let dx = 2; dx + 4 <= w - 2 && n < 3 + t; dx += 5) {
      c.rect(x + dx, y + dy, 4, 5, 10);
      c.frame(x + dx, y + dy, 4, 5, 1, 1);
      n++;
    }
  }
}

function paintInfirmaryTop(c: Canvas, p: Plot, t: number) {
  const { x, y, w, h } = roof(c, p, 19, 10);
  c.rect(x + w / 2 - 2, y + 3, 4, h - 6, 17);
  c.rect(x + 3, y + h / 2 - 2, w - 6, 4, 17);
  if (t >= 2) c.rect(x + 2, y + 2, 4, 4, 6);
}

/**
 * 空地。
 *
 * ★ 不能填滿顏色。第一版用深色沙土填滿，結果空地看起來像建築 ——
 *   開局的畫面於是說了謊：明明什麼都沒蓋，看起來卻像已經有四棟。
 */
function paintEmptyPlot(c: Canvas, p: Plot) {
  const x = p.x * TILE;
  const y = p.y * TILE;
  const w = p.w * TILE;
  const h = p.h * TILE;
  for (let i = 0; i < w; i += 4) {
    c.rect(x + i, y, 2, 1, 11);
    c.rect(x + i, y + h - 1, 2, 1, 11);
  }
  for (let i = 0; i < h; i += 4) {
    c.rect(x, y + i, 1, 2, 11);
    c.rect(x + w - 1, y + i, 1, 2, 11);
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  c.rect(cx - 5, cy - 1, 11, 2, 11);
  c.rect(cx - 1, cy - 5, 2, 11, 11);
}

function paintScaffold(c: Canvas, p: Plot, frame: 0 | 1) {
  const x = p.x * TILE;
  const y = p.y * TILE;
  const w = p.w * TILE;
  const h = p.h * TILE;
  for (let i = 0; i < w; i += 6) c.rect(x + i, y, 1, h, 6);
  for (let i = 0; i < h; i += 6) c.rect(x, y + i, w, 1, 6);
  const d = frame === 0 ? 0 : 3;
  c.rect(x + w / 2 - 3, y + 3 + d, 6, 4, 5);
  c.frame(x + w / 2 - 3, y + 3 + d, 6, 4, 1, 1);
}

// ─────────────────────────────────────────────────────────────
// 牆外的部隊
// ─────────────────────────────────────────────────────────────

function paintCamp(c: Canvas, group: TroopGroup, total: number, frame: 0 | 1) {
  const box = CAMPS[group];
  const x0 = box.x * TILE;
  const y0 = box.y * TILE;
  const w = box.w * TILE;
  const h = box.h * TILE;

  if (total <= 0) {
    // 空營區：只剩地樁，看得出「這一面現在沒有兵」
    for (let i = 0; i < w; i += 8) {
      c.rect(x0 + i, y0, 3, 1, 13);
      c.rect(x0 + i, y0 + h - 1, 3, 1, 13);
    }
    return;
  }

  const n = markCount(total);
  const perRow = box.w > box.h ? Math.ceil(n / 2) : 2;

  for (let i = 0; i < n; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = x0 + 3 + col * Math.max(8, Math.floor((w - 6) / perRow));
    const y = y0 + 3 + row * 11;
    if (x + 9 > x0 + w || y + 9 > y0 + h) continue;
    // 兩幀之間輕微擺動，看起來像活的
    const j = (i + (frame as number)) % 2;

    switch (group) {
      case "CAVALRY":
        c.rect(x, y + j, 8, 5, 6);
        c.rect(x + 6, y - 1 + j, 3, 4, 6);
        c.frame(x, y + j, 8, 5, 1, 1);
        c.rect(x + 1, y + 5 + j, 1, 2, 1);
        c.rect(x + 6, y + 5 + j, 1, 2, 1);
        break;
      case "ARCHER":
        c.rect(x + 1, y + j, 4, 6, 14);
        c.frame(x + 1, y + j, 4, 6, 1, 1);
        c.rect(x + 6, y + 1 + j, 1, 4, 19);
        c.px(x + 5, y + j, 19);
        c.px(x + 5, y + 5 + j, 19);
        break;
      case "INFANTRY":
        c.rect(x + 1, y + j, 5, 6, 4);
        c.frame(x + 1, y + j, 5, 6, 1, 1);
        c.rect(x + 7, y - 1 + j, 1, 8, 7);
        c.px(x + 7, y - 2 + j, 5);
        break;
      case "SIEGE":
        c.rect(x, y, 10, 6, 7);
        c.frame(x, y, 10, 6, 1, 1);
        c.rect(x + 2, y + 1, 6, 3, 9);
        c.rect(x + 1, y + 6, 2, 2, 1);
        c.rect(x + 7, y + 6, 2, 2, 1);
        break;
    }
  }

  // 營旗：一支部隊駐紮的標記
  c.rect(x0 + 1, y0 + 1, 1, 7, 7);
  c.rect(x0 + 2, y0 + 1, 4, 3, group === "SIEGE" ? 9 : 18);
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

export interface SceneSlot {
  readonly slot: "A" | "B" | "C" | "D";
  readonly building: SlotBuilding | null;
  readonly level: number;
  readonly busy: boolean;
}

export interface CitadelSceneInput {
  readonly slots: readonly SceneSlot[];
  readonly garrison: Readonly<Partial<Record<Unit, number>>>;
  readonly frame: 0 | 1;
}

const MAX_LEVEL: Record<SlotBuilding, number> = {
  CITADEL: 33,
  BARRACKS: 30,
  STABLE: 30,
  WORKSHOP: 30,
  DEPOT: 30,
  ARCHIVE: 30,
  RAMPART: 30,
  INFIRMARY: 30,
};

function tierOf(building: SlotBuilding, level: number): number {
  if (level <= 0) return 0;
  const r = level / MAX_LEVEL[building];
  if (r < 0.2) return 1;
  if (r < 0.45) return 2;
  if (r < 0.75) return 3;
  return 4;
}

export function renderCitadelScene(input: CitadelSceneInput): Uint8Array {
  const c = canvas();
  paintTerrain(c);
  paintRoad(c);

  const rampart = input.slots.find((s) => s.building === "RAMPART");
  paintWall(c, rampart?.level ?? 0);

  for (const plot of PLOTS) {
    const s = input.slots.find((x) => x.slot === plot.slot);
    if (!s || s.building === null) {
      paintEmptyPlot(c, plot);
    } else {
      const t = tierOf(s.building, s.level);
      switch (s.building) {
        case "CITADEL":
          paintCitadelTop(c, plot, t, input.frame);
          break;
        case "BARRACKS":
          paintBarracksTop(c, plot, t);
          break;
        case "STABLE":
          paintStableTop(c, plot, t);
          break;
        case "WORKSHOP":
          paintWorkshopTop(c, plot, t, input.frame);
          break;
        case "DEPOT":
          paintDepotTop(c, plot, t);
          break;
        case "ARCHIVE":
          paintArchiveTop(c, plot, t, input.frame);
          break;
        case "RAMPART":
          paintRampartTop(c, plot, t);
          break;
        case "INFIRMARY":
          paintInfirmaryTop(c, plot, t);
          break;
      }
    }
    if (s?.busy) paintScaffold(c, plot, input.frame);
  }

  for (const g of garrisonGroups(input.garrison)) {
    paintCamp(c, g.group, g.total, input.frame);
  }

  return c.g;
}

// ─────────────────────────────────────────────────────────────
// 領地場景：旗幟 → 要塞石塔（docs/02 §2.6）
// ─────────────────────────────────────────────────────────────

/** 領地建物畫在畫面正中央 */
const STRUCTURE_AT = { cx: GRID / 2, cy: GRID / 2 } as const;

/**
 * 領地旗：一根桿子 + 一面會飄的旗。
 *
 * ★ 它是這一格的**所有權標記**，也是攻方的目標 ——
 *   `docs/02` §2.6 說「破壞後即佔領該領地」，
 *   所以它必須在畫面上大到一眼看見，而不是一個角落的小圖示。
 */
function paintFlag(c: Canvas, frame: 0 | 1, owned: boolean) {
  const x = STRUCTURE_AT.cx * TILE;
  const y = STRUCTURE_AT.cy * TILE;

  // 夯實的土台，把旗從草地上抬起來
  c.rect(x - 20, y + 16, 40, 10, 13);
  c.rect(x - 17, y + 12, 34, 6, 12);
  c.frame(x - 20, y + 12, 40, 14, 1, 1);

  // 旗桿
  c.rect(x - 2, y - 34, 4, 50, 7);
  c.rect(x - 2, y - 34, 2, 50, 6);

  // 旗面：兩幀之間換一個形狀 —— 靜止的旗看起來像壞掉的貼圖
  const flagColor = owned ? 18 : 8; // 自己的是生機藍，別人的是鏽紅
  const w = frame === 0 ? 22 : 19;
  c.rect(x + 2, y - 33, w, 14, flagColor);
  c.rect(x + 2, y - 33, w, 3, 19);
  c.frame(x + 2, y - 33, w, 14, 1, 1);
  if (frame === 1) c.rect(x + 2 + w, y - 28, 3, 5, flagColor);

  // 桿頂的尖
  c.rect(x - 2, y - 38, 4, 4, 16);
}

/**
 * 要塞石塔：旗升級之後的樣子。
 *
 * 石塔要**明顯比旗貴重**（`docs/11` §24）：它的耐久是旗的四倍，
 * 而畫面上的體積差不多也是那個比例 —— 玩家不該需要讀數字
 * 才知道這一格難打。
 */
function paintTower(c: Canvas, level: number, frame: 0 | 1, owned: boolean) {
  const x = STRUCTURE_AT.cx * TILE;
  const y = STRUCTURE_AT.cy * TILE;
  const h = 46 + Math.min(24, level * 3); // 等級越高塔越高

  // 基座
  c.rect(x - 26, y + 14, 52, 14, 11);
  c.rect(x - 23, y + 10, 46, 8, 10);
  c.frame(x - 26, y + 10, 52, 18, 1, 1);

  // 塔身：兩層石色交錯出砌塊感
  c.rect(x - 15, y + 14 - h, 30, h, 10);
  for (let i = 0; i < h; i += 7) {
    c.rect(x - 15, y + 14 - h + i, 30, 3, 11);
  }
  c.frame(x - 15, y + 14 - h, 30, h, 1, 1);

  // 箭窗
  c.rect(x - 4, y + 14 - h + 12, 7, 10, 2);
  c.rect(x - 4, y + 14 - h + 30, 7, 10, 2);

  // 雉堞
  for (let i = -15; i < 15; i += 10) {
    c.rect(x + i, y + 6 - h, 6, 9, 10);
    c.frame(x + i, y + 6 - h, 6, 9, 1, 1);
  }

  // 塔頂的旗 —— 佔領的標記還在，只是現在插在石頭上
  const flagColor = owned ? 18 : 8;
  c.rect(x - 2, y - 12 - h, 3, 18, 7);
  const w = frame === 0 ? 15 : 12;
  c.rect(x + 1, y - 11 - h, w, 10, flagColor);
  c.frame(x + 1, y - 11 - h, w, 10, 1, 1);
}

export interface TerritorySceneInput {
  /** FLAG = 領地旗；TOWER = 要塞石塔 */
  readonly structure: "FLAG" | "TOWER";
  /** 要塞等級（旗用不到） */
  readonly level: number;
  /** 是不是自己的地（決定旗色） */
  readonly owned: boolean;
  readonly garrison: Readonly<Partial<Record<Unit, number>>>;
  readonly frame: 0 | 1;
}

/**
 * 一格**領地**的 50×50 場景 —— 沒有城，中央是旗或石塔。
 *
 * ★ 與 `renderCitadelScene` 分開是刻意的：資源地不是「沒蓋東西的據點」，
 *   它是另一種地方。共用一個函式再用 flag 切換，兩邊的構圖遲早互相牽制。
 */
export function renderTerritoryScene(input: TerritorySceneInput): Uint8Array {
  const c = canvas();
  paintTerrain(c);

  if (input.structure === "TOWER") paintTower(c, input.level, input.frame, input.owned);
  else paintFlag(c, input.frame, input.owned);

  for (const g of garrisonGroups(input.garrison)) {
    paintCamp(c, g.group, g.total, input.frame);
  }
  return c.g;
}

/** 調色盤索引 → SVG（同一列連續同色合併成一個 rect） */
export function citadelSceneSvg(input: CitadelSceneInput, pixelSize = 2): string {
  return sceneSvg(renderCitadelScene(input), pixelSize);
}

/** 領地場景（旗／石塔）的 SVG —— 與據點場景共用同一個編碼器 */
export function territorySceneSvg(input: TerritorySceneInput, pixelSize = 2): string {
  return sceneSvg(renderTerritoryScene(input), pixelSize);
}

function sceneSvg(g: Uint8Array, pixelSize: number): string {
  const rects: string[] = [];

  for (let y = 0; y < SCENE_SIZE; y++) {
    let x = 0;
    while (x < SCENE_SIZE) {
      const v = g[y * SCENE_SIZE + x] ?? 0;
      if (v === 0) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < SCENE_SIZE && (g[y * SCENE_SIZE + x + run] ?? 0) === v) run++;
      rects.push(
        `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${run * pixelSize}" ` +
          `height="${pixelSize}" fill="${SPRITE_PALETTE[v]}"/>`,
      );
      x += run;
    }
  }

  const side = SCENE_SIZE * pixelSize;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">${rects.join("")}</svg>`
  );
}

/** 格座標 → 百分比，讓 UI 把按鈕疊在正確的位置上 */
export function pct(cells: number): string {
  return `${(cells / GRID) * 100}%`;
}
