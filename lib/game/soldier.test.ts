import { describe, expect, it } from "vitest";

import { ATTACK_INTERVAL } from "./battlefield";
import type { TroopGroup } from "./citadel";
import {
  DYING_THRESHOLD,
  pickAnim,
  renderSoldier,
  SOLDIER_FRAMES,
  SOLDIER_SIZE,
  type SoldierAnim,
  type SoldierSide,
} from "./soldier";
import { SPRITE_PALETTE } from "./sprite";

const GROUPS: readonly TroopGroup[] = ["INFANTRY", "ARCHER", "CAVALRY", "SIEGE"];
const SIDES: readonly SoldierSide[] = ["ATTACKER", "DEFENDER"];
const ANIMS = Object.keys(SOLDIER_FRAMES) as SoldierAnim[];

/** 有內容的最高列（0 = 最上面）。躺下的東西這個值比站著的大 */
function topRow(g: Uint8Array): number {
  for (let y = 0; y < SOLDIER_SIZE; y++) {
    for (let x = 0; x < SOLDIER_SIZE; x++) {
      // 地面陰影（13）不算身體
      const v = g[y * SOLDIER_SIZE + x]!;
      if (v !== 0 && v !== 13) return y;
    }
  }
  return SOLDIER_SIZE;
}

function opaque(g: Uint8Array): number {
  let n = 0;
  for (const v of g) if (v !== 0) n++;
  return n;
}

describe("renderSoldier：每一格都畫得出來、都合法", () => {
  it("全部組合：25×25、索引合法、不是空白", () => {
    for (const group of GROUPS) {
      for (const side of SIDES) {
        for (const anim of ANIMS) {
          for (let f = 0; f < SOLDIER_FRAMES[anim]; f++) {
            const g = renderSoldier(group, side, anim, f);
            expect(g).toHaveLength(SOLDIER_SIZE * SOLDIER_SIZE);
            for (const v of g) {
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThan(SPRITE_PALETTE.length);
            }
            expect(opaque(g), `${group}/${side}/${anim}#${f} 是空白的`).toBeGreaterThan(30);
          }
        }
      }
    }
  });

  it("★ 動畫要動：同一個動畫的相鄰兩幀必須不同", () => {
    for (const group of GROUPS) {
      for (const anim of ANIMS) {
        for (let f = 0; f < SOLDIER_FRAMES[anim] - 1; f++) {
          const a = renderSoldier(group, "ATTACKER", anim, f);
          const b = renderSoldier(group, "ATTACKER", anim, f + 1);
          expect(Buffer.from(a).equals(Buffer.from(b)), `${group}/${anim} 第 ${f}→${f + 1} 幀沒動`).toBe(
            false,
          );
        }
      }
    }
  });

  it("★ 陣營分得出來：攻守雙方同一幀必須不同（顏色）", () => {
    for (const group of GROUPS) {
      const a = renderSoldier(group, "ATTACKER", "WALK", 0);
      const d = renderSoldier(group, "DEFENDER", "WALK", 0);
      expect(Buffer.from(a).equals(Buffer.from(d))).toBe(false);
    }
  });

  it("★ 屍體要躺下：DEATH 最後一幀的輪廓比 WALK 矮", () => {
    for (const group of GROUPS) {
      const walk = renderSoldier(group, "ATTACKER", "WALK", 0);
      const corpse = renderSoldier(group, "ATTACKER", "DEATH", SOLDIER_FRAMES.DEATH - 1);
      expect(topRow(corpse), `${group} 的屍體站得跟活人一樣高`).toBeGreaterThan(topRow(walk) + 4);
    }
  });

  it("瀕死要看得出來：DYING 的輪廓比 WALK 低（跪、垂頭、傾斜）", () => {
    for (const group of GROUPS) {
      const walk = renderSoldier(group, "ATTACKER", "WALK", 0);
      const dying = renderSoldier(group, "ATTACKER", "DYING", 0);
      expect(topRow(dying), `${group} 的瀕死看不出來`).toBeGreaterThan(topRow(walk));
    }
  });

  it("技能有金色、被擊有閃光", () => {
    for (const group of GROUPS) {
      const skill = renderSoldier(group, "ATTACKER", "SKILL", 1);
      expect([...skill].includes(16), `${group} 的技能沒有金色`).toBe(true);
      const hit = renderSoldier(group, "ATTACKER", "HIT", 0);
      expect([...hit].includes(19) || [...hit].includes(17), `${group} 的被擊沒有閃光`).toBe(true);
    }
  });

  it("frame 取模：越界的 frame 不炸、等於取模後那一幀", () => {
    const a = renderSoldier("INFANTRY", "ATTACKER", "WALK", 7);
    const b = renderSoldier("INFANTRY", "ATTACKER", "WALK", 3);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("pickAnim：死亡 > 技能 > 被擊 > 攻擊 > 瀕死 > 行進", () => {
  const alive = {
    dead: false,
    fighting: false,
    cooldown: 0,
    group: "INFANTRY" as TroopGroup,
    hp: 40,
    maxHp: 40,
  };
  const none = { deathTick: null, skillTick: null, hitTick: null };

  it("預設是走路，seed 錯開步伐", () => {
    expect(pickAnim(alive, none, 10, 0)).toEqual({ anim: "WALK", frame: 10 });
    expect(pickAnim(alive, none, 10, 3).frame).toBe(13);
  });

  it("死亡蓋過一切，倒下後停在最後一幀（屍體）", () => {
    const s = { ...alive, dead: true, fighting: true };
    const ev = { ...none, deathTick: 20, skillTick: 21, hitTick: 21 };
    expect(pickAnim(s, ev, 20)).toEqual({ anim: "DEATH", frame: 0 });
    expect(pickAnim(s, ev, 22)).toEqual({ anim: "DEATH", frame: 2 });
    expect(pickAnim(s, ev, 99)).toEqual({ anim: "DEATH", frame: SOLDIER_FRAMES.DEATH - 1 });
  });

  it("技能演 4 tick，蓋過攻擊", () => {
    const s = { ...alive, fighting: true, cooldown: 3 };
    const ev = { ...none, skillTick: 30 };
    expect(pickAnim(s, ev, 30).anim).toBe("SKILL");
    expect(pickAnim(s, ev, 33).anim).toBe("SKILL");
    expect(pickAnim(s, ev, 34).anim).toBe("ATTACK");
  });

  it("交戰中被打不進被擊動畫 —— 出手不該被打斷；沒交戰才演", () => {
    const ev = { ...none, hitTick: 40 };
    expect(pickAnim({ ...alive, fighting: true, cooldown: 2 }, ev, 40).anim).toBe("ATTACK");
    expect(pickAnim(alive, ev, 40)).toEqual({ anim: "HIT", frame: 0 });
    expect(pickAnim(alive, ev, 42).anim).toBe("WALK");
  });

  it("攻擊幀跟著攻速節奏：出手那一 tick 是第 0 幀", () => {
    const g: TroopGroup = "ARCHER";
    const iv = ATTACK_INTERVAL[g];
    // 剛出手：cooldown 被填滿
    expect(pickAnim({ ...alive, group: g, fighting: true, cooldown: iv }, none, 0)).toEqual({
      anim: "ATTACK",
      frame: 0,
    });
    expect(pickAnim({ ...alive, group: g, fighting: true, cooldown: iv - 1 }, none, 0).frame).toBe(1);
    expect(pickAnim({ ...alive, group: g, fighting: true, cooldown: 0 }, none, 0).frame).toBe(
      SOLDIER_FRAMES.ATTACK - 1,
    );
  });

  it("瀕死取代行進，但不取代攻擊", () => {
    const weak = { ...alive, hp: alive.maxHp * DYING_THRESHOLD };
    expect(pickAnim(weak, none, 8).anim).toBe("DYING");
    expect(pickAnim({ ...weak, fighting: true, cooldown: 1 }, none, 8).anim).toBe("ATTACK");
  });
});
