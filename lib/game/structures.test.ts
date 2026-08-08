import { describe, expect, it } from "vitest";

import { ROAD, STRUCTURE, STRUCTURE_REPAIR } from "./balance";
import { marchTime } from "./march";
import {
  currentHp,
  hasSiegeEngine,
  maxHpOf,
  onNetwork,
  roadMultiplier,
  structureDamage,
  structureOf,
  wavesToDestroy,
} from "./structures";

describe("領地建物", () => {
  it("旗 → 石塔 → 主城，依這一格上有什麼", () => {
    expect(structureOf({})).toBe("FLAG");
    expect(structureOf({ facility: "FARM" })).toBe("FLAG");
    expect(structureOf({ facility: "FORTRESS" })).toBe("TOWER");
    expect(structureOf({ isBase: true })).toBe("KEEP");
    // 主城優先 —— 據點那一格就算掛著設施也還是主城
    expect(structureOf({ isBase: true, facility: "FORTRESS" })).toBe("KEEP");
  });

  it("耐久：旗吃不到等級，石塔與主城吃", () => {
    expect(maxHpOf("FLAG")).toBe(STRUCTURE.FLAG.hpBase);
    expect(maxHpOf("FLAG", 9)).toBe(STRUCTURE.FLAG.hpBase);
    expect(maxHpOf("TOWER", 1)).toBe(1200);
    expect(maxHpOf("TOWER", 3)).toBe(2400);
    expect(maxHpOf("KEEP", 20)).toBe(8000);
  });
});

describe("★ 一般部隊對建物只有 1 點傷害", () => {
  it("三千名劍士拆不掉一座 Lv1 石塔，二十台投石機一趟拆完", () => {
    const swords = structureDamage({ SWORDSMAN: 3000 });
    const catapults = structureDamage({ CATAPULT: 20 });
    expect(swords).toBe(3000);
    expect(catapults).toBe(1200);

    const tower = maxHpOf("TOWER", 1); // 1200
    expect(wavesToDestroy(tower, catapults)).toBe(1);
    // 劍士也不是拆不動，只是要付一整支部隊的行程 —— 3000 人一波剛好
    expect(wavesToDestroy(tower, structureDamage({ SWORDSMAN: 400 }))).toBe(3);
  });

  it("器械的傷害與它的戰場攻擊力無關 —— 建物不是「防禦力很高的部隊」", () => {
    // 攻城車 40／台、投石機 60／台，寫死在 STRUCTURE_DAMAGE
    expect(structureDamage({ RAM: 10 })).toBe(400);
    expect(structureDamage({ CATAPULT: 10 })).toBe(600);
    // 混編：一般部隊那部分仍然是 1 點／人
    expect(structureDamage({ RAM: 10, SWORDSMAN: 100 })).toBe(500);
  });

  it("工坊加成作用在拆建物上（否則玩家會覺得工坊升了沒感覺）", () => {
    expect(structureDamage({ CATAPULT: 10 }, { siegeBonus: 0.4 })).toBe(840);
    // 但不會放大一般部隊那一份
    expect(structureDamage({ SWORDSMAN: 100 }, { siegeBonus: 0.4 })).toBe(100);
  });

  it("hasSiegeEngine 認得出「沒帶器械」", () => {
    expect(hasSiegeEngine({ SWORDSMAN: 999 })).toBe(false);
    expect(hasSiegeEngine({ SWORDSMAN: 999, RAM: 1 })).toBe(true);
  });
});

describe("建物自我修復", () => {
  it("沒被打過就是滿血", () => {
    expect(currentHp("TOWER", 1, { hp: null, hitAt: null }, 1_000)).toBe(1200);
  });

  it("★ 零星騷擾追不上修復，持續施壓才有效", () => {
    const t0 = 1_000_000_000;
    const dented = { hp: 200, hitAt: t0 };
    // 一小時後回 50 點
    expect(currentHp("TOWER", 1, dented, t0 + 3_600_000)).toBe(200 + STRUCTURE_REPAIR.hpPerHour);
    // 一天後早就回滿（不會超過上限）
    expect(currentHp("TOWER", 1, dented, t0 + 86_400_000)).toBe(1200);
  });

  it("時間回頭也不會倒扣（時鐘一律由呼叫端傳入）", () => {
    const t0 = 1_000_000_000;
    expect(currentHp("FLAG", 0, { hp: 100, hitAt: t0 }, t0 - 999_999)).toBe(100);
  });
});

describe("要塞路網", () => {
  const net = {
    citadel: { x: 100, y: 100 },
    fortresses: [
      { x: 200, y: 100 },
      { x: 260, y: 100 },
    ],
  };

  it("主城 8 格內（切比雪夫）都算在網上", () => {
    expect(onNetwork({ x: 108, y: 108 }, net)).toBe(true);
    expect(onNetwork({ x: 109, y: 100 }, net)).toBe(false);
    expect(ROAD.citadelRadius).toBe(8);
  });

  it("要塞是點節點 —— 就是它那一格", () => {
    expect(onNetwork({ x: 200, y: 100 }, net)).toBe(true);
    expect(onNetwork({ x: 201, y: 100 }, net)).toBe(false);
  });

  it("★ 兩端都在網上才加速 —— 否則那不是驛道，是全域加速", () => {
    // 要塞 → 要塞
    expect(roadMultiplier({ x: 200, y: 100 }, { x: 260, y: 100 }, net)).toBe(4);
    // 主城圈內 → 主城圈內
    expect(roadMultiplier({ x: 96, y: 96 }, { x: 104, y: 103 }, net)).toBe(4);
    // 要塞 → 主城圈（同一張網，接得起來）
    expect(roadMultiplier({ x: 200, y: 100 }, { x: 100, y: 100 }, net)).toBe(4);
    // 只有一端在網上 → 不加速
    expect(roadMultiplier({ x: 200, y: 100 }, { x: 400, y: 400 }, net)).toBe(1);
    expect(roadMultiplier({ x: 400, y: 400 }, { x: 100, y: 100 }, net)).toBe(1);
    // 沒有路網
    expect(roadMultiplier({ x: 200, y: 100 }, { x: 260, y: 100 }, null)).toBe(1);
  });

  it("行軍時間真的變成四分之一", () => {
    const army = { SWORDSMAN: 100 };
    const plain = marchTime({ from: { x: 200, y: 100 }, to: { x: 260, y: 100 }, army });
    const roaded = marchTime({
      from: { x: 200, y: 100 },
      to: { x: 260, y: 100 },
      army,
      roadMultiplier: roadMultiplier({ x: 200, y: 100 }, { x: 260, y: 100 }, net),
    });
    expect(roaded.roadMultiplier).toBe(4);
    expect(roaded.seconds).toBeCloseTo(plain.seconds / 4, 5);
    expect(plain.roadMultiplier).toBe(1);
  });
});
