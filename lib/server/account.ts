import "server-only";

import { eq } from "drizzle-orm";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";

/**
 * 目前登入者的**遊戲帳號** id，沒有就建一個。
 *
 * ## ★ 為什麼需要「沒有就建一個」
 *
 * 身分與帳號是兩張表：Auth.js 管 `auth_users`（text id，登入用），
 * 遊戲管 `users`（bigserial，跨賽季的傳承與頭銜），兩者以 email 對應。
 *
 * 而**沒有任何一段程式在第一次登入時建立 `users` 那一列** ——
 * 只有種子腳本會建。於是一位全新的玩家：
 *
 *   1. 收到 magic link、驗證成功、session 建好了
 *   2. 但 `users` 裡沒有他 → 應用層問「你是誰」得到 `null`
 *   3. 首頁顯示「登入」、`/seasons` 顯示「登入後才能登記」
 *   4. 點下去 → `/signin` 看到 session 存在 → 導回首頁
 *
 * 也就是**登入成功了，但整個 app 認為你沒登入，而且出不去這個迴圈**。
 * 症狀與「按了登入按鈕，然後回到同一頁」一模一樣，成因卻完全不同。
 *
 * 建立的時機刻意選在「第一次以登入身分存取」而不是 Auth.js 的
 * `events.signIn` —— 那個事件對**已經存在的 session** 不會補發，
 * 而這裡每一次都會自我修復。
 */
export async function currentGameUserId(): Promise<number | null> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return null;

  const { getDb } = await import("@/lib/db");
  const db = getDb();

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (existing) return existing.id;

  // 併發的兩個請求可能同時走到這裡 —— email 上有 unique，交給它裁決
  await db
    .insert(schema.users)
    .values({
      email,
      provider: "email",
      displayName: session?.user?.name || email.split("@")[0]!,
    })
    .onConflictDoNothing();

  const [created] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  return created?.id ?? null;
}

/** 交易內版本。種子腳本與測試用得到 */
export async function ensureGameUser(
  tx: TxDb,
  email: string,
  displayName?: string,
): Promise<number> {
  const [existing] = await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email));
  if (existing) return existing.id;

  const [created] = await tx
    .insert(schema.users)
    .values({ email, provider: "email", displayName: displayName || email.split("@")[0]! })
    .returning({ id: schema.users.id });
  return created!.id;
}
