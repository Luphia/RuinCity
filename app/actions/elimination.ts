"use server";

/**
 * 「我出局了嗎」。
 *
 * 出局的判準只有一個欄位（`players.eliminatedAt`，見 `docs/02` §3.1），
 * 所以這裡是一次很小的查詢 —— 但它擋在 `(game)` layout 的最前面，
 * 每一頁都會走到，因此刻意不碰 `settleWithin`（那個對出局者會丟例外）。
 */

import { eq } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { formatGameDate, toGameDate } from "@/lib/game/calendar";
import { currentPlayerByEmail } from "@/lib/server/current-player";

export interface Elimination {
  /** 離開那一刻的廢曆日期，給結束畫面用 */
  readonly at: string;
  /**
   * ★ 為什麼離開。兩者的後果相同，但畫面上不該是同一句話 ——
   *   「你的主城陷落了」與「你放棄了這場賽季」是兩件事。
   *   舊資料是 null，一律當作主城被打爆。
   */
  readonly reason: "KEEP_DESTROYED" | "ABANDONED";
}

export async function loadElimination(): Promise<Elimination | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;

  try {
    const me = await currentPlayerByEmail(email);
    if (!me?.eliminatedAt) return null;

    const { getDb } = await import("@/lib/db");
    const [season] = await getDb()
      .select({ startedAt: schema.seasons.startedAt })
      .from(schema.seasons)
      .where(eq(schema.seasons.id, me.seasonId));
    if (!season?.startedAt) return null;

    return {
      at: formatGameDate(toGameDate(season.startedAt.getTime(), me.eliminatedAt)),
      reason: me.exitReason === "ABANDONED" ? "ABANDONED" : "KEEP_DESTROYED",
    };
  } catch {
    /**
     * ★ 查不到就當作沒出局。
     *   這個查詢擋在每一頁前面，如果它自己壞掉就把所有人鎖在門外 ——
     *   而「資料庫抖了一下」不該等於「你的主城被拆了」。
     */
    return null;
  }
}
