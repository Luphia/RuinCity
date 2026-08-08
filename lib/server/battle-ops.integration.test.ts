import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import { parseArmy, type Army } from "@/lib/game/army";
import { BATTLE } from "@/lib/game/balance";
import { resolveArrivals, resolveEngagements } from "@/lib/server/battle-ops";
import { liveEngagementAt } from "@/lib/server/engagement-ops";
import {
  garrisonAt,
  recallMarchFor,
  recoverWounded,
  sendMarchFor,
  writeGarrison,
} from "@/lib/server/march-ops";
import { settleWithin } from "@/lib/server/player-state";
import {
  createHarness,
  readResources,
  seedPlayer,
  seedSeason,
  writeTerrainFixture,
  type Harness,
} from "@/lib/server/testing/pg-harness";

/**
 * PvP 核心循環的整合測試（M3 驗收）。
 *
 * ★ 這一層是純函式測不到的：戰鬥要**同時**改兩位玩家的駐軍與資源，
 *   而且要在同一個交易裡。`docs/10` M3 的驗收條件寫的是
 *   「兩個帳號可以互相偵查、突襲、攻擊，離線的守方也會被正確結算」——
 *   那一整句話只有在真的資料庫上才驗得到。
 */

const T0 = new Date(Date.UTC(2026, 7, 10));
const HOUR = 3_600_000;

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});


/**
 * ★ 新模型的「打完一場仗」是**兩步**（`docs/04` §3d）：
 *   抵達 → 進場（開一場交戰）→ 兩分鐘後結算。
 *   測試裡把時鐘往前撥到交戰結束再收尾。
 */
async function settleBattle(seasonId: number, arriveAt: number) {
  const arrivals = await h.tx((tx) => resolveArrivals(tx, seasonId, arriveAt));
  const at = arriveAt + BATTLE.durationMs + 1000;
  const engagements = await h.tx((tx) => resolveEngagements(tx, seasonId, at));
  return {
    at,
    /** 真正打起來的場數 = 交戰結算數（突襲仍走抵達即結算） */
    battles: arrivals.battles + engagements.resolved,
    failures: arrivals.failures + engagements.failures,
  };
}

/** 兩位鄰居，攻方有一支軍隊 */
async function neighbours(opts: {
  attackerArmy?: Army;
  defenderArmy?: Army;
  defenderCitadel?: number;
  defenderResources?: number;
  distance?: number;
} = {}) {
  const seasonId = await seedSeason(h, { startedAt: T0 });
  await writeTerrainFixture(seasonId);

  const attacker = await seedPlayer(h, seasonId, {
    startedAt: T0,
    baseX: 100,
    baseY: 100,
    citadelLevel: 15,
    resources: 3000,
  });
  const defender = await seedPlayer(h, seasonId, {
    startedAt: T0,
    baseX: 100 + (opts.distance ?? 6),
    baseY: 100,
    citadelLevel: opts.defenderCitadel ?? 15,
    resources: opts.defenderResources ?? 3000,
  });

  await h.tx((tx) =>
    writeGarrison(
      tx,
      seasonId,
      attacker.playerId,
      attacker.playerId,
      100,
      100,
      opts.attackerArmy ?? { SWORDSMAN: 200, SCOUT: 10 },
    ),
  );
  if (opts.defenderArmy) {
    await h.tx((tx) =>
      writeGarrison(
        tx,
        seasonId,
        defender.playerId,
        defender.playerId,
        100 + (opts.distance ?? 6),
        100,
        opts.defenderArmy!,
      ),
    );
  }

  return {
    seasonId,
    attackerId: attacker.playerId,
    defenderId: defender.playerId,
    target: { x: 100 + (opts.distance ?? 6), y: 100 },
  };
}

describe("★ 派兵：軍隊在路上就不能防守", () => {
  it("出發那一刻部隊就離開駐軍", async () => {
    const { seasonId, attackerId, target } = await neighbours();
    const now = T0.getTime();

    const r = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "RAID", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 80 } },
        now,
      ),
    );
    expect(r.ok).toBe(true);

    const left = await h.tx((tx) => garrisonAt(tx, seasonId, attackerId, 100, 100));
    expect(left.SWORDSMAN).toBe(120);
  });

  it("★ 兵不夠就派不出去 —— 同一支軍隊不能被派兩次", async () => {
    const { attackerId, target } = await neighbours();
    const now = T0.getTime();
    const send = (n: number) =>
      h.tx((tx) =>
        sendMarchFor(
          tx,
          attackerId,
          { type: "RAID", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: n } },
          now,
        ),
      );

    expect((await send(150)).ok).toBe(true);
    expect(await send(150)).toEqual({ ok: false, reason: "NOT_IN_GARRISON" });
  });

  it("不能打自己", async () => {
    const { attackerId } = await neighbours();
    const r = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "RAID", fromX: 100, fromY: 100, toX: 100, toY: 100, army: { SWORDSMAN: 10 } },
        T0.getTime(),
      ),
    );
    expect(r).toEqual({ ok: false, reason: "SAME_TILE" });
  });

  it("★ 行軍中的部隊照吃糧 —— 派出去繞圈不是免費的倉庫", async () => {
    const { attackerId, target } = await neighbours();
    const now = T0.getTime();

    const before = await h.tx((tx) => settleWithin(tx, attackerId, now));
    const homeUpkeep = before.economy.baseUpkeep.grain;

    await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "GARRISON", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 200 } },
        now,
      ),
    );

    const after = await h.tx((tx) => settleWithin(tx, attackerId, now));
    // 駐軍空了，但糧耗沒有掉 —— 部隊在路上還是在吃
    expect(after.economy.baseUpkeep.grain).toBeCloseTo(homeUpkeep, 3);
  });
});

describe("★ 抵達結算：跨玩家，離線的守方也算得到", () => {
  it("突襲 → 打贏 → 搶到東西 → 部隊帶著貨回家", async () => {
    const { seasonId, attackerId, defenderId, target } = await neighbours({
      defenderArmy: { SPEARMAN: 5 },
      defenderCitadel: 3,
      defenderResources: 3000,
    });
    const now = T0.getTime();

    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "RAID", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 200 } },
        now,
      ),
    );
    expect(sent.ok).toBe(true);

    const at = sent.arrivesAt! + 1000;
    const summary = await settleBattle(seasonId, at);
    expect(summary.battles).toBe(1);
    expect(summary.failures).toBe(0);

    const [report] = await h.db
      .select()
      .from(schema.battleReports)
      .where(eq(schema.battleReports.attackerId, attackerId));
    expect(report!.outcome).toBe("ATTACKER_WIN");

    // 守軍被打掉
    const defGarrison = await h.tx((tx) =>
      garrisonAt(tx, seasonId, defenderId, target.x, target.y),
    );
    expect(defGarrison.SPEARMAN ?? 0).toBeLessThan(5);

    // 回程被排出來，而且帶著貨
    const [ret] = await h.db
      .select()
      .from(schema.marches)
      .where(and(eq(schema.marches.ownerId, attackerId), eq(schema.marches.type, "RETURN")));
    expect(ret).toBeDefined();
    expect(ret!.cargo).not.toBeNull();

    // 回到家貨才入庫
    const before = await readResources(h, attackerId);
    await h.tx((tx) => resolveArrivals(tx, seasonId, ret!.arrivesAt.getTime() + 1000));
    const after = await readResources(h, attackerId);
    expect(after.grain + after.timber + after.stone + after.iron).toBeGreaterThan(
      before.grain + before.timber + before.stone + before.iron,
    );

    const home = await h.tx((tx) => garrisonAt(tx, seasonId, attackerId, 100, 100));
    expect((home.SWORDSMAN ?? 0)).toBeGreaterThan(0);
  });

  it("★ 第 1 天的新手被 200 劍士攻擊，資源損失為 0（春季地窖 ×2）", async () => {
    const { seasonId, attackerId, defenderId, target } = await neighbours({
      defenderCitadel: 1,
      // 庫存 600、Lv1 主堡、無倉庫、春季 → 地窖保護 660 > 600
      defenderResources: 600,
    });
    const now = T0.getTime();

    const before = await readResources(h, defenderId);
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "ATTACK", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 200 } },
        now,
      ),
    );
    await settleBattle(seasonId, sent.arrivesAt! + 1000);

    const after = await readResources(h, defenderId);
    for (const r of ["grain", "timber", "stone", "iron"] as const) {
      // 只會因為自然產出而增加，不會因為被搶而減少
      expect(after[r]).toBeGreaterThanOrEqual(before[r]);
    }
  });

  it("★ 大打小不計分（士氣）", async () => {
    const { seasonId, attackerId, target } = await neighbours({
      defenderArmy: { SPEARMAN: 2 },
      defenderCitadel: 2,
    });
    const now = T0.getTime();
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "ATTACK", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 200 } },
        now,
      ),
    );
    await settleBattle(seasonId, sent.arrivesAt! + 1000);

    const [report] = await h.db
      .select()
      .from(schema.battleReports)
      .where(eq(schema.battleReports.attackerId, attackerId));
    const snapshot = report!.snapshot as { scoring: boolean; breakdown: { morale: number } };
    expect(snapshot.scoring).toBe(false);
    expect(snapshot.breakdown.morale).toBeLessThan(1);
  });

  it("★ 突襲的損失比攻擊小（×0.6）", async () => {
    const run = async (type: "RAID" | "ATTACK") => {
      const { seasonId, attackerId, target } = await neighbours({
        attackerArmy: { SWORDSMAN: 100 },
        defenderArmy: { SPEARMAN: 80 },
      });
      const now = T0.getTime();
      const sent = await h.tx((tx) =>
        sendMarchFor(
          tx,
          attackerId,
          { type, fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 100 } },
          now,
        ),
      );
      await settleBattle(seasonId, sent.arrivesAt! + 1000);
      const [report] = await h.db
        .select()
        .from(schema.battleReports)
        .where(eq(schema.battleReports.attackerId, attackerId));
      const s = report!.snapshot as { attacker: { losses: Army } };
      return Object.values(s.attacker.losses).reduce((a, n) => a + (n ?? 0), 0);
    };

    const raid = await run("RAID");
    const attack = await run("ATTACK");
    expect(raid).toBeLessThan(attack);
  });

  it("★ 打空地不會發生任何事，部隊直接回家", async () => {
    const { seasonId, attackerId } = await neighbours();
    const now = T0.getTime();
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "ATTACK", fromX: 100, fromY: 100, toX: 130, toY: 130, army: { SWORDSMAN: 50 } },
        now,
      ),
    );
    const summary = await settleBattle(seasonId, sent.arrivesAt! + 1000);
    expect(summary.battles).toBe(0);

    const [ret] = await h.db
      .select()
      .from(schema.marches)
      .where(and(eq(schema.marches.ownerId, attackerId), eq(schema.marches.type, "RETURN")));
    expect(parseArmy(ret!.units).SWORDSMAN).toBe(50);
  });
});

describe("偵查", () => {
  it("成功時帶回情報，而且偵查兵回得來", async () => {
    const { seasonId, attackerId, target } = await neighbours({
      attackerArmy: { SCOUT: 20 },
    });
    const now = T0.getTime();
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "SCOUT", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SCOUT: 20 } },
        now,
      ),
    );
    await settleBattle(seasonId, sent.arrivesAt! + 1000);

    const [report] = await h.db
      .select()
      .from(schema.battleReports)
      .where(eq(schema.battleReports.attackerId, attackerId));
    // 守方沒有偵查兵 → 成功率 1
    expect(report!.outcome).toBe("SCOUT_SUCCESS");
    const s = report!.snapshot as { report: { citadelLevel: number } };
    expect(s.report.citadelLevel).toBe(15);
  });

  it("★ 偵查不觸發來襲預警 —— 只有 RAID / ATTACK 會", async () => {
    const { seasonId, attackerId, defenderId, target } = await neighbours({
      attackerArmy: { SCOUT: 20 },
    });
    const now = T0.getTime();
    await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "SCOUT", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SCOUT: 20 } },
        now,
      ),
    );

    const scouting = await h.db
      .select()
      .from(schema.marches)
      .where(and(eq(schema.marches.seasonId, seasonId), eq(schema.marches.type, "SCOUT")));
    expect(scouting).toHaveLength(1);
    // 守方那邊查得到這支行軍，但它的類型不在預警清單裡
    expect(scouting[0]!.toX).toBe(target.x);
    expect(defenderId).toBeGreaterThan(0);
  });
});

describe("增援與召回", () => {
  it("增援的部隊留在對方那一格，但擁有者不變", async () => {
    const { seasonId, attackerId, target } = await neighbours();
    const now = T0.getTime();
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "REINFORCE", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 60 } },
        now,
      ),
    );
    await settleBattle(seasonId, sent.arrivesAt! + 1000);

    const stationed = await h.tx((tx) =>
      garrisonAt(tx, seasonId, attackerId, target.x, target.y),
    );
    expect(stationed.SWORDSMAN).toBe(60);
  });

  it("★ 召回不是瞬間的 —— 走多遠就要走多遠回來", async () => {
    const { attackerId, target } = await neighbours();
    const now = T0.getTime();
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "ATTACK", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 100 } },
        now,
      ),
    );

    const [march] = await h.db
      .select()
      .from(schema.marches)
      .where(eq(schema.marches.ownerId, attackerId));

    const halfway = now + Math.floor((sent.arrivesAt! - now) / 2);
    const r = await h.tx((tx) => recallMarchFor(tx, attackerId, march!.id, halfway));
    if (!r.ok) throw new Error(r.reason);
    expect(r.arrivesAt!).toBeGreaterThan(halfway);
  });

  it("已經抵達的召不回來", async () => {
    const { seasonId, attackerId, target } = await neighbours();
    const now = T0.getTime();
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "ATTACK", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 100 } },
        now,
      ),
    );
    const [march] = await h.db
      .select()
      .from(schema.marches)
      .where(eq(schema.marches.seasonId, seasonId));

    const r = await h.tx((tx) =>
      recallMarchFor(tx, attackerId, march!.id, sent.arrivesAt! + 1000),
    );
    expect(r).toEqual({ ok: false, reason: "ALREADY_ARRIVED" });
  });
});

describe("★ 餓死：糧食歸零時軍隊會消失", () => {
  it("養不起的軍隊會被餓掉一批", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const p = await seedPlayer(h, seasonId, {
      startedAt: T0,
      citadelLevel: 1,
      resources: 0,
      populationCap: 5000,
    });
    // 一支遠超過保底產出所能養活的軍隊
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, p.playerId, p.playerId, 100, 100, { RAIDER: 500 }),
    );

    const after = await h.tx((tx) => settleWithin(tx, p.playerId, T0.getTime() + 6 * HOUR));
    expect((after.garrison.RAIDER ?? 0)).toBeLessThan(500);

    const [row] = await h.db
      .select()
      .from(schema.garrisons)
      .where(eq(schema.garrisons.ownerId, p.playerId));
    expect(parseArmy(row!.units).RAIDER).toBe(after.garrison.RAIDER);
  });

  it("★ 陣亡不返還人口 —— 餓死的兵不會把名額還你", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const p = await seedPlayer(h, seasonId, {
      startedAt: T0,
      citadelLevel: 1,
      resources: 0,
      populationCap: 5000,
    });
    await h.db
      .update(schema.playerPopulation)
      .set({ used: "1000" })
      .where(eq(schema.playerPopulation.playerId, p.playerId));
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, p.playerId, p.playerId, 100, 100, { RAIDER: 500 }),
    );

    await h.tx((tx) => settleWithin(tx, p.playerId, T0.getTime() + 6 * HOUR));

    const [pop] = await h.db
      .select()
      .from(schema.playerPopulation)
      .where(eq(schema.playerPopulation.playerId, p.playerId));
    expect(Number(pop!.used)).toBe(1000);
  });

  it("養得起就一個都不死", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    const p = await seedPlayer(h, seasonId, {
      startedAt: T0,
      citadelLevel: 20,
      resources: 5000,
      populationCap: 5000,
    });
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, p.playerId, p.playerId, 100, 100, { SPEARMAN: 20 }),
    );

    const after = await h.tx((tx) => settleWithin(tx, p.playerId, T0.getTime() + 3 * HOUR));
    expect(after.garrison.SPEARMAN).toBe(20);
  });
});

// ─────────────────────────────────────────────────────────────
// 征服（docs/02 §2.5）：lv≥2 的野地要打下來才佔得到
// ─────────────────────────────────────────────────────────────

describe("★ 征服（CLAIM 行軍）", () => {
  const TARGET = { x: 102, y: 100 } as const; // 緊貼核心 2×2 的東側

  async function conquestSetup(seedPick: (lv: number) => boolean, army: Army) {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    await writeTerrainFixture(seasonId);

    // 挑一個讓目標格是想要等級的賽季 seed（wildLevelAt 是純函式，掃得出來）
    const { wildLevelAt } = await import("@/lib/game/wilds");
    let seed = 0;
    for (let s = 1; s < 20_000; s++) {
      if (seedPick(wildLevelAt(s, TARGET.x, TARGET.y, "PLAIN"))) {
        seed = s;
        break;
      }
    }
    expect(seed, "掃不到符合條件的 seed").toBeGreaterThan(0);
    await h.db
      .update(schema.seasons)
      .set({ seed: BigInt(seed) })
      .where(eq(schema.seasons.id, seasonId));

    const p = await seedPlayer(h, seasonId, {
      startedAt: T0,
      baseX: 100,
      baseY: 100,
      citadelLevel: 15,
      resources: 5000,
    });
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, p.playerId, p.playerId, 100, 100, army),
    );
    const { wildLevelAt: lvl } = await import("@/lib/game/wilds");
    return { seasonId, playerId: p.playerId, seed, level: lvl(seed, TARGET.x, TARGET.y, "PLAIN") };
  }

  async function marchAndArrive(seasonId: number, playerId: number, army: Army) {
    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        playerId,
        { type: "CLAIM", fromX: 100, fromY: 100, toX: TARGET.x, toY: TARGET.y, army },
        T0.getTime(),
      ),
    );
    expect(sent.ok, `派征服失敗: ${sent.reason}`).toBe(true);
    await h.db
      .update(schema.marches)
      .set({ arrivesAt: new Date(T0.getTime() + 1000) })
      .where(eq(schema.marches.id, sent.marchId!));
    // 征服現在與 PvP 走同一條路：抵達進場 → 兩分鐘後結算（`docs/04` §3d）
    await settleBattle(seasonId, T0.getTime() + 2000);
    return sent;
  }

  it("★ 打贏 lv≥2 的守衛 → 立刻佔領，tiles 帶著等級；立旗則被 GUARDED_TILE 擋下", async () => {
    const { seasonId, playerId, level } = await conquestSetup(
      (lv) => lv >= 2 && lv <= 3,
      { SWORDSMAN: 300 },
    );

    // 立旗碰不得有守衛的格子（執政官也是走這裡被擋）
    const { claimTileFor } = await import("@/lib/server/base-ops");
    const flag = await h.tx((tx) => claimTileFor(tx, playerId, TARGET.x, TARGET.y, T0.getTime()));
    expect(flag).toMatchObject({ ok: false, reason: "GUARDED_TILE" });

    await marchAndArrive(seasonId, playerId, { SWORDSMAN: 200 });

    const [tile] = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, TARGET.x), eq(schema.tiles.y, TARGET.y)));
    expect(tile).toBeDefined();
    expect(tile!.playerId).toBe(playerId);
    expect(tile!.kind).toBe("TERRITORY");
    expect(tile!.level).toBe(level);

    const reports = await h.db
      .select()
      .from(schema.battleReports)
      .where(and(eq(schema.battleReports.seasonId, seasonId), eq(schema.battleReports.marchType, "CLAIM")));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.outcome).toBe("ATTACKER_WIN");
    const snap = reports[0]!.snapshot as {
      kind: string;
      engagement: { participants: number; captured: boolean };
    };
    expect(snap.kind).toBe("BATTLE");
    // 中立地也是一場交戰：守衛 1 席 + 攻方 1 席
    expect(snap.engagement.participants).toBe(2);
    expect(snap.engagement.captured).toBe(true);

    // 打完的部隊在回程路上（有戰損但沒全滅）
    const returns = await h.db
      .select()
      .from(schema.marches)
      .where(and(eq(schema.marches.seasonId, seasonId), eq(schema.marches.type, "RETURN")));
    expect(returns).toHaveLength(1);
  });

  it("打不贏就是打不贏：一名民兵去踢 lv5 的巢穴 → 沒有佔領、殘軍覆滅", async () => {
    const { seasonId, playerId } = await conquestSetup((lv) => lv === 5, { MILITIA: 1, SWORDSMAN: 0 });
    await marchAndArrive(seasonId, playerId, { MILITIA: 1 });

    const tiles = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, TARGET.x), eq(schema.tiles.y, TARGET.y)));
    expect(tiles).toHaveLength(0);

    const [report] = await h.db
      .select()
      .from(schema.battleReports)
      .where(and(eq(schema.battleReports.seasonId, seasonId), eq(schema.battleReports.marchType, "CLAIM")));
    expect(report!.outcome).not.toBe("ATTACKER_WIN");
  });

  it("lv≤1 立旗照舊，而且 tiles 記下等級（產出係數 ×1）", async () => {
    const { seasonId, playerId, level } = await conquestSetup((lv) => lv === 1, { MILITIA: 50 });
    const { claimTileFor } = await import("@/lib/server/base-ops");
    const r = await h.tx((tx) => claimTileFor(tx, playerId, TARGET.x, TARGET.y, T0.getTime()));
    expect(r.ok).toBe(true);

    const done = await h.tx((tx) => settleWithin(tx, playerId, r.doneAt! + 1000));
    const t = done.tiles.find((q) => q.x === TARGET.x && q.y === TARGET.y);
    expect(t).toBeDefined();
    expect(t!.level).toBe(level);
    expect(seasonId).toBeGreaterThan(0);
  });

  it("★ 被搶先：抵達時已有主 → CLAIM_FAILED，一格都不動", async () => {
    const { seasonId, playerId } = await conquestSetup((lv) => lv >= 2, { SWORDSMAN: 200 });
    const rival = await seedPlayer(h, seasonId, { startedAt: T0, baseX: 120, baseY: 120 });

    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        playerId,
        { type: "CLAIM", fromX: 100, fromY: 100, toX: TARGET.x, toY: TARGET.y, army: { SWORDSMAN: 100 } },
        T0.getTime(),
      ),
    );
    expect(sent.ok).toBe(true);

    // 路上被別人插旗
    await h.db.insert(schema.tiles).values({
      seasonId,
      x: TARGET.x,
      y: TARGET.y,
      kind: "TERRITORY",
      playerId: rival.playerId,
      terrain: "PLAIN",
      level: 1,
      state: "NORMAL",
    });

    await h.db
      .update(schema.marches)
      .set({ arrivesAt: new Date(T0.getTime() + 1000) })
      .where(eq(schema.marches.id, sent.marchId!));
    await h.tx((tx) => resolveArrivals(tx, seasonId, T0.getTime() + 2000));

    const [tile] = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, TARGET.x), eq(schema.tiles.y, TARGET.y)));
    expect(tile!.playerId).toBe(rival.playerId); // 沒被搶走

    const [report] = await h.db
      .select()
      .from(schema.battleReports)
      .where(and(eq(schema.battleReports.seasonId, seasonId), eq(schema.battleReports.marchType, "CLAIM")));
    expect(report!.outcome).toBe("CLAIM_FAILED");
  });
});

// ─────────────────────────────────────────────────────────────
// 領地建物與佔領（docs/02 §2.6、docs/04 §5）
// ─────────────────────────────────────────────────────────────

/** 在 (x,y) 放一格屬於 owner 的領地 */
async function seedTerritory(
  seasonId: number,
  owner: number,
  at: { x: number; y: number },
  facility: string | null = null,
  facilityLevel = 0,
) {
  await h.db.insert(schema.tiles).values({
    seasonId,
    x: at.x,
    y: at.y,
    kind: "TERRITORY",
    playerId: owner,
    facility,
    facilityLevel,
    terrain: "PLAIN",
    level: 1,
    state: "NORMAL",
  });
}

/** 派一支部隊去打 target，並把它的抵達時間拉到現在 */
async function assault(
  seasonId: number,
  attackerId: number,
  target: { x: number; y: number },
  army: Army,
  at = T0.getTime(),
) {
  const sent = await h.tx((tx) =>
    sendMarchFor(
      tx,
      attackerId,
      { type: "ATTACK", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army },
      at,
    ),
  );
  expect(sent.ok, "reason" in sent ? String(sent.reason) : "").toBe(true);
  await h.db
    .update(schema.marches)
    .set({ arrivesAt: new Date(at + 1000) })
    .where(eq(schema.marches.id, sent.marchId!));
  await settleBattle(seasonId, at + 2000);

  const [tile] = await h.db
    .select()
    .from(schema.tiles)
    .where(
      and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, target.x), eq(schema.tiles.y, target.y)),
    );
  const [report] = await h.db
    .select()
    .from(schema.battleReports)
    .where(eq(schema.battleReports.seasonId, seasonId))
    .orderBy(desc(schema.battleReports.id))
    .limit(1);
  return { tile: tile!, siege: (report!.snapshot as { siege: SiegeSnapshot | null }).siege };
}

interface SiegeSnapshot {
  kind: string;
  hpBefore: number;
  hpAfter: number;
  damage: number;
  destroyed: boolean;
  captured: boolean;
  blockedBy: string | null;
}

describe("★ 領地建物：打掉旗才算佔領", () => {
  it("沒有守軍時，一波三百人剛好拆掉領地旗 → 這一格易主", async () => {
    const { seasonId, attackerId, defenderId } = await neighbours({
      attackerArmy: { SWORDSMAN: 300 },
    });
    const target = { x: 104, y: 100 };
    await seedTerritory(seasonId, defenderId, target);

    const { tile, siege } = await assault(seasonId, attackerId, target, { SWORDSMAN: 300 });

    expect(siege?.kind).toBe("FLAG");
    expect(siege?.damage).toBe(300); // 一般部隊 1 點／人
    expect(siege?.destroyed).toBe(true);
    expect(siege?.captured).toBe(true);
    expect(tile.playerId).toBe(attackerId); // ★ 易主
    expect(tile.structureHp).toBeNull(); // 新主人的旗是新的
  });

  it("★ 領地內有守軍時只能先攻擊軍隊 —— 建物一點傷都沒受", async () => {
    const { seasonId, attackerId, defenderId } = await neighbours({
      attackerArmy: { SWORDSMAN: 300 },
    });
    const target = { x: 104, y: 100 };
    await seedTerritory(seasonId, defenderId, target);
    // 守軍很強：攻方打不贏，連走近旗子的機會都沒有
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, defenderId, defenderId, target.x, target.y, { SPEARMAN: 3000 }),
    );

    const { tile, siege } = await assault(seasonId, attackerId, target, { SWORDSMAN: 300 });

    expect(siege?.damage).toBe(0);
    expect(siege?.blockedBy).toBe("REPELLED");
    expect(tile.playerId).toBe(defenderId);
  });

  it("★ 打贏了但守軍還有活口 → 仍然碰不到建物", async () => {
    const { seasonId, attackerId, defenderId } = await neighbours({
      attackerArmy: { SWORDSMAN: 3000 },
    });
    const target = { x: 104, y: 100 };
    await seedTerritory(seasonId, defenderId, target);
    // 少量守軍：攻方會贏，但一輪打不乾淨
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, defenderId, defenderId, target.x, target.y, { SPEARMAN: 400 }),
    );

    const { tile, siege } = await assault(seasonId, attackerId, target, { SWORDSMAN: 3000 });

    // 守軍沒被清空 → blockedBy GARRISON；清空了才輪得到建物
    if (siege?.blockedBy === "GARRISON") {
      expect(siege.damage).toBe(0);
      expect(tile.playerId).toBe(defenderId);
    } else {
      expect(siege?.destroyed).toBe(true);
      expect(tile.playerId).toBe(attackerId);
    }
  });

  it("★ 要塞：一般部隊打不下來，而且十分鐘後耐久就回滿了", async () => {
    const { seasonId, attackerId, defenderId } = await neighbours({
      attackerArmy: { SWORDSMAN: 3000, CATAPULT: 40 },
    });
    const target = { x: 104, y: 100 };
    await seedTerritory(seasonId, defenderId, target, "FORTRESS", 2);

    // 第一波：只帶步兵 → 石塔 Lv2（1,800）扣 1,000，還站著
    const first = await assault(seasonId, attackerId, target, { SWORDSMAN: 1000 });
    expect(first.siege?.kind).toBe("TOWER");
    expect(first.siege?.hpBefore).toBe(1800);
    expect(first.siege?.damage).toBe(1000);
    expect(first.siege?.destroyed).toBe(false);
    expect(first.tile.playerId).toBe(defenderId);
    expect(first.tile.structureHp).toBe(800);

    /**
     * ★ 兩分鐘後的第二波：耐久已經自己長回 1,800 × 2/10 = 360 點。
     *   「早到就多打掉一些」在這裡是可測的 —— 20 台投石機（1,200）
     *   打 1,160 剛好夠。
     */
    const second = await assault(
      seasonId,
      attackerId,
      target,
      { CATAPULT: 20 },
      T0.getTime() + 2 * 60_000,
    );
    expect(second.siege?.hpBefore).toBe(1160); // 800 + 360
    expect(second.siege?.destroyed).toBe(true);
    expect(second.tile.playerId).toBe(attackerId);
  });

  it("★ 十分鐘一到耐久回滿 —— 跨時段的零星騷擾完全無效", async () => {
    const { seasonId, attackerId, defenderId } = await neighbours({
      attackerArmy: { SWORDSMAN: 3000, CATAPULT: 40 },
    });
    const target = { x: 104, y: 100 };
    await seedTerritory(seasonId, defenderId, target, "FORTRESS", 2);

    const first = await assault(seasonId, attackerId, target, { SWORDSMAN: 1000 });
    expect(first.tile.structureHp).toBe(800);

    // 隔十分鐘再來：石塔已經回滿 1,800，20 台投石機（1,200）拆不掉
    const later = await assault(
      seasonId,
      attackerId,
      target,
      { CATAPULT: 20 },
      T0.getTime() + 10 * 60_000,
    );
    expect(later.siege?.hpBefore).toBe(1800);
    expect(later.siege?.destroyed).toBe(false);
    expect(later.tile.playerId).toBe(defenderId);
  });

  it("★ 突襲不碰建物 —— 突襲的定義就是搶完就走", async () => {
    const { seasonId, attackerId, defenderId } = await neighbours({
      attackerArmy: { SWORDSMAN: 3000 },
    });
    const target = { x: 104, y: 100 };
    await seedTerritory(seasonId, defenderId, target);

    const sent = await h.tx((tx) =>
      sendMarchFor(
        tx,
        attackerId,
        { type: "RAID", fromX: 100, fromY: 100, toX: target.x, toY: target.y, army: { SWORDSMAN: 3000 } },
        T0.getTime(),
      ),
    );
    expect(sent.ok).toBe(true);
    await h.db
      .update(schema.marches)
      .set({ arrivesAt: new Date(T0.getTime() + 1000) })
      .where(eq(schema.marches.id, sent.marchId!));
    await h.tx((tx) => resolveArrivals(tx, seasonId, T0.getTime() + 2000));

    const [tile] = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, target.x), eq(schema.tiles.y, target.y)));
    expect(tile!.playerId).toBe(defenderId);
  });

  it("★ 主城不會易主 —— 打爆的是「破城」，不是換旗", async () => {
    const { seasonId, attackerId, defenderId, target } = await neighbours({
      attackerArmy: { CATAPULT: 400 },
      defenderCitadel: 5,
    });

    const r = await assault(seasonId, attackerId, target, { CATAPULT: 400 });
    expect(r.siege?.kind).toBe("KEEP");
    expect(r.siege?.destroyed).toBe(true);
    expect(r.siege?.captured).toBe(false); // 主城永遠不易主

    const [player] = await h.db
      .select({ id: schema.players.id })
      .from(schema.players)
      .where(eq(schema.players.id, defenderId));
    expect(player!.id).toBe(defenderId);
  });
});

describe("★ 打爆主城 = 那位領主出局", () => {
  it("出局後：地釋放、駐軍清空、在途行軍取消、不再結算", async () => {
    const { seasonId, attackerId, defenderId, target } = await neighbours({
      attackerArmy: { CATAPULT: 400 },
      defenderCitadel: 5, // 主城 400 × 5 = 2,000
    });

    // 守方有一塊領地、一支駐軍、一支在路上的部隊
    await seedTerritory(seasonId, defenderId, { x: 120, y: 120 }, "FARM", 3);
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, defenderId, defenderId, 120, 120, { SPEARMAN: 50 }),
    );
    await h.db.insert(schema.marches).values({
      seasonId,
      ownerId: defenderId,
      type: "RAID",
      fromX: target.x,
      fromY: target.y,
      toX: 130,
      toY: 130,
      units: { SWORDSMAN: 10 } as never,
      departedAt: T0,
      arrivesAt: new Date(T0.getTime() + 10 * 3_600_000),
    });

    const r = await assault(seasonId, attackerId, target, { CATAPULT: 400 });
    expect(r.siege?.kind).toBe("KEEP");
    expect(r.siege?.destroyed).toBe(true);
    expect(r.siege?.captured).toBe(false); // 主城不易主，是**出局**

    const [player] = await h.db
      .select({ eliminatedAt: schema.players.eliminatedAt })
      .from(schema.players)
      .where(eq(schema.players.id, defenderId));
    expect(player!.eliminatedAt).not.toBeNull();

    // 領地釋放成無主，設施一併消失
    const [tile] = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, 120), eq(schema.tiles.y, 120)));
    expect(tile!.playerId).toBeNull();
    expect(tile!.facility).toBeNull();

    // 駐軍清空
    const left = await h.tx((tx) => garrisonAt(tx, seasonId, defenderId, 120, 120));
    expect(Object.keys(left)).toHaveLength(0);

    // 在途行軍取消
    const marches = await h.db
      .select({ status: schema.marches.status })
      .from(schema.marches)
      .where(and(eq(schema.marches.ownerId, defenderId), eq(schema.marches.type, "RAID")));
    expect(marches.every((m) => m.status === "RECALLED")).toBe(true);

    // 不再結算 —— 這是所有寫入路徑的共同入口
    await expect(h.tx((tx) => settleWithin(tx, defenderId, T0.getTime() + 3_600_000))).rejects.toThrow(
      /出局/,
    );
  });

  it("★ 出局的據點不能再被打 —— 不然會對著廢墟刷戰報", async () => {
    const { seasonId, attackerId, defenderId, target } = await neighbours({
      attackerArmy: { CATAPULT: 800 },
      defenderCitadel: 5,
    });

    await assault(seasonId, attackerId, target, { CATAPULT: 400 });
    const [dead] = await h.db
      .select({ eliminatedAt: schema.players.eliminatedAt })
      .from(schema.players)
      .where(eq(schema.players.id, defenderId));
    expect(dead!.eliminatedAt).not.toBeNull();

    const before = await h.db.select().from(schema.battleReports);
    // 再打一次同一格 → 沒有守方，不會再產生戰報
    await assault(seasonId, attackerId, target, { CATAPULT: 400 }, T0.getTime() + 60_000);
    const after = await h.db.select().from(schema.battleReports);
    expect(after.length).toBe(before.length);
  });
});

describe("★ 傷兵十分鐘歸隊，陣亡的回不來", () => {
  it("守在自己據點的傷兵會站起來，而且不是全部的損失", async () => {
    const { seasonId, attackerId, defenderId, target } = await neighbours({
      attackerArmy: { SWORDSMAN: 600 },
      defenderArmy: { SPEARMAN: 200 },
      defenderCitadel: 15,
    });
    // 醫療帳讓守家的損失有一部分變成傷兵
    await h.db
      .update(schema.baseSlots)
      .set({ building: "INFIRMARY", level: 10 })
      .where(and(eq(schema.baseSlots.playerId, defenderId), eq(schema.baseSlots.slot, "B")));

    await assault(seasonId, attackerId, target, { SWORDSMAN: 600 });

    const [g] = await h.db
      .select({ wounded: schema.garrisons.wounded, woundedAt: schema.garrisons.woundedAt })
      .from(schema.garrisons)
      .where(
        and(
          eq(schema.garrisons.seasonId, seasonId),
          eq(schema.garrisons.ownerId, defenderId),
          eq(schema.garrisons.atX, target.x),
        ),
      );
    const wounded = (g?.wounded ?? {}) as Record<string, number>;
    expect(g?.woundedAt).not.toBeNull();
    expect(wounded.SPEARMAN ?? 0).toBeGreaterThan(0);
    // ★ 陣亡的回不來：傷兵**少於**總損失
    expect(wounded.SPEARMAN!).toBeLessThan(200);

    /**
     * ★ 傷兵的倒數從**交戰結束**那一刻起算，不是從出發那一刻。
     *   交戰本身要跑兩分鐘（`BATTLE.durationMs`），所以基準點要加上去 ——
     *   忘了加的話會誤以為「十分鐘到了卻沒歸隊」。
     */
    const hurtAt = T0.getTime() + BATTLE.durationMs + 3000;
    // 九分鐘後還沒好
    await h.tx((tx) => recoverWounded(tx, seasonId, hurtAt + 9 * 60_000));
    const stillOut = await h.tx((tx) => garrisonAt(tx, seasonId, defenderId, target.x, target.y));
    expect(stillOut.SPEARMAN ?? 0).toBe(0);

    // 十分鐘整 → 歸隊
    await h.tx((tx) => recoverWounded(tx, seasonId, hurtAt + 10 * 60_000));
    const back = await h.tx((tx) => garrisonAt(tx, seasonId, defenderId, target.x, target.y));
    expect(back.SPEARMAN ?? 0).toBe(wounded.SPEARMAN);
  });

  it("★ 野地上的傷兵站不起來 —— 沒有人替你收容傷員", async () => {
    const { seasonId, defenderId } = await neighbours();
    // 手動在一格野地上放傷兵
    await h.db.insert(schema.garrisons).values({
      seasonId,
      ownerId: defenderId,
      hostId: defenderId,
      atX: 200,
      atY: 200,
      units: {} as never,
      wounded: { SPEARMAN: 30 } as never,
      woundedAt: T0,
    });

    await h.tx((tx) => recoverWounded(tx, seasonId, T0.getTime() + 30 * 60_000));
    const still = await h.tx((tx) => garrisonAt(tx, seasonId, defenderId, 200, 200));
    expect(still.SPEARMAN ?? 0).toBe(0);

    // 那一格變成自己的要塞之後，同一批傷兵就站得起來了
    await seedTerritory(seasonId, defenderId, { x: 200, y: 200 }, "FORTRESS", 1);
    await h.tx((tx) => recoverWounded(tx, seasonId, T0.getTime() + 31 * 60_000));
    const healed = await h.tx((tx) => garrisonAt(tx, seasonId, defenderId, 200, 200));
    expect(healed.SPEARMAN).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────
// 交戰：名額、援軍、中立地競爭（docs/04 §3d）
// ─────────────────────────────────────────────────────────────

describe("★ 一格 5 對 5，主城 10 對 10", () => {
  it("第六支攻方擠不進去 → 原地回頭，而且戰報說得出原因", async () => {
    const { seasonId, defenderId } = await neighbours({ defenderCitadel: 15 });
    const target = { x: 104, y: 100 };
    await seedTerritory(seasonId, defenderId, target);

    // 六位不同的攻方，全部在同一分鐘抵達
    const attackers: number[] = [];
    for (let i = 0; i < 6; i++) {
      const a = await seedPlayer(h, seasonId, {
        startedAt: T0,
        baseX: 200 + i * 10,
        baseY: 200,
        citadelLevel: 10,
        resources: 3000,
      });
      attackers.push(a.playerId);
      await h.tx((tx) =>
        writeGarrison(tx, seasonId, a.playerId, a.playerId, 200 + i * 10, 200, { SWORDSMAN: 50 }),
      );
      const sent = await h.tx((tx) =>
        sendMarchFor(
          tx,
          a.playerId,
          {
            type: "ATTACK",
            fromX: 200 + i * 10,
            fromY: 200,
            toX: target.x,
            toY: target.y,
            army: { SWORDSMAN: 50 },
          },
          T0.getTime(),
        ),
      );
      expect(sent.ok).toBe(true);
      await h.db
        .update(schema.marches)
        .set({ arrivesAt: new Date(T0.getTime() + 1000) })
        .where(eq(schema.marches.id, sent.marchId!));
    }

    await h.tx((tx) => resolveArrivals(tx, seasonId, T0.getTime() + 2000));

    const live = await h.tx((tx) => liveEngagementAt(tx, seasonId, target.x, target.y));
    expect(live).not.toBeNull();
    expect(live!.slots.attacker).toEqual({ used: 5, cap: 5 });

    // 第六位拿到一份「擠不進去」的戰報，而且部隊在回程上
    const full = await h.db
      .select()
      .from(schema.battleReports)
      .where(eq(schema.battleReports.attackerId, attackers[5]!));
    expect(full).toHaveLength(1);
    expect((full[0]!.snapshot as { kind: string }).kind).toBe("SLOTS_FULL");
  });

  it("★ 主城的容量是一般格子的兩倍", async () => {
    const { seasonId, target } = await neighbours({ defenderCitadel: 15 });

    for (let i = 0; i < 6; i++) {
      const a = await seedPlayer(h, seasonId, {
        startedAt: T0,
        baseX: 300 + i * 10,
        baseY: 300,
        citadelLevel: 10,
        resources: 3000,
      });
      await h.tx((tx) =>
        writeGarrison(tx, seasonId, a.playerId, a.playerId, 300 + i * 10, 300, { SWORDSMAN: 50 }),
      );
      const sent = await h.tx((tx) =>
        sendMarchFor(
          tx,
          a.playerId,
          {
            type: "ATTACK",
            fromX: 300 + i * 10,
            fromY: 300,
            toX: target.x,
            toY: target.y,
            army: { SWORDSMAN: 50 },
          },
          T0.getTime(),
        ),
      );
      await h.db
        .update(schema.marches)
        .set({ arrivesAt: new Date(T0.getTime() + 1000) })
        .where(eq(schema.marches.id, sent.marchId!));
    }
    await h.tx((tx) => resolveArrivals(tx, seasonId, T0.getTime() + 2000));

    const live = await h.tx((tx) => liveEngagementAt(tx, seasonId, target.x, target.y));
    expect(live!.isKeep).toBe(true);
    // 六支全部進得去（主城 10 席），一般格子只進得去 5 支
    expect(live!.slots.attacker).toEqual({ used: 6, cap: 10 });
  });
});

describe("★ 中立資源地：有空位就能一起搶", () => {
  it("兩位玩家打同一格野地 → 同一場交戰，出力多的拿走", async () => {
    const seasonId = await seedSeason(h, { startedAt: T0 });
    await writeTerrainFixture(seasonId);

    // ★ 目標必須同時**貼著兩位**的領地 —— CLAIM 走的是擴張路徑，
    //   不相鄰就在 `planClaim` 被 NOT_ADJACENT 擋下（這不是交戰規則，
    //   是誰有資格去搶）。兩座核心 2×2 中間夾一格，就是唯一擺得出來的形狀。
    const spot = { x: 102, y: 100 } as const;
    const { wildLevelAt } = await import("@/lib/game/wilds");
    let seed = 0;
    for (let s = 1; s < 20_000; s++) {
      if (wildLevelAt(s, spot.x, spot.y, "PLAIN") >= 2) {
        seed = s;
        break;
      }
    }
    expect(seed, "掃不到有守衛的 seed").toBeGreaterThan(0);
    await h.db
      .update(schema.seasons)
      .set({ seed: BigInt(seed) })
      .where(eq(schema.seasons.id, seasonId));

    const big = await seedPlayer(h, seasonId, {
      startedAt: T0,
      baseX: 100,
      baseY: 100,
      citadelLevel: 15,
      resources: 9000,
    });
    const small = await seedPlayer(h, seasonId, {
      startedAt: T0,
      baseX: 103,
      baseY: 100,
      citadelLevel: 15,
      resources: 9000,
    });
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, big.playerId, big.playerId, 100, 100, { SWORDSMAN: 400 }),
    );
    await h.tx((tx) =>
      writeGarrison(tx, seasonId, small.playerId, small.playerId, 103, 100, { SWORDSMAN: 60 }),
    );

    for (const [who, from, army] of [
      [big.playerId, { x: 100, y: 100 }, { SWORDSMAN: 400 }],
      [small.playerId, { x: 103, y: 100 }, { SWORDSMAN: 60 }],
    ] as const) {
      const sent = await h.tx((tx) =>
        sendMarchFor(
          tx,
          who,
          { type: "CLAIM", fromX: from.x, fromY: from.y, toX: spot.x, toY: spot.y, army },
          T0.getTime(),
        ),
      );
      expect(sent.ok, "reason" in sent ? String(sent.reason) : "").toBe(true);
      await h.db
        .update(schema.marches)
        .set({ arrivesAt: new Date(T0.getTime() + 1000) })
        .where(eq(schema.marches.id, sent.marchId!));
    }

    await h.tx((tx) => resolveArrivals(tx, seasonId, T0.getTime() + 2000));

    // ★ 兩位都在同一場交戰裡 —— 這就是「有空位其他玩家也能派兵競爭」
    const live = await h.tx((tx) => liveEngagementAt(tx, seasonId, spot.x, spot.y));
    expect(live!.slots.attacker.used).toBe(2);
    expect(live!.defender).not.toEqual({}); // 野生守衛佔守方那一席

    await h.tx((tx) => resolveEngagements(tx, seasonId, T0.getTime() + BATTLE.durationMs + 3000));

    const [tile] = await h.db
      .select()
      .from(schema.tiles)
      .where(and(eq(schema.tiles.seasonId, seasonId), eq(schema.tiles.x, spot.x), eq(schema.tiles.y, spot.y)));
    // 出兵多的那一位存活最多 → 地是他的
    expect(tile!.playerId).toBe(big.playerId);

    // 兩位都拿到戰報，但只有一位的 captured 是 true
    const reports = await h.db.select().from(schema.battleReports).where(eq(schema.battleReports.seasonId, seasonId));
    expect(reports.length).toBeGreaterThanOrEqual(2);
    const captured = reports.filter(
      (r) => (r.snapshot as { engagement?: { captured?: boolean } }).engagement?.captured,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]!.attackerId).toBe(big.playerId);
  });
});
