/**
 * 戰場士兵：25×25 的程式生成像素 sprite，六種動畫狀態。純函式，無 I/O。
 *
 * ## ★ 六態與它們的來源
 *
 * | 動畫 | 什麼時候播 | 幀數 |
 * | --- | --- | --- |
 * | WALK   | 行進與遊走（沒別的事就是它） | 4（循環） |
 * | ATTACK | 交戰中，跟著攻速節奏出手     | 3（出手那一 tick 是第 0 幀） |
 * | SKILL  | 怒氣技的那一擊之後幾 tick    | 4 |
 * | HIT    | 這一 tick 掉了血             | 2 |
 * | DYING  | 血量 ≤ 35%（瀕死）的行進姿態 | 2（循環，跛行） |
 * | DEATH  | 死亡的倒下過程，最後一幀是屍體 | 4（第 3 幀永久停留） |
 *
 * 對應規則在 `pickAnim` —— 它是純函式，畫面層只負責記「什麼時候發生的」
 * （最近掉血、初次看到死亡、放技能的 tick），不做任何規則判斷。
 *
 * ## ★ 美術規範
 *
 * - 調色盤沿用 `sprite.ts` 的 `SPRITE_PALETTE`（docs/09 §3 的 24 色），
 *   **不發明新顏色**。陣營色：攻方鏽紅（8/9）、守方生機藍（18/3）——
 *   與戰場 HUD、據點場景同一套語言。
 * - 所有士兵面向右。戰場上兩軍會交錯，但 25px 的小人翻面
 *   帶來的辨識收益远低於快取翻倍的成本 —— 陣營靠顏色分，不靠朝向。
 * - 圖是**資料**（調色盤索引的 Uint8Array），怎麼變成畫面由呼叫端決定
 *   （canvas ImageData 或 run-length SVG）。
 */

import type { TroopGroup } from "./citadel";
import { ATTACK_INTERVAL } from "./battlefield";
import { SPRITE_PALETTE } from "./sprite";

export const SOLDIER_SIZE = 25;

export type SoldierAnim = "WALK" | "ATTACK" | "SKILL" | "HIT" | "DYING" | "DEATH";
export type SoldierSide = "ATTACKER" | "DEFENDER";

export const SOLDIER_FRAMES: Record<SoldierAnim, number> = {
  WALK: 4,
  ATTACK: 3,
  SKILL: 4,
  HIT: 2,
  DYING: 2,
  DEATH: 4,
};

// ─────────────────────────────────────────────────────────────
// 畫布原語
// ─────────────────────────────────────────────────────────────

/** 陣營色的佔位索引，`renderSoldier` 最後一步換成真的調色盤索引 */
const TEAM = 250;
const TEAM_DARK = 251;

const SIDE_REMAP: Record<SoldierSide, { main: number; dark: number }> = {
  ATTACKER: { main: 8, dark: 9 }, // 鏽紅／鏽紅深
  DEFENDER: { main: 18, dark: 3 }, // 生機藍／中間色陰影
};

type Grid = Uint8Array;

function blank(): Grid {
  return new Uint8Array(SOLDIER_SIZE * SOLDIER_SIZE);
}

function px(g: Grid, x: number, y: number, v: number) {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= SOLDIER_SIZE || yi >= SOLDIER_SIZE) return;
  g[yi * SOLDIER_SIZE + xi] = v;
}

function rect(g: Grid, x: number, y: number, w: number, h: number, v: number) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(g, xx, yy, v);
}

/** 直線（整數步進的 Bresenham 簡版）—— 長矛、馬刀、拋射臂都用它 */
function line(g: Grid, x0: number, y0: number, x1: number, y1: number, v: number) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    px(g, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, v);
  }
}

/** 地面陰影：把人釘在地上的那一筆 */
function shadow(g: Grid, cx: number, half: number) {
  rect(g, cx - half, 23, half * 2, 1, 13);
}

// ─────────────────────────────────────────────────────────────
// 人形（步兵、弓兵共用的身體）
// ─────────────────────────────────────────────────────────────

interface Humanoid {
  /** 身體整體的垂直位移（走路的顛、被擊退的仰） */
  dy: number;
  /** 身體整體的水平位移 */
  dx: number;
  /** 雙腿相位：0..3（走路），-1 = 立正 */
  legPhase: number;
}

/** 站立人形：腿、軀幹、頭盔。武器由各兵種自己畫 */
function humanoid(g: Grid, o: Humanoid) {
  const cx = 12 + o.dx;
  const dy = o.dy;

  // 腿（相位表：接觸-經過-接觸-經過）
  const spread = [
    [-2, 2],
    [0, 0],
    [2, -2],
    [0, 0],
  ][o.legPhase < 0 ? 1 : o.legPhase % 4]!;
  const lift = o.legPhase >= 0 && o.legPhase % 2 === 0 ? 1 : 0;
  rect(g, cx - 3 + spread[0]!, 18 + dy, 2, 5 - dy - (spread[0]! !== 0 ? lift : 0), TEAM_DARK);
  rect(g, cx + 1 + spread[1]!, 18 + dy, 2, 5 - dy - (spread[1]! !== 0 ? lift : 0), TEAM_DARK);
  px(g, cx - 3 + spread[0]!, 22, 1);
  px(g, cx + 1 + spread[1]!, 22, 1); // 靴

  // 軀幹：主色 + 右緣陰影 + 腰帶
  rect(g, cx - 3, 10 + dy, 7, 8, TEAM);
  rect(g, cx + 3, 10 + dy, 1, 8, TEAM_DARK);
  rect(g, cx - 3, 16 + dy, 7, 1, 1);

  // 頭與頭盔（面向右：眼睛靠右）
  rect(g, cx - 2, 5 + dy, 5, 5, 12);
  rect(g, cx - 3, 4 + dy, 7, 2, 4);
  px(g, cx - 3, 6 + dy, 4);
  px(g, cx + 3, 6 + dy, 4);
  px(g, cx + 1, 7 + dy, 1);
}

/** 跪地的人形（瀕死）：高度矮一截、頭低垂 */
function kneeling(g: Grid, sway: number) {
  const cx = 12;
  // 折起的腿
  rect(g, cx - 3, 21, 8, 2, TEAM_DARK);
  // 軀幹前傾
  rect(g, cx - 2 + sway, 14, 6, 7, TEAM);
  rect(g, cx + 3 + sway, 14, 1, 7, TEAM_DARK);
  // 低垂的頭
  rect(g, cx + 1 + sway, 11, 5, 4, 12);
  rect(g, cx + sway, 10, 6, 2, 4);
}

/**
 * 倒下的過程。`k` = 0..3：後仰 → 半倒 → 觸地揚塵 → 屍體。
 * 最後一幀就是永久的屍體 —— 戰場上要留得下屍體，
 * 但它得看得出「曾經是哪一種兵」（武器掉在旁邊）。
 */
function fallingHumanoid(g: Grid, k: number) {
  const cx = 12;
  if (k === 0) {
    // 大幅後仰
    rect(g, cx - 2, 19, 2, 4, TEAM_DARK);
    rect(g, cx + 1, 19, 2, 4, TEAM_DARK);
    rect(g, cx - 5, 12, 7, 7, TEAM);
    rect(g, cx - 7, 8, 5, 5, 12);
    rect(g, cx - 8, 7, 7, 2, 4);
  } else if (k === 1) {
    // 半倒：身體接近水平
    rect(g, cx - 4, 18, 3, 5, TEAM_DARK);
    rect(g, cx - 8, 16, 8, 4, TEAM);
    rect(g, cx - 11, 15, 4, 4, 12);
  } else {
    // 觸地（k=2 有揚塵）與屍體（k=3）
    rect(g, cx - 9, 20, 12, 3, TEAM_DARK);
    rect(g, cx - 9, 19, 8, 1, TEAM);
    rect(g, cx - 12, 19, 3, 3, 12);
    px(g, cx - 12, 19, 4);
    if (k === 2) {
      px(g, cx - 11, 17, 13);
      px(g, cx + 4, 18, 13);
      px(g, cx - 2, 16, 13);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 步兵（長矛 + 盾）
// ─────────────────────────────────────────────────────────────

function paintInfantry(g: Grid, anim: SoldierAnim, f: number) {
  shadow(g, 12, 5);

  if (anim === "DEATH") {
    fallingHumanoid(g, f);
    // 掉落的矛
    if (f >= 2) {
      line(g, 8, 22, 20, 22, 6);
      px(g, 21, 22, 5);
    }
    return;
  }
  if (anim === "DYING") {
    kneeling(g, f === 1 ? 1 : 0);
    // 拄著矛
    line(g, 19, 8, 17, 21, 6);
    px(g, 19, 7, 5);
    return;
  }

  const hit = anim === "HIT";
  const dy = anim === "WALK" && f % 2 === 1 ? -1 : 0;
  const dx = hit ? -(2 - f) : anim === "ATTACK" && f === 1 ? 1 : 0;
  humanoid(g, { dy, dx, legPhase: anim === "WALK" ? f : -1 });
  const cx = 12 + dx;

  // 盾（左手側）
  rect(g, cx - 7, 11 + dy, 3, 6, 4);
  rect(g, cx - 7, 11 + dy, 1, 6, 11);
  px(g, cx - 6, 13 + dy, 5);

  // 矛
  if (anim === "ATTACK" || anim === "SKILL") {
    const skill = anim === "SKILL";
    const reach = [4, 11, 7, 5][Math.min(f, 3)]!; // 收 → 全刺 → 半收
    const sy = 12 + dy;
    line(g, cx - 1, sy, cx + reach, sy, 6);
    px(g, cx + reach + 1, sy, 5);
    if (skill) {
      // 怒氣技：金色矛尖與刺出的殘光
      px(g, cx + reach + 1, sy, 16);
      px(g, cx + reach - 1, sy - 1, 16);
      px(g, cx + reach - 3, sy + 1, 16);
      if (f <= 1) px(g, cx + reach + 2, sy - 1, 19);
    }
  } else {
    line(g, cx + 5, 3 + dy, cx + 5, 17 + dy, 6);
    px(g, cx + 5, 2 + dy, 5);
  }

  if (hit) {
    // 被打：命中閃光與一點血
    px(g, cx + 4, 9, 19);
    px(g, cx + 5, 11, 17);
    if (f === 0) px(g, cx + 3, 7, 19);
  }
}

// ─────────────────────────────────────────────────────────────
// 弓兵（弓 + 箭袋）
// ─────────────────────────────────────────────────────────────

function paintArcher(g: Grid, anim: SoldierAnim, f: number) {
  shadow(g, 12, 5);

  if (anim === "DEATH") {
    fallingHumanoid(g, f);
    if (f >= 2) line(g, 17, 20, 21, 23, 6); // 掉落的弓
    return;
  }
  if (anim === "DYING") {
    kneeling(g, f === 1 ? 1 : 0);
    line(g, 18, 12, 18, 20, 6);
    return;
  }

  const hit = anim === "HIT";
  const dy = anim === "WALK" && f % 2 === 1 ? -1 : 0;
  const dx = hit ? -(2 - f) : 0;
  humanoid(g, { dy, dx, legPhase: anim === "WALK" ? f : -1 });
  const cx = 12 + dx;

  // 箭袋（背後）
  rect(g, cx - 6, 9 + dy, 2, 5, 7);
  px(g, cx - 6, 8 + dy, 19);
  px(g, cx - 5, 8 + dy, 19);

  if (anim === "ATTACK" || anim === "SKILL") {
    const skill = anim === "SKILL";
    const draw = f === 0 ? 1 : 0; // 第 0 幀滿弓
    const settle = f >= 2 ? 1 : 0; // 放箭後弓放低一格（收招）
    // 弓身（弧）與弦
    line(g, cx + 6, 4 + dy + settle, cx + 8, 12 + dy + settle, 6);
    line(g, cx + 8, 12 + dy + settle, cx + 6, 20 + dy + settle, 6);
    line(g, cx + 6, 4 + dy + settle, cx + 4 - draw * 2, 12 + dy + settle, 19);
    line(g, cx + 4 - draw * 2, 12 + dy + settle, cx + 6, 20 + dy + settle, 19);
    if (f === 0) {
      // 搭在弦上的箭
      line(g, cx + 2, 12 + dy, cx + 9, 12 + dy, 6);
      px(g, cx + 10, 12 + dy, skill ? 16 : 5);
      if (skill) {
        px(g, cx + 9, 10 + dy, 16);
        px(g, cx + 9, 14 + dy, 16);
      }
    } else if (f === 1 && skill) {
      // 齊射的殘光
      px(g, cx + 10, 9 + dy, 16);
      px(g, cx + 11, 12 + dy, 16);
      px(g, cx + 10, 15 + dy, 16);
    } else if (f === 2 && skill) {
      // 殘光散去
      px(g, cx + 11, 10 + dy, 16);
      px(g, cx + 11, 14 + dy, 16);
    }
  } else {
    // 行進：弓背在身側
    line(g, cx + 5, 5 + dy, cx + 7, 12 + dy, 6);
    line(g, cx + 7, 12 + dy, cx + 5, 19 + dy, 6);
  }

  if (hit) {
    px(g, cx + 4, 9, 19);
    px(g, cx + 5, 11, 17);
    if (f === 0) px(g, cx + 3, 7, 19);
  }
}

// ─────────────────────────────────────────────────────────────
// 騎兵（馬 + 騎手）
// ─────────────────────────────────────────────────────────────

interface Horse {
  dy: number;
  /** 前腿抬起（人立） */
  rear: boolean;
  /** 垂頭（瀕死）—— 頸與頭畫在低位，不畫揚起的那顆 */
  headLow?: boolean;
  legPhase: number; // -1 = 立正
}

function horse(g: Grid, o: Horse) {
  const dy = o.dy;

  // 四腿（奔馳相位）
  const phases = [
    [-2, 1, -1, 2],
    [0, 0, 0, 0],
    [2, -1, 1, -2],
    [0, 0, 0, 0],
  ][o.legPhase < 0 ? 1 : o.legPhase % 4]!;
  const legX = [6, 9, 15, 18];
  for (let i = 0; i < 4; i++) {
    const front = i >= 2;
    if (o.rear && front) {
      // 人立：前腿懸空前踢
      line(g, legX[i]! + 1, 13 + dy, legX[i]! + 4, 10 + dy, 7);
    } else {
      const sway = o.legPhase < 0 ? 0 : phases[i]!;
      rect(g, legX[i]! + sway, 19 + dy, 2, 4 - dy, 7);
      px(g, legX[i]! + sway, 22, 1);
    }
  }

  // 身體與鬃尾
  const bodyDy = o.rear ? dy - 2 : dy;
  rect(g, 5, 13 + bodyDy, 15, 6, 6);
  rect(g, 5, 17 + bodyDy, 15, 2, 7);
  line(g, 4, 14 + bodyDy, 3, 18 + bodyDy, 7); // 尾

  // 頸與頭（人立時揚起、瀕死時垂低）
  if (o.headLow) {
    line(g, 19, 14 + bodyDy, 21, 17 + bodyDy, 6);
    rect(g, 20, 17 + bodyDy, 4, 3, 6);
    px(g, 23, 19 + bodyDy, 1); // 鼻
  } else {
    const headDy = o.rear ? bodyDy - 2 : bodyDy;
    rect(g, 18, 10 + headDy, 3, 4, 6);
    rect(g, 20, 9 + headDy, 4, 3, 6);
    px(g, 23, 11 + headDy, 1); // 鼻
    px(g, 20, 8 + headDy, 7); // 耳
    line(g, 18, 9 + headDy, 17, 12 + headDy, 7); // 鬃
  }

  // 鞍（陣營色）
  rect(g, 10, 12 + bodyDy, 5, 2, TEAM);
}

function rider(g: Grid, dy: number) {
  rect(g, 10, 7 + dy, 4, 6, TEAM);
  rect(g, 13, 7 + dy, 1, 6, TEAM_DARK);
  rect(g, 10, 3 + dy, 4, 4, 12);
  rect(g, 9, 2 + dy, 6, 2, 4);
  px(g, 12, 4 + dy, 1);
}

function paintCavalry(g: Grid, anim: SoldierAnim, f: number) {
  shadow(g, 12, 9);

  if (anim === "DEATH") {
    if (f === 0) {
      // 前腿一軟
      horse(g, { dy: 1, rear: false, legPhase: -1 });
      rider(g, 2);
    } else if (f === 1) {
      // 跪倒
      rect(g, 5, 16, 15, 5, 6);
      rect(g, 5, 19, 15, 2, 7);
      rect(g, 18, 13, 5, 3, 6);
      rect(g, 10, 10, 4, 6, TEAM);
      rect(g, 10, 6, 4, 4, 12);
    } else {
      // 側倒的馬 + 摔落的騎手
      rect(g, 5, 19, 16, 4, 6);
      rect(g, 5, 21, 16, 2, 7);
      rect(g, 19, 18, 4, 3, 6);
      line(g, 8, 18, 12, 18, 7);
      rect(g, 1, 20, 4, 3, TEAM_DARK);
      px(g, 1, 19, 12);
      if (f === 2) {
        px(g, 4, 16, 13);
        px(g, 14, 16, 13);
        px(g, 21, 15, 13);
      }
    }
    return;
  }
  if (anim === "DYING") {
    // 馬垂頭、騎手伏低
    horse(g, { dy: 1, rear: false, headLow: true, legPhase: -1 });
    rect(g, 10, 10 + (f === 1 ? 1 : 0), 5, 4, TEAM); // 伏低的騎手
    rect(g, 13, 8 + (f === 1 ? 1 : 0), 3, 3, 12);
    return;
  }

  const hit = anim === "HIT";
  const dy = anim === "WALK" && f % 2 === 1 ? -1 : 0;
  const rearing = anim === "SKILL" && f <= 1;
  horse(g, { dy, rear: rearing, legPhase: anim === "WALK" ? f : -1 });
  rider(g, dy + (rearing ? -2 : 0));

  // 馬刀
  if (anim === "ATTACK" || anim === "SKILL") {
    const skill = anim === "SKILL";
    if (f === 0) {
      line(g, 15, 2, 17, 6, 5); // 高舉
      if (skill) px(g, 15, 1, 16);
    } else if (f === 1) {
      line(g, 15, 5, 21, 10, 5); // 劈下
      px(g, 19, 7, 19);
      if (skill) {
        px(g, 21, 8, 16);
        px(g, 18, 5, 16);
        px(g, 22, 11, 16);
      }
    } else {
      line(g, 15, 9, 20, 11, 5); // 收刀
      if (skill && f === 2) px(g, 22, 10, 16); // 殘光散去
    }
  } else {
    line(g, 15, 6 + dy, 18, 10 + dy, 5);
  }

  if (hit) {
    px(g, 14, 5, 19);
    px(g, 16, 12, 17);
    if (f === 0) px(g, 19, 9, 19);
  }
}

// ─────────────────────────────────────────────────────────────
// 器械（投石機）
// ─────────────────────────────────────────────────────────────

function paintSiege(g: Grid, anim: SoldierAnim, f: number) {
  shadow(g, 12, 10);

  if (anim === "DEATH") {
    if (f === 0) {
      siegeBody(g, 1, 0, "cocked", false);
    } else if (f === 1) {
      // 塌了一半：左輪脫落
      rect(g, 3, 21, 6, 2, 7); // 躺平的輪
      siegeFrame(g, 2, -2);
      line(g, 10, 19, 4, 12, 6);
    } else {
      // 殘骸
      rect(g, 4, 21, 7, 2, 7);
      rect(g, 13, 20, 9, 3, 6);
      line(g, 6, 20, 14, 16, 7);
      line(g, 15, 19, 21, 15, 6);
      px(g, 17, 21, 5);
      if (f === 2) {
        px(g, 7, 17, 13);
        px(g, 18, 14, 13);
        px(g, 12, 15, 13);
      }
    }
    return;
  }
  if (anim === "DYING") {
    // 一輪已破，整台傾斜，臂垂著
    rect(g, 3, 21 + (f === 1 ? 1 : 0), 6, 2, 7);
    siegeFrame(g, 1, -1);
    wheel(g, 18, 20, 0);
    line(g, 12, 17, 18, 10, 6); // 垂臂
    return;
  }

  const hit = anim === "HIT";
  const dy = anim === "WALK" && f % 2 === 1 ? -1 : 0;
  const pose =
    anim === "ATTACK" || anim === "SKILL" ? (["cocked", "fired", "settle"] as const)[Math.min(f, 2)]! : "cocked";
  siegeBody(g, 0, dy, pose, anim === "WALK" ? f % 2 === 1 : false);

  if ((anim === "ATTACK" || anim === "SKILL") && f === 1) {
    // 出膛的石彈
    const skill = anim === "SKILL";
    px(g, 21, 4, skill ? 16 : 10);
    px(g, 19, 6, skill ? 16 : 19);
    if (skill) {
      px(g, 17, 8, 16);
      px(g, 22, 2, 19);
    }
  }
  if (anim === "SKILL" && f === 3) px(g, 20, 6, 16);

  if (hit) {
    px(g, 10, 12, 19);
    px(g, 14, 15, 17);
    if (f === 0) px(g, 8, 10, 19);
  }
}

function wheel(g: Grid, cx: number, cy: number, spin: 0 | 1) {
  rect(g, cx - 2, cy - 2, 5, 5, 7);
  rect(g, cx - 1, cy - 1, 3, 3, 6);
  px(g, cx, cy, 5);
  // 輻條的兩個轉位 —— 器械的「步行」就是輪子在轉
  if (spin === 0) {
    px(g, cx, cy - 2, 1);
    px(g, cx, cy + 2, 1);
    px(g, cx - 2, cy, 1);
    px(g, cx + 2, cy, 1);
  } else {
    px(g, cx - 2, cy - 2, 1);
    px(g, cx + 2, cy - 2, 1);
    px(g, cx - 2, cy + 2, 1);
    px(g, cx + 2, cy + 2, 1);
  }
}

function siegeFrame(g: Grid, tilt: number, dx: number) {
  rect(g, 4 + dx, 17 + tilt, 17, 2, 6);
  rect(g, 4 + dx, 18 + tilt, 17, 1, 7);
  rect(g, 11 + dx, 14 + tilt, 3, 3, TEAM); // 陣營旗布
}

function siegeBody(g: Grid, tilt: number, dy: number, pose: "cocked" | "fired" | "settle", spin: boolean) {
  wheel(g, 7, 20 + dy, spin ? 1 : 0);
  wheel(g, 18, 20 + dy, spin ? 1 : 0);
  siegeFrame(g, dy + tilt, 0);
  // 支架
  line(g, 8, 17 + dy, 12, 11 + dy, 7);
  line(g, 16, 17 + dy, 12, 11 + dy, 7);
  // 拋射臂
  if (pose === "cocked") {
    line(g, 14, 16 + dy, 6, 7 + dy, 6);
    rect(g, 4, 5 + dy, 3, 2, 7);
    px(g, 5, 4 + dy, 10); // 待發的石彈
  } else if (pose === "fired") {
    line(g, 12, 16 + dy, 18, 5 + dy, 6);
    rect(g, 17, 3 + dy, 3, 2, 7);
  } else {
    line(g, 13, 16 + dy, 16, 6 + dy, 6);
    rect(g, 15, 4 + dy, 3, 2, 7);
  }
}

// ─────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────

/** (group, side, anim, frame) → 25×25 的調色盤索引。決定性、可快取 */
export function renderSoldier(
  group: TroopGroup,
  side: SoldierSide,
  anim: SoldierAnim,
  frame: number,
): Grid {
  const g = blank();
  const f = ((frame % SOLDIER_FRAMES[anim]) + SOLDIER_FRAMES[anim]) % SOLDIER_FRAMES[anim];

  switch (group) {
    case "INFANTRY":
      paintInfantry(g, anim, f);
      break;
    case "ARCHER":
      paintArcher(g, anim, f);
      break;
    case "CAVALRY":
      paintCavalry(g, anim, f);
      break;
    case "SIEGE":
      paintSiege(g, anim, f);
      break;
  }

  // 陣營色佔位 → 真的調色盤索引
  const remap = SIDE_REMAP[side];
  for (let i = 0; i < g.length; i++) {
    if (g[i] === TEAM) g[i] = remap.main;
    else if (g[i] === TEAM_DARK) g[i] = remap.dark;
  }
  return g;
}

// ─────────────────────────────────────────────────────────────
// 動畫狀態機
// ─────────────────────────────────────────────────────────────

/** 血量比例低於這個門檻就是「瀕死」—— 跛行、跪地 */
export const DYING_THRESHOLD = 0.35;

/** 技能與被擊動畫各演幾 tick */
const SKILL_TICKS = 4;
const HIT_TICKS = 2;

export interface AnimEvents {
  /** 第一次看到 dead 的 tick；null = 還活著 */
  readonly deathTick: number | null;
  /** 最近一次放技能（skillBurst）的 tick */
  readonly skillTick: number | null;
  /** 最近一次掉血的 tick */
  readonly hitTick: number | null;
}

export interface AnimPick {
  readonly anim: SoldierAnim;
  readonly frame: number;
}

/**
 * 這一 tick 該播哪個動畫的哪一幀。
 *
 * 優先序：死亡 > 技能 > 被擊 > 攻擊 > 瀕死 > 行進。
 * - 攻擊幀跟著**攻速節奏**走：出手那一 tick（cooldown 剛被填滿）是第 0 幀，
 *   之後順著 cooldown 遞減播收招 —— 動畫自然與傷害同步，不用另外記時間。
 * - 瀕死不蓋掉攻擊：斷了一條腿還是會刺出那一矛。它取代的是行進姿態。
 * - `seed` 用來錯開同隊士兵的步伐相位（畫面層通常給 squad id）。
 */
export function pickAnim(
  s: {
    readonly dead: boolean;
    readonly fighting: boolean;
    readonly cooldown: number;
    readonly group: TroopGroup;
    readonly hp: number;
    readonly maxHp: number;
  },
  ev: AnimEvents,
  tick: number,
  seed = 0,
): AnimPick {
  if (s.dead || ev.deathTick !== null) {
    const start = ev.deathTick ?? tick;
    return { anim: "DEATH", frame: Math.min(SOLDIER_FRAMES.DEATH - 1, Math.max(0, tick - start)) };
  }
  if (ev.skillTick !== null && tick - ev.skillTick < SKILL_TICKS) {
    return { anim: "SKILL", frame: tick - ev.skillTick };
  }
  if (ev.hitTick !== null && tick - ev.hitTick < HIT_TICKS && !s.fighting) {
    return { anim: "HIT", frame: tick - ev.hitTick };
  }
  if (s.fighting) {
    const sinceSwing = ATTACK_INTERVAL[s.group] - s.cooldown;
    return { anim: "ATTACK", frame: Math.min(SOLDIER_FRAMES.ATTACK - 1, Math.max(0, sinceSwing)) };
  }
  if (s.maxHp > 0 && s.hp / s.maxHp <= DYING_THRESHOLD) {
    return { anim: "DYING", frame: (tick + seed) >> 1 };
  }
  return { anim: "WALK", frame: tick + seed };
}

// ─────────────────────────────────────────────────────────────
// SVG（美術檢視表與測試截圖用；戰場本體走 canvas ImageData）
// ─────────────────────────────────────────────────────────────

export function soldierSvg(g: Grid, pixelSize = 6): string {
  const rects: string[] = [];
  for (let y = 0; y < SOLDIER_SIZE; y++) {
    let x = 0;
    while (x < SOLDIER_SIZE) {
      const v = g[y * SOLDIER_SIZE + x] ?? 0;
      if (v === 0) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < SOLDIER_SIZE && (g[y * SOLDIER_SIZE + x + run] ?? 0) === v) run++;
      rects.push(
        `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${run * pixelSize}" ` +
          `height="${pixelSize}" fill="${SPRITE_PALETTE[v]}"/>`,
      );
      x += run;
    }
  }
  const side = SOLDIER_SIZE * pixelSize;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" ` +
    `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">${rects.join("")}</svg>`
  );
}
