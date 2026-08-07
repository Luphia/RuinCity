/**
 * 據點的俯視全景。純函式，無 I/O。
 * 對應 `docs/09` §6「據點」與 §2（像素規範）、§3（24 色調色盤）。
 *
 * ## ★ 為什麼從「四張並排的圖」改成「一張俯視圖」
 *
 * 四格並排說得出「你有哪四棟建築」，但說不出**它們是一座城**。
 * 一張俯視圖多帶三件在四格版本裡無處可放的資訊：
 *
 *   1. **牆**。城牆是一棟建築（`RAMPART`），但它在概念上包住其他三棟 ——
 *      並排的格子畫不出「包住」。
 *   2. **內外**。兵力在牆外紮營、建築在牆內，一眼就看得出
 *      「這座城有多少人守著」。
 *   3. **空地**。沒蓋的格子是城裡一塊真的空地，不是一個灰色方塊。
 *
 * ## ★ 投影：正俯視，不是 3/4
 *
 * `sprite.ts` 的建築是立面（看得到屋頂斜面與煙囪），那是給
 * 「單棟放大」用的。俯視圖裡所有東西都從正上方看，
 * **兩種投影不能混在同一張圖裡** —— 混了之後陰影方向會互相打架。
 * 所以這裡是另一組 `paint*`，不是重用 `sprite.ts` 的。
 * 共用的只有調色盤。
 *
 * ## ★ 座標同時是點擊區
 *
 * `PLOTS` 既是畫圖的位置，也是 UI 疊按鈕的位置。
 * 兩份座標遲早分岔，而分岔的症狀是「點了 A 卻升級了 B」。
 */

import { UNIT, UNITS, type Unit } from "./balance";
import { SPRITE_PALETTE, type PaletteIndex } from "./sprite";
import type { SlotBuilding } from "./sprite";

/** 畫布邊長。160 = 5 × 32，維持 `docs/09` §2 的 32 基準 */
export const SCENE_SIZE = 160;

export { SPRITE_PALETTE };

/** 城牆圍出來的範圍 */
export const WALL = { x: 20, y: 22, w: 120, h: 92 } as const;

export interface Plot {
  readonly slot: "A" | "B" | "C" | "D";
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * 四塊地。主堡在正中，其餘三塊在西／東／南 ——
 * 對稱的排法讓「哪一塊是空的」一眼看得出來。
 */
export const PLOTS: readonly Plot[] = [
  { slot: "A", x: 67, y: 46, w: 26, h: 26 },
  { slot: "B", x: 28, y: 40, w: 26, h: 24 },
  { slot: "C", x: 106, y: 40, w: 26, h: 24 },
  { slot: "D", x: 67, y: 84, w: 26, h: 24 },
] as const;

/** 牆外的四支部隊。順序＝畫面由左到右 */
export const TROOP_GROUPS = ["CAVALRY", "ARCHER", "INFANTRY", "SIEGE"] as const;
export type TroopGroup = (typeof TROOP_GROUPS)[number];

export const TROOP_LABEL: Record<TroopGroup, string> = {
  CAVALRY: "騎兵",
  ARCHER: "弓兵",
  INFANTRY: "步兵",
  SIEGE: "器械",
};

/**
 * 兵種 → 牆外的哪一支。
 *
 * ★ 依 `attackClass` 分，但**弓手要單獨拉出來**：
 *   它在戰鬥模型裡屬於 INFANTRY（`docs/04`），在畫面上卻是自己一支 ——
 *   玩家問「我有多少弓」的時候，答案不該藏在步兵裡。
 *
 *   偵查兵（`attackClass: NONE`）併進步兵：它是徒步的，
 *   而且不該憑空多一支不存在的部隊。數字仍會逐兵種列在圖下方，
 *   所以沒有任何東西被藏起來。
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

// ─────────────────────────────────────────────────────────────
// 畫布
// ─────────────────────────────────────────────────────────────

interface Canvas {
  readonly g: Uint8Array;
  set(x: number, y: number, v: PaletteIndex): void;
  rect(x: number, y: number, w: number, h: number, v: PaletteIndex): void;
  /** 空心矩形，用來畫牆與地基 */
  frame(x: number, y: number, w: number, h: number, v: PaletteIndex, thick?: number): void;
}

function canvas(): Canvas {
  const g = new Uint8Array(SCENE_SIZE * SCENE_SIZE);
  const set = (x: number, y: number, v: PaletteIndex) => {
    if (x < 0 || y < 0 || x >= SCENE_SIZE || y >= SCENE_SIZE) return;
    g[y * SCENE_SIZE + x] = v;
  };
  const rect = (x: number, y: number, w: number, h: number, v: PaletteIndex) => {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) set(x + dx, y + dy, v);
  };
  return {
    g,
    set,
    rect,
    frame(x, y, w, h, v, thick = 1) {
      rect(x, y, w, thick, v);
      rect(x, y + h - thick, w, thick, v);
      rect(x, y, thick, h, v);
      rect(x + w - thick, y, thick, h, v);
    },
  };
}

/** 荒地。固定的雜訊 —— 這是背景，不需要隨機 */
function paintGround(c: Canvas) {
  c.rect(0, 0, SCENE_SIZE, SCENE_SIZE, 12);
  for (let y = 0; y < SCENE_SIZE; y += 2) {
    for (let x = (y / 2) % 4; x < SCENE_SIZE; x += 7) c.set(x, y, 13);
  }
  for (const [x, y] of [
    [8, 18],
    [148, 40],
    [12, 130],
    [150, 128],
    [78, 8],
  ] as const) {
    c.rect(x, y, 3, 2, 15);
    c.set(x + 1, y - 1, 14);
  }
}

/**
 * 城牆。等級決定厚度與塔的數量 —— `RAMPART` 沒蓋時只有一圈木柵。
 */
function paintWall(c: Canvas, rampartLevel: number) {
  const { x, y, w, h } = WALL;
  const built = rampartLevel > 0;
  const thick = built ? (rampartLevel >= 15 ? 4 : 3) : 2;
  const body = built ? 10 : 6;
  const edge = built ? 11 : 7;

  c.frame(x, y, w, h, edge, thick + 1);
  c.frame(x + 1, y + 1, w - 2, h - 2, body, thick - 1);
  c.frame(x - 1, y - 1, w + 2, h + 2, 1, 1);
  c.frame(x + thick, y + thick, w - thick * 2, h - thick * 2, 1, 1);

  // 城門：南牆正中，開口 + 兩側門柱
  const gx = x + w / 2 - 7;
  c.rect(gx, y + h - thick - 1, 14, thick + 2, 12);
  c.rect(gx - 2, y + h - thick - 2, 2, thick + 3, 7);
  c.rect(gx + 14, y + h - thick - 2, 2, thick + 3, 7);
  // 門前的路
  c.rect(gx + 4, y + h, 6, 10, 13);

  if (!built) return;

  // 角塔；Lv10 起加上南北中塔
  const towers: [number, number][] = [
    [x - 2, y - 2],
    [x + w - 6, y - 2],
    [x - 2, y + h - 6],
    [x + w - 6, y + h - 6],
  ];
  if (rampartLevel >= 10) {
    towers.push([x + w / 2 - 4, y - 3], [x - 3, y + h / 2 - 4], [x + w - 5, y + h / 2 - 4]);
  }
  for (const [tx, ty] of towers) {
    c.rect(tx, ty, 8, 8, 10);
    c.frame(tx, ty, 8, 8, 1, 1);
    c.rect(tx + 2, ty + 2, 4, 4, 11);
  }
}

/** 內部道路：從城門通到主堡，再分岔到三塊地 */
function paintRoads(c: Canvas) {
  const a = PLOTS[0]!;
  const cx = a.x + a.w / 2;
  c.rect(cx - 3, a.y + a.h, 6, WALL.y + WALL.h - (a.y + a.h) - 3, 13);
  c.rect(WALL.x + 6, a.y + 8, WALL.w - 12, 5, 13);
}

// ─────────────────────────────────────────────────────────────
// 建築的俯視外觀
// ─────────────────────────────────────────────────────────────

/** 屋頂：外框 + 內填 + 一條屋脊。所有建築共用這個底 */
function roof(c: Canvas, p: Plot, fill: PaletteIndex, shade: PaletteIndex, ridge = true) {
  c.rect(p.x, p.y, p.w, p.h, fill);
  c.frame(p.x, p.y, p.w, p.h, shade, 2);
  c.frame(p.x - 1, p.y - 1, p.w + 2, p.h + 2, 1, 1);
  if (ridge) c.rect(p.x + 2, p.y + p.h / 2 - 1, p.w - 4, 2, shade);
}

function paintCitadelTop(c: Canvas, p: Plot, t: number, frame: 0 | 1) {
  // 外郭
  c.rect(p.x, p.y, p.w, p.h, 11);
  c.frame(p.x - 1, p.y - 1, p.w + 2, p.h + 2, 1, 1);

  /**
   * ★ 等級越高，中央的天守越**大而亮**，不是越暗。
   *
   *   第一版用「內縮的深色矩形」表示塔樓，結果滿級的主堡看起來像
   *   一個洞 —— 玩家花了整個賽季升級，畫面回饋卻是越蓋越空。
   *   俯視圖裡「高」只能用亮度與層次表達，所以改成一層層往上疊亮階。
   */
  const layers = 1 + t; // 1–5 層
  for (let i = 0; i < layers; i++) {
    const inset = 2 + i * 2;
    const w = p.w - inset * 2;
    const h = p.h - inset * 2;
    if (w < 4 || h < 4) break;
    c.rect(p.x + inset, p.y + inset, w, h, i % 2 === 0 ? 10 : 11);
    c.frame(p.x + inset, p.y + inset, w, h, 1, 1);
  }

  // 四角的垛
  for (const [dx, dy] of [
    [0, 0],
    [p.w - 3, 0],
    [0, p.h - 3],
    [p.w - 3, p.h - 3],
  ] as const) {
    c.rect(p.x + dx, p.y + dy, 3, 3, 10);
    c.frame(p.x + dx, p.y + dy, 3, 3, 1, 1);
  }

  // 旗：t≥2 才有，兩幀之間左右飄。滿級換成遺物金
  if (t >= 2) {
    const fx = p.x + p.w / 2;
    const fy = p.y + p.h / 2;
    c.set(fx, fy - 1, 1);
    c.set(fx, fy, 1);
    const dir = frame === 0 ? 1 : -1;
    c.rect(fx + (dir > 0 ? 1 : -3), fy - 2, 3, 3, t >= 4 ? 16 : 8);
  }
}

function paintBarracksTop(c: Canvas, p: Plot, t: number) {
  roof(c, p, 6, 7);
  // 訓練場：等級越高，靶越多
  for (let i = 0; i < Math.min(4, 1 + t); i++) {
    c.rect(p.x + 3 + i * 5, p.y + 3, 3, 3, 8);
    c.set(p.x + 4 + i * 5, p.y + 4, 17);
  }
}

function paintStableTop(c: Canvas, p: Plot, t: number) {
  roof(c, p, 6, 7);
  // 圍欄：等級越高圍得越滿
  const n = 2 + t;
  for (let i = 0; i < n && p.x + 3 + i * 4 < p.x + p.w - 3; i++) {
    c.rect(p.x + 3 + i * 4, p.y + p.h - 6, 2, 4, 7);
  }
  c.rect(p.x + 3, p.y + 3, p.w - 6, 3, 7);
}

function paintWorkshopTop(c: Canvas, p: Plot, t: number, frame: 0 | 1) {
  roof(c, p, 4, 3);
  // 天窗
  for (let i = 0; i < 3; i++) c.rect(p.x + 4 + i * 6, p.y + 4, 4, 4, 5);
  // 煙囪 + 煙（兩幀交錯）
  c.rect(p.x + p.w - 8, p.y + p.h - 8, 5, 5, 9);
  c.frame(p.x + p.w - 8, p.y + p.h - 8, 5, 5, 1, 1);
  if (t >= 2) {
    const d = frame === 0 ? 0 : 1;
    c.rect(p.x + p.w - 7 + d, p.y + p.h - 11, 3, 2, 3);
  }
  if (t >= 4) c.rect(p.x + p.w - 7, p.y + p.h - 7, 3, 3, 17);
}

function paintDepotTop(c: Canvas, p: Plot, t: number) {
  roof(c, p, 6, 7, false);
  // 貨箱：等級越高堆越滿
  const spots: [number, number][] = [
    [3, 3],
    [10, 3],
    [17, 3],
    [3, 12],
    [10, 12],
    [17, 12],
  ];
  for (let i = 0; i < Math.min(spots.length, 2 + t); i++) {
    const [dx, dy] = spots[i]!;
    if (p.x + dx + 5 > p.x + p.w - 2 || p.y + dy + 5 > p.y + p.h - 2) continue;
    c.rect(p.x + dx, p.y + dy, 5, 5, 8);
    c.frame(p.x + dx, p.y + dy, 5, 5, 9, 1);
  }
}

function paintArchiveTop(c: Canvas, p: Plot, t: number, frame: 0 | 1) {
  roof(c, p, 10, 11, false);
  // 中庭
  c.rect(p.x + 5, p.y + 5, p.w - 10, p.h - 10, 12);
  c.frame(p.x + 5, p.y + 5, p.w - 10, p.h - 10, 1, 1);
  if (t >= 3) {
    const lit = frame === 0 ? 18 : 4;
    c.rect(p.x + p.w / 2 - 2, p.y + p.h / 2 - 2, 4, 4, lit);
  }
}

function paintRampartTop(c: Canvas, p: Plot, t: number) {
  // 城牆蓋在 B/C/D 其中一格時，那塊地是軍械庫與工事堆料
  roof(c, p, 11, 10, false);
  for (let i = 0; i < 3 + Math.min(3, t); i++) {
    const dx = 3 + (i % 4) * 5;
    const dy = 3 + Math.floor(i / 4) * 7;
    if (p.y + dy + 5 > p.y + p.h - 2) break;
    c.rect(p.x + dx, p.y + dy, 4, 5, 10);
    c.frame(p.x + dx, p.y + dy, 4, 5, 1, 1);
  }
}

function paintInfirmaryTop(c: Canvas, p: Plot, t: number) {
  roof(c, p, 19, 10, false);
  // 布條十字
  c.rect(p.x + p.w / 2 - 2, p.y + 3, 4, p.h - 6, 17);
  c.rect(p.x + 3, p.y + p.h / 2 - 2, p.w - 6, 4, 17);
  if (t >= 2) c.rect(p.x + 2, p.y + 2, 4, 4, 6);
}

/**
 * 空地。
 *
 * ★ 不能填滿顏色。第一版用深色的沙土填滿，結果三塊空地看起來像
 *   三棟灰褐色的建築 —— 開局的畫面於是說了謊：明明什麼都沒蓋，
 *   看起來卻像已經有四棟。
 *
 *   改成**留原本的地面**，只用虛線的石樁圈出範圍，中央放一個「＋」。
 *   空地要看起來是空的，而且要看起來可以點。
 */
function paintEmptyPlot(c: Canvas, p: Plot) {
  for (let x = p.x; x < p.x + p.w; x += 3) {
    c.set(x, p.y, 11);
    c.set(x, p.y + p.h - 1, 11);
  }
  for (let y = p.y; y < p.y + p.h; y += 3) {
    c.set(p.x, y, 11);
    c.set(p.x + p.w - 1, y, 11);
  }
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  c.rect(cx - 4, cy - 1, 9, 2, 11);
  c.rect(cx - 1, cy - 4, 2, 9, 11);
}

/** 鷹架：施工中 */
function paintScaffold(c: Canvas, p: Plot, frame: 0 | 1) {
  for (let x = p.x; x < p.x + p.w; x += 5) c.rect(x, p.y, 1, p.h, 6);
  for (let y = p.y; y < p.y + p.h; y += 6) c.rect(p.x, y, p.w, 1, 6);
  const d = frame === 0 ? 0 : 2;
  c.rect(p.x + p.w / 2 - 2, p.y + 2 + d, 4, 3, 5);
  c.frame(p.x + p.w / 2 - 2, p.y + 2 + d, 4, 3, 1, 1);
}

// ─────────────────────────────────────────────────────────────
// 牆外的部隊
// ─────────────────────────────────────────────────────────────

/** 一支部隊的營地位置（畫布座標） */
export const CAMPS: Record<TroopGroup, { x: number; y: number; w: number; h: number }> = {
  CAVALRY: { x: 6, y: 122, w: 34, h: 32 },
  ARCHER: { x: 44, y: 122, w: 34, h: 32 },
  INFANTRY: { x: 82, y: 122, w: 34, h: 32 },
  SIEGE: { x: 120, y: 122, w: 34, h: 32 },
};

/**
 * 一支部隊畫幾個小人。
 *
 * ★ 不是「一人一點」—— 一萬名步兵畫不下，而且也沒有意義。
 *   用對數：0 → 0 個、1 → 1 個、10 → 3 個、100 → 5 個、1000 → 7 個。
 *   玩家要看的是「多不多」，精確的數字在圖下方的文字裡。
 */
export function markCount(total: number, max = 9): number {
  if (total <= 0) return 0;
  return Math.max(1, Math.min(max, Math.round(Math.log10(total + 1) * 2.5) + 1));
}

function paintCamp(c: Canvas, group: TroopGroup, total: number, frame: 0 | 1) {
  const box = CAMPS[group];
  if (total <= 0) {
    // 空營地：只剩地樁，看得出「這支部隊現在不在」
    c.frame(box.x + 2, box.y + 6, box.w - 4, box.h - 14, 13, 1);
    return;
  }

  // 營帳
  c.rect(box.x + 2, box.y, box.w - 4, 5, 8);
  c.frame(box.x + 2, box.y, box.w - 4, 5, 9, 1);

  const n = markCount(total);
  for (let i = 0; i < n; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = box.x + 4 + col * 10;
    const y = box.y + 9 + row * 8;
    // 兩幀之間輕微擺動，看起來像活的
    const jitter = (i + (frame as number)) % 2;

    switch (group) {
      case "CAVALRY":
        c.rect(x, y + jitter, 7, 4, 6);
        c.rect(x + 5, y - 1 + jitter, 2, 3, 6);
        c.frame(x, y + jitter, 7, 4, 1, 1);
        break;
      case "ARCHER":
        c.rect(x + 1, y + jitter, 3, 5, 14);
        c.set(x + 4, y + 1 + jitter, 19);
        c.set(x + 4, y + 3 + jitter, 19);
        c.frame(x + 1, y + jitter, 3, 5, 1, 1);
        break;
      case "INFANTRY":
        c.rect(x + 1, y + jitter, 4, 5, 4);
        c.rect(x + 5, y - 1 + jitter, 1, 6, 7);
        c.frame(x + 1, y + jitter, 4, 5, 1, 1);
        break;
      case "SIEGE":
        c.rect(x, y, 8, 5, 7);
        c.frame(x, y, 8, 5, 1, 1);
        c.set(x + 1, y + 5, 1);
        c.set(x + 6, y + 5, 1);
        c.rect(x + 2, y + 1, 4, 2, 9);
        break;
    }
  }
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
  const r = level / MAX_LEVEL[building];
  if (level <= 0) return 0;
  if (r < 0.2) return 1;
  if (r < 0.45) return 2;
  if (r < 0.75) return 3;
  return 4;
}

export function renderCitadelScene(input: CitadelSceneInput): Uint8Array {
  const c = canvas();
  paintGround(c);

  // 城牆的樣子取決於有沒有蓋 RAMPART、蓋到幾級
  const rampart = input.slots.find((s) => s.building === "RAMPART");
  paintWall(c, rampart?.level ?? 0);
  paintRoads(c);

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

/** 調色盤索引 → SVG（同一列連續同色合併成一個 rect） */
export function citadelSceneSvg(input: CitadelSceneInput, pixelSize = 3): string {
  const g = renderCitadelScene(input);
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

/** 畫布座標 → 百分比，讓 UI 把按鈕疊在正確的位置上 */
export function pct(value: number): string {
  return `${(value / SCENE_SIZE) * 100}%`;
}
