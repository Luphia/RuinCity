"use server";

/**
 * 執政官的 Server Actions。
 *
 * ★ 這裡只有**領主**的操作：設定方針、暫停、召回、看簡報。
 *   執政官自己的行動不從這裡進來 —— 它走 `lib/server/steward.ts`
 *   的 `runStewardWithin`，由伺服器的結算迴圈觸發（`docs/18` §11.1）。
 */

import { revalidatePath } from "next/cache";
import { and, eq, isNull } from "drizzle-orm";

import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import { clampPause, parseDirectives, type Directives } from "@/lib/game/steward";
import { sanitiseStewardName } from "@/lib/game/avatar";
import { unlockedUnits } from "@/lib/game/train";
import type { Unit } from "@/lib/game/balance";
import { stewardDirectiveSlots } from "@/lib/game/formulas";
import {
  acknowledgeBriefingWithin,
  ensureSteward,
  loadBriefing,
  saveDirectives,
  type Briefing,
} from "@/lib/server/steward";
import { settleWithin } from "@/lib/server/player-state";
import { requirePlayerId as currentPlayerId } from "@/lib/server/current-player";
import { serverNow } from "@/lib/time";

export interface StewardResult {
  readonly ok: boolean;
  readonly reason?: string;
}


export interface StewardBoard {
  readonly name: string;
  readonly avatarSeed: number;
  readonly directives: Directives;
  readonly citadelLevel: number;
  readonly slots: number;
  readonly enabledCount: number;
  readonly fullProxy: boolean;
  readonly pausedUntil: number | null;
  /** 目前的資源，UI 拿來當保留下限滑桿的參考刻度 */
  readonly resources: Directives["expansion"]["reserve"];
  readonly capacity: number;
  readonly serverTime: number;
  /** 執政官派出、還沒立旗完成的拓荒隊 */
  readonly recallable: readonly { readonly eventId: number; readonly x: number; readonly y: number; readonly doneAt: number }[];
  /** 募兵方針的兵種選單，只列現在招得動的 */
  readonly unlockedUnits: readonly Unit[];
}

export async function loadStewardBoard(): Promise<StewardBoard> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const steward = await ensureSteward(tx, playerId);
    const state = await settleWithin(tx, playerId);

    const pending = await tx
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.actorId, playerId),
          eq(schema.events.type, "CLAIM_DONE"),
          isNull(schema.events.resolvedAt),
        ),
      );

    const recallable = pending.flatMap((e) => {
      const p = (e.payload ?? {}) as { x?: unknown; y?: unknown };
      if (typeof p.x !== "number" || typeof p.y !== "number") return [];
      if (e.resolveAt.getTime() <= now) return [];
      return [{ eventId: e.id, x: p.x, y: p.y, doneAt: e.resolveAt.getTime() }];
    });

    const d = steward.directives;
    return {
      name: steward.name,
      avatarSeed: steward.avatarSeed,
      directives: d,
      citadelLevel: state.build.citadel,
      slots: stewardDirectiveSlots(state.build.citadel),
      enabledCount:
        (d.expansion.enabled ? 1 : 0) +
        (d.development.enabled ? 1 : 0) +
        (d.levy.enabled ? 1 : 0),
      fullProxy: steward.fullProxy,
      pausedUntil: d.pausedUntil,
      resources: state.economy.resources,
      capacity: state.economy.capacity,
      serverTime: now,
      recallable,
      unlockedUnits: unlockedUnits(state.build.slots),
    };
  });
}

/**
 * 設定方針。
 *
 * ★ 開超過額度**不擋**，只是多的那些不會生效（`activeDirectives`
 *   依宣告順序取前 N 個）。擋下來的話，玩家在主堡升級的那一刻
 *   還得回來自己補開 —— 而升級的獎勵就該是「原本開的東西生效了」。
 */
export async function setDirectives(raw: unknown): Promise<StewardResult> {
  const playerId = await currentPlayerId();
  const parsed = parseDirectives(raw);

  return withTransaction(async (tx) => {
    // 暫停狀態不從這條路徑改 —— 它有自己的 action
    const current = await ensureSteward(tx, playerId);
    await saveDirectives(tx, playerId, {
      ...parsed,
      pausedUntil: current.directives.pausedUntil,
    });
    revalidatePath("/steward");
    return { ok: true };
  });
}

/** 領主接管：暫停 N 小時（1–24，預設 6） */
export async function pauseSteward(hours: number): Promise<StewardResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const steward = await ensureSteward(tx, playerId);
    await saveDirectives(tx, playerId, {
      ...steward.directives,
      pausedUntil: now + clampPause(hours),
    });
    revalidatePath("/steward");
    return { ok: true };
  });
}

export async function resumeSteward(): Promise<StewardResult> {
  const playerId = await currentPlayerId();

  return withTransaction(async (tx) => {
    const steward = await ensureSteward(tx, playerId);
    await saveDirectives(tx, playerId, { ...steward.directives, pausedUntil: null });
    revalidatePath("/steward");
    return { ok: true };
  });
}

/**
 * 召回一支還在路上的拓荒隊（`docs/18` §6）。
 *
 * ★ 退還全額成本。這不是「取消訂單要付違約金」，
 *   而是領主收回控制權的手段 —— 收手續費等於在懲罰玩家接管，
 *   而接管正是我們希望他做的事。
 */
export async function recallClaim(eventId: number): Promise<StewardResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.id, eventId),
          eq(schema.events.actorId, playerId),
          eq(schema.events.type, "CLAIM_DONE"),
          isNull(schema.events.resolvedAt),
        ),
      )
      .for("update");
    if (!event) return { ok: false, reason: "NOT_FOUND" };
    // 已經立旗完成的召不回來 —— 那塊地已經是你的了
    if (event.resolveAt.getTime() <= now) return { ok: false, reason: "ALREADY_DONE" };

    const state = await settleWithin(tx, playerId, now);
    const p = (event.payload ?? {}) as { x?: unknown; y?: unknown; militia?: unknown };
    const { claimCost } = await import("@/lib/game/territory");
    // 下單時的領土數 = 現在的領土數（那一格還沒入帳）
    const refund = claimCost(state.tiles.length);

    await tx
      .update(schema.playerResources)
      .set({
        grain: String(Math.min(state.economy.capacity, state.economy.resources.grain + refund.grain)),
        timber: String(
          Math.min(state.economy.capacity, state.economy.resources.timber + refund.timber),
        ),
      })
      .where(eq(schema.playerResources.playerId, playerId));

    // ★ 民兵在下單時就被扣掉了（`base-ops.ts`），召回要還回來
    const militia = typeof p.militia === "number" ? p.militia : 0;
    if (militia > 0) {
      await tx
        .update(schema.playerPopulation)
        .set({ used: String(Math.max(0, state.economy.population.used - militia)) })
        .where(eq(schema.playerPopulation.playerId, playerId));
    }

    // 標記為已結算 —— `parsePayload` 認不出 RECALLED 的 payload，
    // 就算被讀到也會被安全地跳過
    await tx
      .update(schema.events)
      .set({ resolvedAt: new Date(now), payload: { kind: "RECALLED", x: p.x, y: p.y } as never })
      .where(eq(schema.events.id, eventId));

    revalidatePath("/steward");
    revalidatePath("/territory");
    return { ok: true };
  });
}

/**
 * 重新命名執政官。
 *
 * ★ 純外觀、免費（`docs/18` §10）。額外的方針欄位是戰力所以不可販售，
 *   但名字與皮膚不是 —— 這條線要劃清楚。
 */
export async function renameSteward(name: string): Promise<StewardResult> {
  const playerId = await currentPlayerId();
  const clean = sanitiseStewardName(name);
  if (clean === null) return { ok: false, reason: "EMPTY_NAME" };

  return withTransaction(async (tx) => {
    await ensureSteward(tx, playerId);
    await tx
      .update(schema.stewards)
      .set({ name: clean })
      .where(eq(schema.stewards.playerId, playerId));
    revalidatePath("/steward");
    revalidatePath("/base");
    return { ok: true };
  });
}

/** 登入時的施政簡報 */
export async function loadStewardBriefing(): Promise<Briefing> {
  const playerId = await currentPlayerId();
  const now = await serverNow();
  return withTransaction((tx) => loadBriefing(tx, playerId, now));
}

/** 「知道了」：清掉簡報素材、更新 lastSeenAt、收回全權代理 */
export async function acknowledgeBriefing(): Promise<StewardResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  await withTransaction((tx) => acknowledgeBriefingWithin(tx, playerId, now));
  revalidatePath("/base");
  revalidatePath("/steward");
  return { ok: true };
}
