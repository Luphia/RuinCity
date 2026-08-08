import "server-only";

/**
 * 賽季的建立、登記、封盤與開賽。
 *
 * ## ★ 封盤期是這整個系統的重點
 *
 * 12 小時裡要做完：AI 補足至 600 → 地圖生成 → 出生點批次分配 →
 * 五項公平性驗證（不過就換 seed 重跑）→ 公布預覽。
 *
 * 實測單次約 7 秒、平均 18 秒（`docs/13` §3），所以 12 小時綽綽有餘。
 * 之所以要留這麼久，是因為**公布預覽本身就是內容**：
 * 玩家在開戰前 12 小時就知道自己生在哪、鄰居是誰，
 * 賽季的社交網路在第一顆資源產出之前就開始編織。
 *
 * ## ★ 為什麼名額不用 advisory lock
 *
 * `season_quotas` 上有 `CHECK (taken <= capacity)`。搶最後一個名額時，
 * 一句原子的 `UPDATE ... SET taken = taken + 1` 就夠了 ——
 * 輸的那個會撞到約束，而不是讀到過期的計數。
 */

import { and, desc, eq, ne, sql } from "drizzle-orm";

import { BALANCE_VERSION, type SpawnBand } from "@/lib/game/balance";
import { generateWorld } from "@/lib/game/map/world";
import { CODE_TERRAIN } from "@/lib/game/map/terrain";
import { deriveSeed, mulberry32 } from "@/lib/game/rng";
import {
  initialQuotas,
  phaseAt,
  planAiFill,
  PHASE_DURATION,
  planRegistration,
  scheduleFrom,
  squadRequestsFrom,
  startingPopulationUsed,
  startingResources,
  STARTING_ARMY,
  type FactionId,
  type Phase,
  type RegistrationRejection,
  type SeasonSchedule,
} from "@/lib/game/season";
import { stewardAvatarSeed, stewardName } from "@/lib/game/steward";
import { coreTiles } from "@/lib/game/territory";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";

export interface SeasonResult {
  readonly ok: boolean;
  readonly reason?: RegistrationRejection | string;
}

type SeasonRow = typeof schema.seasons.$inferSelect;

/** 從資料庫的那一列還原出時間軸 */
export function scheduleOf(season: SeasonRow): SeasonSchedule {
  const opensAt = season.registrationOpensAt?.getTime() ?? season.createdAt.getTime();
  return scheduleFrom(opensAt);
}

export function phaseOf(season: SeasonRow, now: number): Phase {
  return phaseAt(scheduleOf(season), now);
}

// ─────────────────────────────────────────────────────────────
// 建立
// ─────────────────────────────────────────────────────────────

/**
 * 開一場新賽季：`seasons` 一列 + 九列名額。
 *
 * 名額在這裡就建好，登記時才有東西可以原子遞增。
 */
export async function createSeason(
  tx: TxDb,
  opts: { seed: number; registrationOpensAt: number },
): Promise<number> {
  const schedule = scheduleFrom(opts.registrationOpensAt);

  const [row] = await tx
    .insert(schema.seasons)
    .values({
      seed: BigInt(opts.seed),
      status: "REGISTRATION",
      balanceVersion: BALANCE_VERSION,
      registrationOpensAt: new Date(schedule.registrationOpensAt),
      registrationClosesAt: new Date(schedule.registrationClosesAt),
      startedAt: null,
      endsAt: new Date(schedule.endsAt),
    })
    .returning({ id: schema.seasons.id });

  const seasonId = row!.id;
  for (const q of initialQuotas()) {
    await tx.insert(schema.seasonQuotas).values({
      seasonId,
      faction: q.faction,
      spawnBand: q.band,
      capacity: q.capacity,
    });
  }

  return seasonId;
}

// ─────────────────────────────────────────────────────────────
// 登記
// ─────────────────────────────────────────────────────────────

export async function registerFor(
  tx: TxDb,
  seasonId: number,
  userId: number,
  input: { faction: number; band: string; squadCode?: string | null },
  now: number,
): Promise<SeasonResult> {
  const [season] = await tx
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.id, seasonId));
  if (!season) return { ok: false, reason: "NOT_FOUND" };

  const [quota] = await tx
    .select()
    .from(schema.seasonQuotas)
    .where(
      and(
        eq(schema.seasonQuotas.seasonId, seasonId),
        eq(schema.seasonQuotas.faction, input.faction),
        eq(schema.seasonQuotas.spawnBand, input.band as SpawnBand),
      ),
    );

  const [existing] = await tx
    .select({ id: schema.seasonRegistrations.id })
    .from(schema.seasonRegistrations)
    .where(
      and(
        eq(schema.seasonRegistrations.seasonId, seasonId),
        eq(schema.seasonRegistrations.userId, userId),
      ),
    );

  /**
   * ★ 一位玩家同時只能在一場賽季中（`docs/13` §7 D1）。
   *   下一場在第 7 天就開放登記，而這一場還沒結束 ——
   *   少了這一檢查，同一個人會同時在兩張地圖上。
   */
  const [elsewhere] = await tx
    .select({ id: schema.seasonRegistrations.id })
    .from(schema.seasonRegistrations)
    .innerJoin(schema.seasons, eq(schema.seasonRegistrations.seasonId, schema.seasons.id))
    .where(
      and(
        eq(schema.seasonRegistrations.userId, userId),
        ne(schema.seasonRegistrations.seasonId, seasonId),
        ne(schema.seasons.status, "ARCHIVED"),
      ),
    )
    .limit(1);

  const squadCode = input.squadCode?.trim().toUpperCase() || null;
  const squadMembers = squadCode
    ? await tx
        .select({
          faction: schema.seasonRegistrations.faction,
          band: schema.seasonRegistrations.spawnBand,
        })
        .from(schema.seasonRegistrations)
        .where(
          and(
            eq(schema.seasonRegistrations.seasonId, seasonId),
            eq(schema.seasonRegistrations.squadCode, squadCode),
          ),
        )
    : [];

  const plan = planRegistration(input, {
    schedule: scheduleOf(season),
    now,
    quota: quota ? { capacity: quota.capacity, taken: quota.taken } : null,
    alreadyRegistered: Boolean(existing),
    inAnotherSeason: Boolean(elsewhere),
    squadMembers,
  });
  if ("reason" in plan) return { ok: false, reason: plan.reason };

  /**
   * ★ 這一句是真正的併發控制。`CHECK (taken <= capacity)` 會讓
   *   搶輸最後一個名額的那個交易失敗 —— 不需要 advisory lock，
   *   也不會有「兩個人都讀到 taken = 199」的競態。
   */
  await tx
    .update(schema.seasonQuotas)
    .set({ taken: sql`${schema.seasonQuotas.taken} + 1` })
    .where(
      and(
        eq(schema.seasonQuotas.seasonId, seasonId),
        eq(schema.seasonQuotas.faction, plan.faction),
        eq(schema.seasonQuotas.spawnBand, plan.band),
      ),
    );

  await tx.insert(schema.seasonRegistrations).values({
    seasonId,
    userId,
    faction: plan.faction,
    spawnBand: plan.band,
    squadCode: plan.squadCode,
  });

  await tx
    .update(schema.seasons)
    .set({ humanCount: sql`${schema.seasons.humanCount} + 1` })
    .where(eq(schema.seasons.id, seasonId));

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// 封盤
// ─────────────────────────────────────────────────────────────

/**
 * 一個座位：誰、在哪、腳下是什麼地形。
 *
 * `registrationId` 為 `null` 就是 AI。地形一起存是因為 T = 0 要寫核心 2×2 的
 * `tiles.terrain`，而那時候我們手上不再有地圖。
 */
export interface SpawnSeat {
  readonly registrationId: number | null;
  readonly faction: FactionId;
  readonly band: SpawnBand;
  readonly x: number;
  readonly y: number;
  /** 核心 2×2 四格的地形，順序同 `coreTiles()` */
  readonly terrain: readonly string[];
}

export interface LockdownSummary {
  readonly seasonId: number;
  readonly humans: number;
  readonly ai: number;
  readonly seed: number;
  readonly seedAttempts: number;
  readonly fairnessPass: boolean;
  readonly elapsedMs: number;
  readonly brokenSquads: number;
}

/**
 * 封盤：AI 補足 → 地圖生成 → 分配 → 驗證 → 寫回出生點。
 *
 * ★ 這裡**不**建立 `players` 列。出生點先寫進 `season_registrations`，
 *   讓封盤期的預覽有東西可看；真正的開局狀態在 T=0 一次性寫入
 *   （`startSeason`）—— 否則資源會從封盤那一刻就開始累積，
 *   而「全員同時進入」這個承諾就破了。
 *
 * ★ 這是整套流程中**唯一**呼叫 `generateWorld` 的地方。解出來的座位表存進
 *   `seasons.spawn_plan`，T = 0 直接照抄 —— 所以生成參數怎麼調都不會讓
 *   預覽與實際開局分岔（測試就靠 `world` 把候選數壓到 2 來跑得快一點）。
 */
export async function lockdownSeason(
  tx: TxDb,
  seasonId: number,
  opts: {
    onProgress?: (m: string) => void;
    world?: { ruinCandidateCount?: number; maxSeedAttempts?: number };
  } = {},
): Promise<LockdownSummary> {
  const log = opts.onProgress ?? (() => undefined);
  const started = Date.now();

  const [season] = await tx.select().from(schema.seasons).where(eq(schema.seasons.id, seasonId));
  if (!season) throw new Error(`season ${seasonId} not found`);

  const registrations = await tx
    .select()
    .from(schema.seasonRegistrations)
    .where(eq(schema.seasonRegistrations.seasonId, seasonId))
    .orderBy(schema.seasonRegistrations.id);

  const quotas = await tx
    .select()
    .from(schema.seasonQuotas)
    .where(eq(schema.seasonQuotas.seasonId, seasonId));

  // ── AI 補足至 600 ────────────────────────────────────────
  const fill = planAiFill(
    quotas.map((q) => ({
      faction: q.faction as FactionId,
      band: q.spawnBand,
      capacity: q.capacity,
      taken: q.taken,
    })),
  );
  const aiCount = fill.reduce((s, f) => s + f.count, 0);
  log(`真人 ${registrations.length} 人，AI 補足 ${aiCount} 人`);

  /**
   * ★ 分配器要的是「哪些位置屬於哪個 (陣營, 環帶)」，
   *   而 AI 與真人在地理上**完全平等** —— 它們一起進同一個分配。
   *   把 AI 事後塞進剩餘點位會讓真人系統性地拿到比較好的位置。
   */
  const seats: { faction: FactionId; band: SpawnBand; registrationId: number | null }[] = [];
  for (const r of registrations) {
    seats.push({
      faction: r.faction as FactionId,
      band: r.spawnBand,
      registrationId: r.id,
    });
  }
  for (const f of fill) {
    for (let i = 0; i < f.count; i++) {
      seats.push({ faction: f.faction, band: f.band, registrationId: null });
    }
  }

  // ── 地圖生成 + 分配 + 驗證 ────────────────────────────────
  const world = generateWorld(Number(season.seed), {
    ...opts.world,
    squads: squadRequestsFrom(
      registrations.map((r) => ({
        faction: r.faction,
        band: r.spawnBand,
        squadCode: r.squadCode,
      })),
    ),
    onProgress: log,
  });
  log(
    `地圖完成（seed ${world.seed}，換了 ${world.seedAttempts - 1} 次）` +
      `，公平性 ${world.fairness.pass ? "全過" : "未全過"}`,
  );

  /**
   * ★ 出生點與座位配對時，**同一個 (陣營, 環帶) 內依序取**。
   *   分配器已經把小隊放在同一個群集裡，而真人登記是按 id 排序的 ——
   *   所以同代碼的人自然會拿到相鄰的點。
   */
  const byBucket = bucketSpawns(world.spawns.points);
  const cursor = new Map<string, number>();
  const terrainAt = (x: number, y: number) =>
    CODE_TERRAIN[world.map.cells[y * world.map.width + x] ?? 0] ?? "PLAIN";

  const plan: SpawnSeat[] = [];

  for (const seat of seats) {
    const key = `${seat.faction}:${seat.band}`;
    const list = byBucket.get(key) ?? [];
    const i = cursor.get(key) ?? 0;
    const point = list[i];
    if (!point) {
      log(`⚠ ${key} 的出生點不夠 —— 這一格少了一個人`);
      continue;
    }
    cursor.set(key, i + 1);
    plan.push({
      registrationId: seat.registrationId,
      faction: seat.faction,
      band: seat.band,
      x: point.x,
      y: point.y,
      terrain: coreTiles(point.x, point.y).map((t) => terrainAt(t.x, t.y)),
    });
  }

  for (const a of plan) {
    if (a.registrationId === null) continue;
    await tx
      .update(schema.seasonRegistrations)
      .set({ assignedX: a.x, assignedY: a.y })
      .where(eq(schema.seasonRegistrations.id, a.registrationId));
  }

  /**
   * ★ 地形檔要在這裡寫出來。
   *
   *   地形在賽季內永不改變，所以它是靜態資產：封盤期產一次、走 CDN。
   *   少了這一步，`/map` 就只能指著開發用的 `s0` —— 玩家看到的是一張
   *   跟自己那一局無關的地圖，連自己的據點都不在上面。
   *
   *   寫檔失敗不該讓封盤整個失敗（例如唯讀的檔案系統）：地圖畫不出來
   *   很糟，但比整場賽季開不成好。失敗只記一筆。
   */
  {
    const { serializeTerrain, storeTerrainInDb, terrainDirName, terrainRoot } = await import(
      "./terrain-files"
    );
    const files = serializeTerrain(world);

    /**
     * ★ 資料庫那一份與 SEALED 在**同一個交易**裡 —— 它是地形的真相，
     *   不會跟著容器蒸發。存不進去就讓封盤失敗重試，
     *   「賽季封盤了但地形不見了」這種半套狀態從此不存在。
     */
    await storeTerrainInDb(tx, seasonId, files);
    log(`地形入庫：${files.length} 檔（${(files.reduce((s, f) => s + f.data.length, 0) / 1024).toFixed(0)} KB）`);

    // 磁碟只是快取：寫失敗（唯讀檔案系統）就交給啟動時實體化或 /api/terrain
    try {
      const { join } = await import("node:path");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const dir = join(terrainRoot(), terrainDirName(seasonId));
      await mkdir(dir, { recursive: true });
      for (const f of files) await writeFile(join(dir, f.name), f.data);
      log(`地形磁碟快取 → ${dir}`);
    } catch (e) {
      log(`磁碟快取寫入失敗（改由啟動實體化或 API 供檔）：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await tx
    .update(schema.seasons)
    .set({
      status: "SEALED",
      seed: BigInt(world.seed),
      aiCount,
      ruinPositions: world.ruins.map((r) => ({ id: r.id, x: r.x, y: r.y })) as never,
      fairnessReport: world.fairness as never,
      spawnPlan: plan as never,
    })
    .where(eq(schema.seasons.id, seasonId));

  return {
    seasonId,
    humans: registrations.length,
    ai: aiCount,
    seed: world.seed,
    seedAttempts: world.seedAttempts,
    fairnessPass: world.fairness.pass,
    elapsedMs: Date.now() - started,
    brokenSquads: world.spawns.brokenSquads,
  };
}

// ─────────────────────────────────────────────────────────────
// T = 0
// ─────────────────────────────────────────────────────────────

export interface StartSummary {
  readonly seasonId: number;
  readonly players: number;
  readonly startedAt: number;
}

/**
 * T = 0：一次性寫入所有玩家的初始狀態。
 *
 * ★ **同時**是這裡唯一重要的事。所有人的 `settledAt` 都是同一個時間戳，
 *   所以第一顆資源在同一秒開始累積 —— 這是「事先登記 + 全員同時進入」
 *   這個設計的全部意義。
 */
export async function startSeason(
  tx: TxDb,
  seasonId: number,
  now: number,
  opts: { onProgress?: (m: string) => void } = {},
): Promise<StartSummary> {
  const log = opts.onProgress ?? (() => undefined);

  const [season] = await tx.select().from(schema.seasons).where(eq(schema.seasons.id, seasonId));
  if (!season) throw new Error(`season ${seasonId} not found`);

  const plan = (season.spawnPlan ?? null) as SpawnSeat[] | null;
  if (!plan || plan.length === 0) {
    throw new Error(`season ${seasonId} has no spawn plan — lockdown must run first`);
  }

  const registrations = await tx
    .select()
    .from(schema.seasonRegistrations)
    .where(eq(schema.seasonRegistrations.seasonId, seasonId));
  const userOf = new Map(registrations.map((r) => [r.id, r.userId]));

  const rng = mulberry32(deriveSeed(Number(season.seed), "ai-persona"));
  let created = 0;

  for (const seat of plan) {
    const isAi = seat.registrationId === null;
    /**
     * ★ 性格與偏移**每一個座位都擲**，包括真人的（擲了就丟）。
     *   否則真人與 AI 的相對順序一變，AI 的性格分佈就跟著變 ——
     *   同一個 seed 應該永遠得到同一批 AI。
     */
    const persona = pickPersona(rng());
    const variance = String((rng() * 0.3 - 0.15).toFixed(3));

    const [player] = await tx
      .insert(schema.players)
      .values({
        seasonId,
        userId: isAi ? null : (userOf.get(seat.registrationId!) ?? null),
        faction: seat.faction,
        spawnBand: seat.band,
        baseX: seat.x,
        baseY: seat.y,
        citadelLevel: 1,
        settledAt: new Date(now),
        lastSeenAt: null,
        isAi,
        aiPersona: isAi ? persona : null,
        aiVariance: isAi ? variance : null,
      })
      .returning({ id: schema.players.id });

    const playerId = player!.id;
    created++;

    if (seat.registrationId !== null) {
      await tx
        .update(schema.seasonRegistrations)
        .set({ playerId })
        .where(eq(schema.seasonRegistrations.id, seat.registrationId));
    }

    await writeInitialState(tx, {
      seasonId,
      playerId,
      band: seat.band,
      x: seat.x,
      y: seat.y,
      terrain: seat.terrain,
      now,
    });
  }

  await tx
    .update(schema.seasons)
    .set({ status: "RUNNING", startedAt: new Date(now) })
    .where(eq(schema.seasons.id, seasonId));

  log(`T = 0：寫入 ${created} 位玩家`);
  return { seasonId, players: created, startedAt: now };
}

type SpawnPoints = ReturnType<typeof generateWorld>["spawns"]["points"];

/**
 * 把出生點依 (陣營, 環帶) 分桶。
 *
 * ★ 封盤與 T=0 共用這一份 —— 兩邊的配對順序必須完全一致，
 *   否則玩家在預覽看到的座標與真正開局的位置會不一樣。
 */
function bucketSpawns(points: SpawnPoints): Map<string, SpawnPoints[number][]> {
  const out = new Map<string, SpawnPoints[number][]>();
  for (const p of points) {
    const key = `${p.faction}:${p.band}`;
    const list = out.get(key) ?? [];
    list.push(p);
    out.set(key, list);
  }
  return out;
}

/** 三種性格的比例（`docs/15` §2） */
function pickPersona(roll: number): "SETTLER" | "WARDEN" | "WARLORD" {
  if (roll < 0.5) return "SETTLER";
  if (roll < 0.85) return "WARDEN";
  return "WARLORD";
}

async function writeInitialState(
  tx: TxDb,
  input: {
    seasonId: number;
    playerId: number;
    band: SpawnBand;
    x: number;
    y: number;
    terrain: readonly string[];
    now: number;
  },
) {
  const resources = startingResources(input.band);

  await tx.insert(schema.playerResources).values({
    playerId: input.playerId,
    grain: String(resources.grain),
    timber: String(resources.timber),
    stone: String(resources.stone),
    iron: String(resources.iron),
    settledAt: new Date(input.now),
  });

  await tx.insert(schema.playerPopulation).values({
    playerId: input.playerId,
    amount: "0",
    // 起始的民兵從第一秒就佔人口 —— 陣亡不返還
    used: String(startingPopulationUsed()),
    settledAt: new Date(input.now),
  });

  for (const slot of ["B", "C", "D"] as const) {
    await tx
      .insert(schema.baseSlots)
      .values({ playerId: input.playerId, slot, building: null, level: 0 });
  }

  // 核心 2×2。`kind = BASE_CORE` 讓地圖畫得出來，但它不是「領土」
  const core = coreTiles(input.x, input.y);
  for (let i = 0; i < core.length; i++) {
    const t = core[i]!;
    await tx
      .insert(schema.tiles)
      .values({
        seasonId: input.seasonId,
        x: t.x,
        y: t.y,
        kind: "BASE_CORE",
        playerId: input.playerId,
        terrain: (input.terrain[i] ?? "PLAIN") as never,
      })
      .onConflictDoNothing();
  }

  await tx.insert(schema.garrisons).values({
    seasonId: input.seasonId,
    ownerId: input.playerId,
    atX: input.x,
    atY: input.y,
    hostId: input.playerId,
    units: STARTING_ARMY as never,
  });

  // 執政官從第 1 天就有（`docs/18` §10：所有人都有，永不販售）
  await tx.insert(schema.stewards).values({
    playerId: input.playerId,
    name: stewardName(input.playerId),
    avatarSeed: stewardAvatarSeed(input.playerId),
    directives: {} as never,
  });
}

// ─────────────────────────────────────────────────────────────
// 排程推進
// ─────────────────────────────────────────────────────────────

export interface AdvanceSummary {
  readonly locked: number;
  readonly started: number;
  readonly ended: number;
}

/**
 * 把所有賽季推進到它們**應該**在的階段。
 *
 * ★ 由結算迴圈呼叫。階段是從時間戳推導的，這個函式只是把資料庫裡
 *   那個快取欄位補上，順便執行階段轉換要做的批次作業。
 *   所以它**冪等**：已經在正確階段的賽季不會被動到。
 */
export async function advanceSeasons(
  tx: TxDb,
  now: number,
  opts: {
    onProgress?: (m: string) => void;
    world?: { ruinCandidateCount?: number; maxSeedAttempts?: number };
  } = {},
): Promise<AdvanceSummary> {
  const seasons = await tx
    .select()
    .from(schema.seasons)
    .where(ne(schema.seasons.status, "ARCHIVED"));

  let locked = 0;
  let started = 0;
  let ended = 0;

  for (const season of seasons) {
    const want = phaseOf(season, now);
    if (want === season.status) continue;

    if (want === "SEALED" && season.status === "REGISTRATION") {
      await lockdownSeason(tx, season.id, opts);
      locked++;
    } else if (want === "RUNNING" && season.status === "SEALED") {
      await startSeason(tx, season.id, now, opts);
      started++;
    } else if (want === "ENDING" || want === "ARCHIVED") {
      await tx
        .update(schema.seasons)
        .set({ status: want })
        .where(eq(schema.seasons.id, season.id));
      ended++;
    }
  }

  return { locked, started, ended };
}

/**
 * 下一場該不該開了（第 7 天）。
 *
 * ★ 判準是**上一場的時間軸**，不是「現在有沒有人在收登記」。
 *
 *   看起來「沒有賽季在收人就開一場」比較直覺，但它會把節奏整個壓垮：
 *   一場賽季的登記在第 3 天就截止，而下一場要到第 7 天才開 ——
 *   中間那四天本來就**應該**沒有任何賽季在收人。
 *   照「沒人收人就開」的寫法，結算迴圈會在封盤後的第一分鐘就開下一場，
 *   七天的輪替變成三天，而且每一輪都再快一點。
 *
 *   新賽季的 `registrationOpensAt` 直接取 `nextOpensAt`，不取 `now` ——
 *   節奏因此固定在格子上，不會被 cron 的觸發時刻一輪一輪往後拖。
 */
export async function ensureNextSeason(
  tx: TxDb,
  now: number,
): Promise<number | null> {
  const [latest] = await tx
    .select()
    .from(schema.seasons)
    .orderBy(desc(schema.seasons.id))
    .limit(1);

  let opensAt = now;
  if (latest) {
    const { nextOpensAt } = scheduleOf(latest);
    if (now < nextOpensAt) return null;
    /**
     * 排程停擺很久之後才恢復的話，`nextOpensAt` 可能已經是很久以前 ——
     * 照抄會開出一場「一出生就該封盤」的賽季。落後超過一個週期就重新對時。
     */
    opensAt = now - nextOpensAt > PHASE_DURATION.cadenceMs ? now : nextOpensAt;
  }

  const seed = Math.floor(mulberry32(deriveSeed(opensAt, "season-seed"))() * 2 ** 31);
  return createSeason(tx, { seed, registrationOpensAt: opensAt });
}
