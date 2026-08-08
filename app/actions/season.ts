"use server";

/**
 * 賽季登記的 Server Actions。
 *
 * ★ 這是玩家**唯一**在賽季開始前會用到的寫入路徑，
 *   而它與其他所有動作一樣：規則判斷全在 `/lib/game/season.ts` 的純函式，
 *   時間走 `serverNow()`，寫入在一個交易裡。
 */

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

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
import { currentGameUserId as currentUserId } from "@/lib/server/account";

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
  /**
   * ★ 卡住的話，出口在哪（`docs/13` §8）。
   *   有這個欄位畫面才有資格顯示「放棄那一場」——
   *   一條沒有出口的規則會把玩家關在門外整整 12 天。
   */
  readonly elsewhere: {
    readonly seasonId: number;
    /** true = 已經開打（放棄 = 據點與領地全沒了） */
    readonly running: boolean;
  } | null;
  readonly signedIn: boolean;
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
  let elsewhere: SeasonBoard["elsewhere"] = null;

  if (userId !== null) {
    const [row] = await db
      .select()
      .from(schema.seasonRegistrations)
      .where(
        and(
          eq(schema.seasonRegistrations.seasonId, season.id),
          eq(schema.seasonRegistrations.userId, userId),
          // 退出過的登記不算「我報名了」—— 畫面要回到可以重新報名的樣子
          isNull(schema.seasonRegistrations.withdrawnAt),
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
        .select({
          seasonId: schema.seasonRegistrations.seasonId,
          status: schema.seasons.status,
        })
        .from(schema.seasonRegistrations)
        .innerJoin(schema.seasons, eq(schema.seasonRegistrations.seasonId, schema.seasons.id))
        .where(
          and(
            eq(schema.seasonRegistrations.userId, userId),
            ne(schema.seasonRegistrations.seasonId, season.id),
            ne(schema.seasons.status, "ARCHIVED"),
            isNull(schema.seasonRegistrations.withdrawnAt),
          ),
        )
        .limit(1);
      lockedElsewhere = Boolean(other);
      if (other) {
        elsewhere = {
          seasonId: other.seasonId,
          running: other.status === "RUNNING" || other.status === "ENDING",
        };
      }
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
    elsewhere,
    signedIn: userId !== null,
  };
}

export interface EntryPoint {
  readonly signedIn: boolean;
  /** 有沒有一個正在進行的據點可以走進去 */
  readonly hasPlayer: boolean;
  /** 目前是以哪個身分登入的。★ 「沒有據點」最常見的原因就是登錯帳號 */
  readonly email: string | null;
  /** 已經登記、但賽季還沒開打 */
  readonly registered: boolean;
}

/**
 * 這位訪客現在該被送去哪裡。
 *
 * ★ 首頁與登入頁都要問這一題。「已經登入了還顯示登入按鈕」是
 *   同一類問題的另一面：**入口要反映狀態，不是永遠顯示同一組選項。**
 *
 * 只做一次 join，不跑結算 —— 首頁不該為了決定一個按鈕的文字
 *   去讀 600 位玩家的經濟狀態。
 */
export async function loadEntryPoint(): Promise<EntryPoint> {
  const session = await auth();
  const email = session?.user?.email ?? null;

  const userId = await currentUserId();
  if (userId === null) {
    return { signedIn: false, hasPlayer: false, email, registered: false };
  }

  const { getDb } = await import("@/lib/db");
  const db = getDb();

  const [player] = await db
    .select({ id: schema.players.id })
    .from(schema.players)
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(
      and(
        eq(schema.players.userId, userId),
        eq(schema.seasons.status, "RUNNING"),
        isNull(schema.players.eliminatedAt),
      ),
    )
    .limit(1);

  if (player) {
    return { signedIn: true, hasPlayer: true, email, registered: true };
  }

  /**
   * ★ 沒有據點時要分辨兩種完全不同的處境：
   *   「已登記，賽季還沒開打」 vs 「這個帳號根本不在任何一場裡」。
   *   前者只要等，後者要去登記 —— 或者，登錯帳號了。
   */
  const [reg] = await db
    .select({ id: schema.seasonRegistrations.id })
    .from(schema.seasonRegistrations)
    .innerJoin(schema.seasons, eq(schema.seasonRegistrations.seasonId, schema.seasons.id))
    .where(
      and(
        eq(schema.seasonRegistrations.userId, userId),
        ne(schema.seasons.status, "ARCHIVED"),
      ),
    )
    .limit(1);

  return { signedIn: true, hasPlayer: false, email, registered: Boolean(reg) };
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

export interface AbandonResultView {
  readonly ok: boolean;
  readonly reason?: string;
  /** true = 放棄的是一場已經開打的賽季（據點與領地都沒了） */
  readonly hadPlayer?: boolean;
}

/**
 * ★ 放棄目前這一場賽季（`docs/13` §8）。
 *
 * 這是「一位領主同時只能在一場」的出口。**不可逆**：
 * 據點被拆、領地回歸廢土、在途部隊解散 —— 與主城被打爆走的是
 * 同一份實作（`lib/server/leave-season.ts`）。
 *
 * 呼叫端必須先問過玩家。這個 action 自己不做二次確認 ——
 * 「要不要確認」是畫面的職責，而畫面上已經有一次不可逆的點擊。
 */
export async function abandonSeason(): Promise<AbandonResultView> {
  const userId = await currentUserId();
  if (userId === null) return { ok: false, reason: "UNAUTHENTICATED" };

  const now = await serverNow();
  const { abandonSeasonFor } = await import("@/lib/server/season-ops");
  const r = await withTransaction((tx) => abandonSeasonFor(tx, userId, now));

  revalidatePath("/seasons");
  revalidatePath("/base");
  revalidatePath("/map");
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, hadPlayer: r.hadPlayer };
}
