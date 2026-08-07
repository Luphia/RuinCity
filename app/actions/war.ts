"use server";

/**
 * 軍事的 Server Actions：派兵、召回、戰報、來襲預警。
 *
 * ★ 驗證在 `lib/server/march-ops.ts`。這裡只解析「我是誰」——
 *   與 `base-ops.ts` 同一個結構。
 *
 * ★ 執政官**不會**呼叫這裡的任何東西。軍事是 `docs/18` §2 明列的禁區，
 *   而它的 `StewardAction` 型別裡根本沒有派兵這個 case。
 */

import { revalidatePath } from "next/cache";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import { parseArmy, type Army } from "@/lib/game/army";
import { DISPATCHABLE, type DispatchType } from "@/lib/game/dispatch";
import { warningVisibleAt } from "@/lib/game/march";
import { settleWithin } from "@/lib/server/player-state";
import { garrisonAt, recallMarchFor, sendMarchFor, type MarchResult } from "@/lib/server/march-ops";
import { serverNow } from "@/lib/time";

export type { MarchResult };

async function currentPlayerId(): Promise<number> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error("UNAUTHENTICATED");

  const { getDb } = await import("@/lib/db");
  const [row] = await getDb()
    .select({ playerId: schema.players.id })
    .from(schema.players)
    .innerJoin(schema.users, eq(schema.players.userId, schema.users.id))
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(and(eq(schema.users.email, email), eq(schema.seasons.status, "RUNNING")))
    .limit(1);

  if (!row) throw new Error("NO_PLAYER");
  return row.playerId;
}

/** 派兵 */
export async function sendMarch(
  type: string,
  toX: number,
  toY: number,
  army: unknown,
): Promise<MarchResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId, now);
    return sendMarchFor(
      tx,
      playerId,
      {
        type,
        fromX: state.baseX,
        fromY: state.baseY,
        toX,
        toY,
        army: parseArmy(army),
      },
      now,
    );
  });

  if (result.ok) {
    revalidatePath("/war");
    revalidatePath("/base");
  }
  return result;
}

/** 召回一支還在路上的部隊 */
export async function recallMarch(marchId: number): Promise<MarchResult> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  const result = await withTransaction((tx) => recallMarchFor(tx, playerId, marchId, now));
  if (result.ok) revalidatePath("/war");
  return result;
}

// ─────────────────────────────────────────────────────────────
// 看板
// ─────────────────────────────────────────────────────────────

export interface MarchView {
  readonly id: number;
  readonly type: string;
  readonly toX: number;
  readonly toY: number;
  readonly army: Army;
  readonly arrivesAt: number;
  readonly canRecall: boolean;
}

export interface IncomingView {
  readonly id: number;
  readonly toX: number;
  readonly toY: number;
  readonly arrivesAt: number;
  /** 預警什麼時候開始可見 —— 之前一律不顯示 */
  readonly visibleAt: number;
  /** 只有粗略規模，不是精確數字 */
  readonly scale: "SMALL" | "MEDIUM" | "LARGE";
}

export interface ReportView {
  readonly id: number;
  readonly marchType: string;
  readonly outcome: string;
  readonly atX: number;
  readonly atY: number;
  readonly attacking: boolean;
  readonly at: number;
  readonly snapshot: Record<string, unknown>;
}

export interface WarBoard {
  readonly baseX: number;
  readonly baseY: number;
  readonly garrison: Army;
  readonly outgoing: readonly MarchView[];
  readonly incoming: readonly IncomingView[];
  readonly reports: readonly ReportView[];
  readonly serverTime: number;
  readonly types: readonly DispatchType[];
}

export async function loadWarBoard(): Promise<WarBoard> {
  const playerId = await currentPlayerId();
  const now = await serverNow();

  return withTransaction(async (tx) => {
    const state = await settleWithin(tx, playerId, now);
    const garrison = await garrisonAt(tx, state.seasonId, playerId, state.baseX, state.baseY);

    const outgoingRows = await tx
      .select()
      .from(schema.marches)
      .where(
        and(eq(schema.marches.ownerId, playerId), eq(schema.marches.status, "IN_TRANSIT")),
      )
      .orderBy(schema.marches.arrivesAt);

    /**
     * ★ 來襲預警是**比例制**的（`docs/04` §3）：遠方來的敵人你看得早，
     *   隔壁鄰居的突襲幾乎是瞬間的。所以這裡要用 `warningVisibleAt`
     *   過濾，不能直接把所有在路上的敵軍都列出來 ——
     *   那等於送給守方一份完美情報。
     *
     * ★ 偵查**不觸發預警**（`docs/04` §4）。
     */
    const incomingRows = await tx
      .select()
      .from(schema.marches)
      .where(
        and(
          eq(schema.marches.seasonId, state.seasonId),
          eq(schema.marches.status, "IN_TRANSIT"),
          eq(schema.marches.toX, state.baseX),
          eq(schema.marches.toY, state.baseY),
          gt(schema.marches.arrivesAt, new Date(now)),
          sql`${schema.marches.type} in ('RAID', 'ATTACK')`,
        ),
      );

    const hasWatchtower = state.tiles.some(
      (t) => t.facility === "WATCHTOWER" && t.state !== "ISOLATED",
    );

    const incoming: IncomingView[] = incomingRows.flatMap((m) => {
      if (m.ownerId === playerId) return [];
      const visibleAt = warningVisibleAt(
        m.departedAt.getTime(),
        m.arrivesAt.getTime(),
        hasWatchtower,
      );
      if (visibleAt > now) return [];
      const size = Object.values(parseArmy(m.units)).reduce((s, n) => s + (n ?? 0), 0);
      return [
        {
          id: m.id,
          toX: m.toX,
          toY: m.toY,
          arrivesAt: m.arrivesAt.getTime(),
          visibleAt,
          scale: size < 50 ? "SMALL" : size < 300 ? "MEDIUM" : "LARGE",
        },
      ];
    });

    const reportRows = await tx
      .select()
      .from(schema.battleReports)
      .where(
        or(
          eq(schema.battleReports.attackerId, playerId),
          eq(schema.battleReports.defenderId, playerId),
        ),
      )
      .orderBy(desc(schema.battleReports.createdAt))
      .limit(30);

    return {
      baseX: state.baseX,
      baseY: state.baseY,
      garrison,
      outgoing: outgoingRows.map((m) => ({
        id: m.id,
        type: m.type,
        toX: m.toX,
        toY: m.toY,
        army: parseArmy(m.units),
        arrivesAt: m.arrivesAt.getTime(),
        canRecall: m.type !== "RETURN" && m.arrivesAt.getTime() > now,
      })),
      incoming,
      reports: reportRows.map((r) => ({
        id: r.id,
        marchType: r.marchType,
        outcome: r.outcome,
        atX: r.atX,
        atY: r.atY,
        attacking: r.attackerId === playerId,
        at: r.createdAt.getTime(),
        snapshot: (r.snapshot ?? {}) as Record<string, unknown>,
      })),
      serverTime: now,
      types: DISPATCHABLE,
    };
  });
}

// ─────────────────────────────────────────────────────────────
// 戰場重播
// ─────────────────────────────────────────────────────────────

export interface BattleReplay {
  readonly reportId: number;
  readonly atX: number;
  readonly atY: number;
  readonly marchType: string;
  readonly outcome: string;
  /** 我是攻方還是守方 —— 決定畫面上的敵我配色說明 */
  readonly viewerIsAttacker: boolean;
  readonly attacker: { army: Army; losses: Army };
  readonly defender: { army: Army; losses: Army };
}

/**
 * 讀一份戰報，整理成戰場重播的輸入。
 *
 * ★ 重播**只是戰報的另一種讀法**：armies 與 losses 全部來自 snapshot，
 *   seed 就是戰報 id —— 兩位當事人看到的是同一場戲，而戲的結局
 *   收斂到戰報的數字（`lib/game/battlefield.ts`）。這裡沒有任何計算。
 *
 * ★ 只有當事人看得到 —— 與戰報本身同一條授權規則。
 */
export async function loadBattleReplay(reportId: number): Promise<BattleReplay | null> {
  const playerId = await currentPlayerId();

  const { getDb } = await import("@/lib/db");
  const [r] = await getDb()
    .select()
    .from(schema.battleReports)
    .where(
      and(
        eq(schema.battleReports.id, reportId),
        or(
          eq(schema.battleReports.attackerId, playerId),
          eq(schema.battleReports.defenderId, playerId),
        ),
      ),
    )
    .limit(1);
  if (!r) return null;

  const s = (r.snapshot ?? {}) as Record<string, unknown>;
  if (s.kind !== "BATTLE") return null;

  const attacker = s.attacker as { sent?: unknown; losses?: unknown } | undefined;
  const defender = s.defender as { present?: unknown; losses?: unknown } | undefined;

  return {
    reportId: r.id,
    atX: r.atX,
    atY: r.atY,
    marchType: r.marchType,
    outcome: r.outcome,
    viewerIsAttacker: r.attackerId === playerId,
    attacker: {
      army: parseArmy(attacker?.sent ?? {}),
      losses: parseArmy(attacker?.losses ?? {}),
    },
    defender: {
      army: parseArmy(defender?.present ?? {}),
      losses: parseArmy(defender?.losses ?? {}),
    },
  };
}
