import "server-only";

/**
 * 執政官的伺服器層：載入方針、組出決策輸入、執行動作、寫簡報素材。
 *
 * ★ 決策**全部**在 `lib/game/steward.ts` 的純函式裡做完。
 *   這裡只做三件事：搬資料、呼叫共用的操作核心、記錄結果。
 *
 * ★ 執行走的是 `lib/server/base-ops.ts` ——
 *   與玩家按下按鈕時完全同一個函式。動作不合法就是失敗，
 *   而失敗本身要被記進簡報（`docs/18` §11.4）。
 */

import { and, eq, gte, lt } from "drizzle-orm";

import { SEASON_MODIFIERS, STEWARD } from "@/lib/game/balance";
import { deriveRates, outpostUpkeep } from "@/lib/game/economy-state";
import { zeroAmounts, type Amounts } from "@/lib/game/settle";
import {
  decideStewardActions,
  defaultDirectives,
  isFullProxy,
  parseDirectives,
  stewardAvatarSeed,
  stewardName,
  type Directives,
  type StewardAction,
  type StewardBlock,
  type StewardDecision,
  type StewardFacilityOption,
  type StewardWarning,
} from "@/lib/game/steward";
import { schema } from "@/lib/db";
import { withTransaction, type TxDb } from "@/lib/db/tx";
import { buildFacilityFor, claimTileFor, trainUnitsFor } from "@/lib/server/base-ops";
import { freeTrainQueues } from "@/lib/game/train";
import { scheduleEvent, settleWithin } from "@/lib/server/player-state";
import { buildTerritoryBoard } from "@/lib/server/territory-board";

export interface StewardRecord {
  readonly playerId: number;
  readonly name: string;
  readonly avatarSeed: number;
  readonly directives: Directives;
  readonly fullProxy: boolean;
  readonly lastActedAt: number | null;
}

/**
 * 取出執政官，沒有就建一個。
 *
 * 名字由 `playerId` 決定性生成 —— 同一位玩家永遠得到同一個名字，
 * 就算這一列因為任何原因被重建也一樣。
 */
export async function ensureSteward(tx: TxDb, playerId: number): Promise<StewardRecord> {
  const [existing] = await tx
    .select()
    .from(schema.stewards)
    .where(eq(schema.stewards.playerId, playerId));

  if (existing) {
    return {
      playerId,
      name: existing.name,
      avatarSeed: existing.avatarSeed,
      directives: {
        ...parseDirectives(existing.directives),
        pausedUntil: existing.pausedUntil?.getTime() ?? null,
      },
      fullProxy: existing.fullProxy,
      lastActedAt: existing.lastActedAt?.getTime() ?? null,
    };
  }

  const name = stewardName(playerId);
  const avatarSeed = stewardAvatarSeed(playerId);
  await tx
    .insert(schema.stewards)
    .values({ playerId, name, avatarSeed, directives: defaultDirectives() as never })
    .onConflictDoNothing();

  return {
    playerId,
    name,
    avatarSeed,
    directives: defaultDirectives(),
    fullProxy: false,
    lastActedAt: null,
  };
}

export async function saveDirectives(tx: TxDb, playerId: number, directives: Directives) {
  await ensureSteward(tx, playerId);
  await tx
    .update(schema.stewards)
    .set({
      // `pausedUntil` 存在自己的欄位裡（要能被 SQL 查詢），jsonb 裡不重複存
      directives: { ...directives, pausedUntil: undefined } as never,
      pausedUntil: directives.pausedUntil === null ? null : new Date(directives.pausedUntil),
    })
    .where(eq(schema.stewards.playerId, playerId));
}

type LogKind = (typeof schema.stewardLogKindEnum.enumValues)[number];

export async function logSteward(
  tx: TxDb,
  playerId: number,
  kind: LogKind,
  payload: unknown,
  now: number,
) {
  await tx.insert(schema.stewardLog).values({
    playerId,
    kind,
    payload: payload as never,
    createdAt: new Date(now),
  });
}

/** 簡報素材只留 48 小時（`docs/18` §11.4） */
export async function pruneStewardLog(tx: TxDb, playerId: number, now: number) {
  await tx
    .delete(schema.stewardLog)
    .where(
      and(
        eq(schema.stewardLog.playerId, playerId),
        lt(schema.stewardLog.createdAt, new Date(now - STEWARD.logRetentionMs)),
      ),
    );
}

// ─────────────────────────────────────────────────────────────
// 執行
// ─────────────────────────────────────────────────────────────

export interface StewardRunResult {
  readonly ran: boolean;
  readonly decision: StewardDecision | null;
  readonly executed: number;
  readonly failed: number;
}

/**
 * 跑一輪執政官。
 *
 * ★ 這個函式**冪等到可以隨便呼叫**：如果佇列忙、方針全關、或正在暫停，
 *   它就什麼都不做。所以「每個佇列完成事件之後都叫一次」是安全的。
 */
export async function runStewardWithin(
  tx: TxDb,
  playerId: number,
  now: number,
): Promise<StewardRunResult> {
  const steward = await ensureSteward(tx, playerId);

  /**
   * ★ 什麼都沒開就直接走人，**在**組決策輸入之前。
   *   組輸入要讀領土、地形檔、遺跡座標 —— 對一位沒啟用任何方針的玩家
   *   做這些事是純浪費，而多數玩家在多數時候正是這個狀態。
   */
  const anyEnabled =
    steward.directives.expansion.enabled ||
    steward.directives.development.enabled ||
    steward.directives.levy.enabled;
  const paused =
    steward.directives.pausedUntil !== null && steward.directives.pausedUntil > now;
  if (!anyEnabled || paused) {
    // 還是要結算（事件到期了就該生效），也還是要把安全網排下去
    const settled = await settleWithin(tx, playerId, now);
    await scheduleNextTick(tx, settled.seasonId, playerId, now);
    return { ran: false, decision: null, executed: 0, failed: 0 };
  }

  const state = await settleWithin(tx, playerId, now);
  const board = await buildTerritoryBoard(tx, state, now);

  const derived = deriveRates({
    citadel: state.build.citadel,
    depotLevel: state.build.slots.D.building === "DEPOT" ? state.build.slots.D.level : 0,
    tiles: state.tiles,
    bandBonus: state.bandBonus,
  });
  const season = SEASON_MODIFIERS[state.season];
  const upkeep = outpostUpkeep(derived.outpostLevels);
  const netPerHour: Amounts = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    netPerHour[r] = derived.baseRates[r] * season.production - upkeep[r] * season.upkeep;
  }

  const facilityOptions: StewardFacilityOption[] = state.tiles
    // 孤立的地產出減半、隨時可能被放棄 —— 不值得投資
    .filter((t) => t.state !== "ISOLATED")
    .map((t) => ({
      x: t.x,
      y: t.y,
      terrain: t.terrain,
      facility: t.facility,
      level: t.facilityLevel,
    }));

  const decision = decideStewardActions({
    now,
    citadelLevel: state.build.citadel,
    directives: steward.directives,
    resources: state.economy.resources,
    capacity: state.economy.capacity,
    netPerHour,
    population: {
      amount: state.economy.population.amount,
      cap: state.economy.population.cap,
      used: state.economy.population.used,
    },
    territoryQueuesFree: board.queuesFreeCount,
    barracksQueuesFree: freeTrainQueues(state.train, now),
    ownedCount: state.tiles.length,
    territoryCapacity: board.capacity,
    // ★ 有野生守衛的格子不進執政官的視野 —— 拓那些要派兵（軍事禁區，docs/18 §2）。
    //   不濾掉的話它會永遠嘗試一件永遠做不到的事（CLAUDE.md「規劃 vs 執行」）
    candidates: board.candidates.filter((c) => !c.guarded),
    facilityOptions,
  });

  let executed = 0;
  let failed = 0;

  for (const action of decision.actions) {
    const result = await execute(tx, playerId, action, now);
    if (result.ok) {
      executed++;
      await logSteward(tx, playerId, logKindOf(action), describe(action), now);
    } else {
      failed++;
      /**
       * ★ 失敗也要記。決策時看到的狀態與執行時的狀態之間有一段落差
       *   （例如同一輪的前一個動作把錢花掉了），而領主有權知道
       *   「執政官試了但沒成功」。
       */
      await logSteward(
        tx,
        playerId,
        "BLOCKED",
        { ...describe(action), reason: result.reason },
        now,
      );
    }
  }

  for (const block of decision.blocked) await logBlock(tx, playerId, block, now);
  for (const warning of decision.warnings) await logWarning(tx, playerId, warning, now);

  await tx
    .update(schema.stewards)
    .set({
      lastActedAt: new Date(now),
      fullProxy: isFullProxy(state.lastSeenAt, now),
    })
    .where(eq(schema.stewards.playerId, playerId));

  await scheduleNextTick(tx, state.seasonId, playerId, now);
  await pruneStewardLog(tx, playerId, now);

  return { ran: true, decision, executed, failed };
}

/** 給事件觸發用：自己開交易 */
export async function runSteward(playerId: number, now: number): Promise<StewardRunResult> {
  return withTransaction((tx) => runStewardWithin(tx, playerId, now));
}

async function execute(tx: TxDb, playerId: number, action: StewardAction, now: number) {
  switch (action.kind) {
    case "CLAIM":
      return claimTileFor(tx, playerId, action.x, action.y, now);
    case "BUILD":
      return buildFacilityFor(tx, playerId, action.x, action.y, action.facility, now);
    case "LEVY":
      return trainUnitsFor(tx, playerId, action.unit, action.count, now);
  }
}

function logKindOf(action: StewardAction): LogKind {
  return action.kind === "CLAIM" ? "CLAIM" : action.kind === "BUILD" ? "BUILD" : "LEVY";
}

function describe(action: StewardAction): Record<string, unknown> {
  switch (action.kind) {
    case "CLAIM":
      return { kind: "CLAIM", x: action.x, y: action.y };
    case "BUILD":
      return {
        kind: "BUILD",
        x: action.x,
        y: action.y,
        facility: action.facility,
        toLevel: action.toLevel,
      };
    case "LEVY":
      return { kind: "LEVY", unit: action.unit, count: action.count };
  }
}

/**
 * `BLOCKED` 與 `WARNING` 會在每一輪重複出現（保留下限沒改就一直擋著）。
 *
 * ★ 同一種阻塞在 `dedupeMs` 內只記一次，否則簡報會被同一句話洗版 ——
 *   而簡報的價值就在於它**不是**一面通知牆。
 */
const DEDUPE_MS = 6 * 60 * 60 * 1000;

async function logBlock(tx: TxDb, playerId: number, block: StewardBlock, now: number) {
  const recent = await tx
    .select({ id: schema.stewardLog.id, payload: schema.stewardLog.payload })
    .from(schema.stewardLog)
    .where(
      and(
        eq(schema.stewardLog.playerId, playerId),
        eq(schema.stewardLog.kind, "BLOCKED"),
        gte(schema.stewardLog.createdAt, new Date(now - DEDUPE_MS)),
      ),
    );
  const seen = recent.some((r) => {
    const p = r.payload as { directive?: unknown; reason?: unknown };
    return p.directive === block.directive && p.reason === block.reason;
  });
  if (seen) return;

  await logSteward(tx, playerId, "BLOCKED", { ...block }, now);
}

async function logWarning(tx: TxDb, playerId: number, warning: StewardWarning, now: number) {
  const recent = await tx
    .select({ payload: schema.stewardLog.payload })
    .from(schema.stewardLog)
    .where(
      and(
        eq(schema.stewardLog.playerId, playerId),
        eq(schema.stewardLog.kind, "WARNING"),
        gte(schema.stewardLog.createdAt, new Date(now - DEDUPE_MS)),
      ),
    );
  const seen = recent.some((r) => {
    const p = r.payload as { kind?: unknown; resource?: unknown };
    return p.kind === warning.kind && p.resource === warning.resource;
  });
  if (seen) return;

  await logSteward(tx, playerId, "WARNING", { ...warning }, now);
}

/**
 * 安全網 tick。
 *
 * ★ 主要觸發是「佇列完成事件」，這個 tick 只處理
 *   「佇列本來就是空的」那種情況（`docs/18` §11.1）。
 *   排下一個之前先確認沒有未結算的 tick，否則每次執行都會多排一個，
 *   幾小時後就變成 tick 風暴。
 */
async function scheduleNextTick(tx: TxDb, seasonId: number, playerId: number, now: number) {
  const [pending] = await tx
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.actorId, playerId),
        eq(schema.events.type, "STEWARD_TICK"),
        gte(schema.events.resolveAt, new Date(now)),
      ),
    )
    .limit(1);
  if (pending) return;

  await scheduleEvent(tx, {
    seasonId,
    type: "STEWARD_TICK",
    actorId: playerId,
    payload: { kind: "STEWARD_TICK" },
    resolveAt: now + STEWARD.tickIntervalMs,
  });
}

// ─────────────────────────────────────────────────────────────
// 施政簡報
// ─────────────────────────────────────────────────────────────

export interface BriefingEntry {
  readonly kind: LogKind;
  readonly payload: Record<string, unknown>;
  readonly at: number;
}

export interface Briefing {
  readonly stewardName: string;
  readonly avatarSeed: number;
  /** 領主離開了多久（毫秒）。null = 沒有紀錄 */
  readonly awayMs: number | null;
  readonly entries: readonly BriefingEntry[];
  readonly fullProxy: boolean;
}

/**
 * 登入時的第一個畫面。
 *
 * 把「結算離線期間的一切」從**一堆待處理事項**變成**一位下屬的回報**
 * （`docs/18` §7）—— 同一份資訊，完全不同的體感。
 */
export async function loadBriefing(tx: TxDb, playerId: number, now: number): Promise<Briefing> {
  const steward = await ensureSteward(tx, playerId);

  const [player] = await tx
    .select({ lastSeenAt: schema.players.lastSeenAt })
    .from(schema.players)
    .where(eq(schema.players.id, playerId));

  const rows = await tx
    .select()
    .from(schema.stewardLog)
    .where(
      and(
        eq(schema.stewardLog.playerId, playerId),
        gte(schema.stewardLog.createdAt, new Date(now - STEWARD.logRetentionMs)),
      ),
    );

  const entries = rows
    .map((r) => ({
      kind: r.kind,
      payload: (r.payload ?? {}) as Record<string, unknown>,
      at: r.createdAt.getTime(),
    }))
    .sort((a, b) => b.at - a.at);

  const lastSeen = player?.lastSeenAt?.getTime() ?? null;

  return {
    stewardName: steward.name,
    avatarSeed: steward.avatarSeed,
    awayMs: lastSeen === null ? null : Math.max(0, now - lastSeen),
    entries,
    fullProxy: steward.fullProxy,
  };
}

/** 看完簡報：清掉素材並更新 `lastSeenAt`（全權代理也在此收回） */
export async function acknowledgeBriefingWithin(tx: TxDb, playerId: number, now: number) {
  await tx.delete(schema.stewardLog).where(eq(schema.stewardLog.playerId, playerId));
  await tx
    .update(schema.players)
    .set({ lastSeenAt: new Date(now) })
    .where(eq(schema.players.id, playerId));
  await tx
    .update(schema.stewards)
    .set({ fullProxy: false })
    .where(eq(schema.stewards.playerId, playerId));
}
