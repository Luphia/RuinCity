"use server";

/**
 * 賽季登記的 Server Actions。
 *
 * ★ 這是玩家**唯一**在賽季開始前會用到的寫入路徑，
 *   而它與其他所有動作一樣：規則判斷全在 `/lib/game/season.ts` 的純函式，
 *   時間走 `serverNow()`，寫入在一個交易裡。
 */

import { revalidatePath } from "next/cache";
import { and, desc, eq, ne } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import {
  gameMonthOf,
  normaliseSquadCode,
  SPAWN_BANDS,
  type FactionId,
  type Phase,
  type SpawnBand,
} from "@/lib/game/season";
import { serverNow } from "@/lib/time";
import { phaseOf, registerFor, scheduleOf } from "@/lib/server/season-ops";

export interface QuotaView {
  readonly faction: FactionId;
  readonly band: SpawnBand;
  readonly capacity: number;
  readonly taken: number;
}

export interface MyRegistration {
  readonly faction: FactionId;
  readonly band: SpawnBand;
  readonly squadCode: string | null;
  /** 封盤後才有 */
  readonly assignedX: number | null;
  readonly assignedY: number | null;
  readonly playerId: number | null;
}

export interface SeasonBoard {
  readonly seasonId: number;
  readonly phase: Phase;
  readonly serverTime: number;
  readonly registrationOpensAt: number;
  readonly registrationClosesAt: number;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly gameMonth: number;
  readonly humanCount: number;
  readonly quotas: readonly QuotaView[];
  readonly mine: MyRegistration | null;
  /** 封盤後公布的五項公平性數字 */
  readonly fairness: unknown;
  readonly ruins: readonly { id: number; x: number; y: number }[];
  /** 已經在**別的**賽季裡了 —— 一個人同時只能在一場 */
  readonly lockedElsewhere: boolean;
  readonly signedIn: boolean;
}

async function currentUserId(): Promise<number | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;

  const { getDb } = await import("@/lib/db");
  const [row] = await getDb()
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  return row?.id ?? null;
}

/**
 * 最值得登記的那一場：優先還在收人的，其次是最近開的。
 *
 * ★ 兩場賽季會有幾天重疊（下一場在第 7 天就開放登記），
 *   所以「當前賽季」不是唯一的 —— 這個排序讓登記頁在重疊期
 *   自動指向「你還能報名的那一場」。
 */
export async function loadSeasonBoard(): Promise<SeasonBoard | null> {
  const now = await serverNow();
  const { getDb } = await import("@/lib/db");
  const db = getDb();

  const open = await db
    .select()
    .from(schema.seasons)
    .where(eq(schema.seasons.status, "REGISTRATION"))
    .orderBy(desc(schema.seasons.id))
    .limit(1);

  const season =
    open[0] ??
    (
      await db
        .select()
        .from(schema.seasons)
        .where(ne(schema.seasons.status, "ARCHIVED"))
        .orderBy(desc(schema.seasons.id))
        .limit(1)
    )[0];

  if (!season) return null;

  const schedule = scheduleOf(season);
  const userId = await currentUserId();

  const quotaRows = await db
    .select()
    .from(schema.seasonQuotas)
    .where(eq(schema.seasonQuotas.seasonId, season.id));

  let mine: MyRegistration | null = null;
  let lockedElsewhere = false;

  if (userId !== null) {
    const [row] = await db
      .select()
      .from(schema.seasonRegistrations)
      .where(
        and(
          eq(schema.seasonRegistrations.seasonId, season.id),
          eq(schema.seasonRegistrations.userId, userId),
        ),
      );
    if (row) {
      mine = {
        faction: row.faction as FactionId,
        band: row.spawnBand,
        squadCode: row.squadCode,
        assignedX: row.assignedX,
        assignedY: row.assignedY,
        playerId: row.playerId,
      };
    } else {
      const [other] = await db
        .select({ id: schema.seasonRegistrations.id })
        .from(schema.seasonRegistrations)
        .innerJoin(schema.seasons, eq(schema.seasonRegistrations.seasonId, schema.seasons.id))
        .where(
          and(
            eq(schema.seasonRegistrations.userId, userId),
            ne(schema.seasonRegistrations.seasonId, season.id),
            ne(schema.seasons.status, "ARCHIVED"),
          ),
        )
        .limit(1);
      lockedElsewhere = Boolean(other);
    }
  }

  return {
    seasonId: season.id,
    phase: phaseOf(season, now),
    serverTime: now,
    registrationOpensAt: schedule.registrationOpensAt,
    registrationClosesAt: schedule.registrationClosesAt,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    gameMonth: gameMonthOf(schedule, now),
    humanCount: season.humanCount,
    quotas: quotaRows
      .map((q) => ({
        faction: q.faction as FactionId,
        band: q.spawnBand,
        capacity: q.capacity,
        taken: q.taken,
      }))
      .sort((a, b) => a.faction - b.faction || SPAWN_BANDS.indexOf(a.band) - SPAWN_BANDS.indexOf(b.band)),
    mine,
    fairness: season.fairnessReport ?? null,
    ruins: (season.ruinPositions ?? []) as SeasonBoard["ruins"],
    lockedElsewhere,
    signedIn: userId !== null,
  };
}

export interface RegisterResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export async function registerForSeason(input: {
  seasonId: number;
  faction: number;
  band: string;
  squadCode?: string | null;
}): Promise<RegisterResult> {
  const userId = await currentUserId();
  if (userId === null) return { ok: false, reason: "UNAUTHENTICATED" };

  const now = await serverNow();
  const squadCode = input.squadCode ? normaliseSquadCode(input.squadCode) : null;
  if (input.squadCode && squadCode === null) return { ok: false, reason: "BAD_SQUAD_CODE" };

  try {
    const r = await withTransaction((tx) =>
      registerFor(
        tx,
        input.seasonId,
        userId,
        { faction: input.faction, band: input.band, squadCode },
        now,
      ),
    );
    revalidatePath("/seasons");
    return { ok: r.ok, reason: typeof r.reason === "string" ? r.reason : undefined };
  } catch {
    /**
     * ★ 抓得住的只有一種情形：`CHECK (taken <= capacity)`。
     *   兩個人同時搶最後一個名額時，輸的那個會走到這裡 ——
     *   對他來說結果就是「額滿了」，不是系統錯誤。
     */
    return { ok: false, reason: "QUOTA_FULL" };
  }
}
