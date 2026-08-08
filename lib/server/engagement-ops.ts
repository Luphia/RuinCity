import "server-only";

/**
 * 交戰的伺服器層：入場、結算。
 * 對應 docs/04-military-combat.md §3d。
 *
 * ## 這一層改變了什麼
 *
 * 舊模型：一支行軍抵達 → 當場算完一整場仗 → 寫戰報 → 回家。
 * 新模型：一支行軍抵達 → **加入這一格的交戰**（沒有就開一場）
 *         → 兩分鐘後 cron 一起結算 → 每位參戰者各拿一份戰報。
 *
 * 三件事因此成立：
 *   1. 戰鬥有持續時間 → 任何人都能在這段時間打開那一格看動畫
 *   2. 一格能塞多支部隊（5 對 5，主城 10 對 10）→ 援軍趕得到
 *   3. 中立資源地的攻方名額對所有人開放 → 同一場仗裡競爭
 *
 * ## 沒有改變的分界
 *
 * **總帳仍然命定**：誰死多少由 `resolveBattle` 一次算出來（`docs/11` §20.20），
 * 只是現在餵給它的是**兩方各自的合計**，算完再按出兵比例分回每個人身上
 * （`lib/game/engagement.ts` 的 `distributeLosses`）。
 * 畫面仍然由 `battlefield.ts` 演，只是它現在演的是一場**還沒結束**的仗。
 */

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import { BATTLE } from "@/lib/game/balance";
import { isEmptyArmy, parseArmy, type Army } from "@/lib/game/army";
import {
  canJoin,
  sideArmy,
  slotUsage,
  type Participant,
  type Side,
} from "@/lib/game/engagement";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";

export type EngagementRow = typeof schema.engagements.$inferSelect;
export type PartRow = typeof schema.engagementParts.$inferSelect;

/** 這一格現在進行中的交戰（沒有就 null） */
export async function activeEngagementAt(
  tx: TxDb,
  seasonId: number,
  x: number,
  y: number,
): Promise<EngagementRow | null> {
  const [row] = await tx
    .select()
    .from(schema.engagements)
    .where(
      and(
        eq(schema.engagements.seasonId, seasonId),
        eq(schema.engagements.x, x),
        eq(schema.engagements.y, y),
        isNull(schema.engagements.resolvedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function partsOf(tx: TxDb, engagementId: number): Promise<PartRow[]> {
  return tx
    .select()
    .from(schema.engagementParts)
    .where(eq(schema.engagementParts.engagementId, engagementId))
    .orderBy(asc(schema.engagementParts.id));
}

/** DB 列 → 純函式看得懂的參戰者 */
export function toParticipants(rows: readonly PartRow[]): Participant[] {
  return rows.map((r) => ({
    playerId: r.playerId ?? 0,
    side: r.side as Side,
    army: parseArmy(r.units),
  }));
}

export interface JoinResult {
  readonly engagement: EngagementRow;
  readonly joined: boolean;
  /** 沒進去的原因（名額滿了）*/
  readonly reason: "SLOTS_FULL" | null;
}

/**
 * 讓一支部隊進場。沒有交戰就開一場，並把**守方的原駐軍**一起放進去。
 *
 * ★ 守方駐軍佔一個名額，而不是「不算在容量內」。
 *   它就是站在那一格上的一支部隊 —— 給它豁免的話，
 *   「5 對 5」就會變成「5 對 6」，而那多出來的一支永遠是守方的。
 */
export async function joinOrOpenEngagement(
  tx: TxDb,
  input: {
    seasonId: number;
    x: number;
    y: number;
    isKeep: boolean;
    defenderId: number | null;
    /** 守方站在這一格上的部隊（開場時放進去；已經開場就不再放） */
    defenderGarrison: Army;
    attacker: { playerId: number; marchId: number; army: Army };
  },
  now: number,
): Promise<JoinResult> {
  let engagement = await activeEngagementAt(tx, input.seasonId, input.x, input.y);

  if (!engagement) {
    const [created] = await tx
      .insert(schema.engagements)
      .values({
        seasonId: input.seasonId,
        x: input.x,
        y: input.y,
        defenderId: input.defenderId,
        isKeep: input.isKeep,
        startedAt: new Date(now),
        endsAt: new Date(now + BATTLE.durationMs),
      })
      .returning();
    engagement = created!;

    if (!isEmptyArmy(input.defenderGarrison)) {
      await tx.insert(schema.engagementParts).values({
        engagementId: engagement.id,
        side: "DEFENDER",
        playerId: input.defenderId,
        marchId: null,
        units: input.defenderGarrison as never,
        joinedAt: new Date(now),
      });
    }
  }

  const parts = await partsOf(tx, engagement.id);
  const admit = canJoin(toParticipants(parts), "ATTACKER", engagement.isKeep);
  if (admit !== true) return { engagement, joined: false, reason: admit };

  await tx.insert(schema.engagementParts).values({
    engagementId: engagement.id,
    side: "ATTACKER",
    playerId: input.attacker.playerId,
    marchId: input.attacker.marchId,
    units: input.attacker.army as never,
    joinedAt: new Date(now),
  });

  return { engagement, joined: true, reason: null };
}

/**
 * 增援：把一支部隊放進**守方**的名額。
 *
 * 與攻方走同一個容量檢查 —— 守方也會滿，而「守方名額滿了」
 * 本身就是攻方值得爭取的東西（先塞滿對方的位子，援軍就進不來）。
 */
export async function joinAsDefender(
  tx: TxDb,
  engagement: EngagementRow,
  input: { playerId: number; marchId: number | null; army: Army },
  now: number,
): Promise<JoinResult> {
  const parts = await partsOf(tx, engagement.id);
  const admit = canJoin(toParticipants(parts), "DEFENDER", engagement.isKeep);
  if (admit !== true) return { engagement, joined: false, reason: admit };

  await tx.insert(schema.engagementParts).values({
    engagementId: engagement.id,
    side: "DEFENDER",
    playerId: input.playerId,
    marchId: input.marchId,
    units: input.army as never,
    joinedAt: new Date(now),
  });
  return { engagement, joined: true, reason: null };
}

/** 到期待結算的交戰（cron 每分鐘掃一次，與行軍抵達同一個節奏） */
export async function dueEngagements(
  tx: TxDb,
  seasonId: number,
  now: number,
  limit = 50,
): Promise<EngagementRow[]> {
  return tx
    .select()
    .from(schema.engagements)
    .where(
      and(
        eq(schema.engagements.seasonId, seasonId),
        isNull(schema.engagements.resolvedAt),
        lte(schema.engagements.endsAt, new Date(now)),
      ),
    )
    .orderBy(asc(schema.engagements.endsAt), asc(schema.engagements.id))
    .limit(limit)
    .for("update");
}

/** 給 UI：這一格現在打得怎麼樣（進行中才有） */
export interface LiveEngagement {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly isKeep: boolean;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly attacker: Army;
  readonly defender: Army;
  readonly slots: ReturnType<typeof slotUsage>;
  /** 參戰者名單（中立守衛的 playerId 是 null） */
  readonly roster: readonly {
    readonly side: Side;
    readonly playerId: number | null;
    readonly units: Army;
  }[];
}

export async function liveEngagementAt(
  tx: TxDb,
  seasonId: number,
  x: number,
  y: number,
): Promise<LiveEngagement | null> {
  const engagement = await activeEngagementAt(tx, seasonId, x, y);
  if (!engagement) return null;
  const parts = await partsOf(tx, engagement.id);
  const ps = toParticipants(parts);

  return {
    id: engagement.id,
    x: engagement.x,
    y: engagement.y,
    isKeep: engagement.isKeep,
    startedAt: engagement.startedAt.getTime(),
    endsAt: engagement.endsAt.getTime(),
    attacker: sideArmy(ps, "ATTACKER"),
    defender: sideArmy(ps, "DEFENDER"),
    slots: slotUsage(ps, engagement.isKeep),
    roster: parts.map((r) => ({
      side: r.side as Side,
      playerId: r.playerId,
      units: parseArmy(r.units),
    })),
  };
}

/** 標記結算完成。`resolvedAt` 一旦寫上，那一格就能開下一場了 */
export async function closeEngagement(tx: TxDb, id: number, now: number) {
  await tx
    .update(schema.engagements)
    .set({ resolvedAt: new Date(now) })
    .where(eq(schema.engagements.id, id));
}

/** 診斷用：這一季有幾場交戰正在進行 */
export async function activeEngagementCount(tx: TxDb, seasonId: number): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.engagements)
    .where(
      and(eq(schema.engagements.seasonId, seasonId), isNull(schema.engagements.resolvedAt)),
    );
  return row?.n ?? 0;
}
