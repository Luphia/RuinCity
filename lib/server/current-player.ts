import "server-only";

/**
 * 「我現在在哪一場賽季」——**唯一**的一份實作。
 *
 * ## ★ 為什麼這件事需要自己一個模組
 *
 * 這個問題在這個 app 裡被問了十次：據點、領土、軍事、集市、執政官、
 * HUD、地圖總覽、地圖個人圖層、單格戰場、出局判定。
 * 而在這一版之前，那十個地方各自寫了一次 SQL —— 於是也各自
 * **有自己的一組條件**：有的濾 `eliminatedAt`、有的不濾，
 * 有的只認 `RUNNING`，而地圖總覽甚至用的是完全不同的判準
 * （「最新的、還沒封存的那一場」）。
 *
 * 十份實作的必然結果是：**它們會對同一位玩家給出不同的答案**。
 * 那不是一個抽象的風險 —— 它已經發生過一次，症狀是
 * 「玩家的地圖畫的是另一場賽季的世界，而自己的據點標在上面」。
 *
 * 所以：**沒有人自己寫這段查詢。** 需要知道「我在哪一場」就呼叫這裡。
 *
 * ## 判準
 *
 * > 這個帳號在**還沒封存**的賽季裡的那一列 `players`，取最新的一場。
 *
 * 三個刻意的選擇：
 *
 * 1. **不是「最新的賽季」，是「我的那一場」。** 下一場第 7 天就開登記，
 *    而那時候我還在打這一場 —— 判準永遠從 `players` 出發，不從 `seasons`。
 * 2. **`ENDING` 也算。** 終戰期的賽季凍結但仍然是你的；
 *    只認 `RUNNING` 會讓最後兩天的每一頁都變成「你還沒有進行中的賽季」。
 * 3. **出局／放棄的人也回傳。** 他要看的仍然是那張地圖、那個結束畫面。
 *    寫入路徑的守門在 `settleWithin`（`PlayerEliminatedError`），
 *    不需要靠這裡擋 —— 在這裡擋掉只會讓出局畫面自己也查不到資料。
 */

import { and, desc, eq, ne } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";

export interface CurrentPlayer {
  readonly playerId: number;
  readonly seasonId: number;
  readonly seasonStatus: "REGISTRATION" | "SEALED" | "RUNNING" | "ENDING" | "ARCHIVED";
  readonly baseX: number;
  readonly baseY: number;
  /** null = 還在場上。出局或自願放棄都會有值（原因見 `exitReason`） */
  readonly eliminatedAt: number | null;
  readonly exitReason: string | null;
}

/**
 * 依 email 找出這個帳號的當前玩家。
 *
 * `db` 可以注入（整合測試跑在 PGlite 上，沒有全域連線）——
 * 省略時用全域的那一條。「誰在問」與「他在哪一場」是兩件事，
 * 所以身分解析不在這個函式裡。
 */
export async function currentPlayerByEmail(
  email: string,
  db?: TxDb,
): Promise<CurrentPlayer | null> {
  const client = db ?? (await import("@/lib/db")).getDb();
  const [row] = await client
    .select({
      playerId: schema.players.id,
      seasonId: schema.players.seasonId,
      seasonStatus: schema.seasons.status,
      baseX: schema.players.baseX,
      baseY: schema.players.baseY,
      eliminatedAt: schema.players.eliminatedAt,
      exitReason: schema.players.exitReason,
    })
    .from(schema.players)
    .innerJoin(schema.users, eq(schema.players.userId, schema.users.id))
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(and(eq(schema.users.email, email), ne(schema.seasons.status, "ARCHIVED")))
    // 同時在兩場是不該發生的（`docs/13` §7 D1），但真的發生時取最新那一場
    .orderBy(desc(schema.players.seasonId))
    .limit(1);

  if (!row) return null;
  return {
    playerId: row.playerId,
    seasonId: row.seasonId,
    seasonStatus: row.seasonStatus,
    baseX: row.baseX,
    baseY: row.baseY,
    eliminatedAt: row.eliminatedAt?.getTime() ?? null,
    exitReason: row.exitReason,
  };
}

/**
 * 目前登入者的玩家。沒登入、或還沒有據點就回 null。
 *
 * ★ `@/auth` 是**動態** import：靜態引入會把 next-auth 拉進每一個
 *   引用這個模組的地方，包括跑在 vitest 裡的整合測試 —— 而那裡沒有
 *   Next 的 runtime。「誰在問」與「他在哪一場」本來就該分得開。
 */
export async function currentPlayer(): Promise<CurrentPlayer | null> {
  const { auth } = await import("@/auth");
  const email = (await auth())?.user?.email;
  if (!email) return null;
  return currentPlayerByEmail(email);
}

/**
 * 還在場上的玩家（出局／放棄的回 null）。
 *
 * 給「要走進遊戲畫面嗎」這類問題用 —— 讀取路徑要的是 `currentPlayer`，
 * 因為出局的人仍然要看得到自己的世界。
 */
export async function currentLivePlayer(): Promise<CurrentPlayer | null> {
  const me = await currentPlayer();
  return me && me.eliminatedAt === null ? me : null;
}

/**
 * 寫入路徑的入口：拿不到就丟。
 *
 * 錯誤字串沿用原本各處的約定（`UNAUTHENTICATED` / `NO_PLAYER`），
 * 呼叫端的 catch 不用改。
 */
export async function requirePlayerId(): Promise<number> {
  const { auth } = await import("@/auth");
  const email = (await auth())?.user?.email;
  if (!email) throw new Error("UNAUTHENTICATED");
  const me = await currentPlayerByEmail(email);
  if (!me) throw new Error("NO_PLAYER");
  return me.playerId;
}
