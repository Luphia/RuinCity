import { z } from "zod";

/**
 * 環境變數的單一入口。
 *
 * 刻意**不在模組載入時就驗證** —— `next build` 與單元測試都不該
 * 因為缺少 DATABASE_URL 而失敗。呼叫 `serverEnv()` 時才檢查。
 */
const serverSchema = z.object({
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(1),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Invalid or missing environment variables: ${missing}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** 這一場是否設定了任何 OAuth provider —— 沒有的話登入頁只顯示 Email OTP */
export function hasGoogleProvider(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

/** 真的能寄信 */
export function hasSmtp(): boolean {
  return Boolean(process.env.EMAIL_SERVER && process.env.EMAIL_FROM);
}

/**
 * ★ 開發時沒有 SMTP 就把登入連結印在終端機上。
 *
 * 本機要玩一場賽季不該先去申請一組 Gmail app password ——
 * 那是「跑起來」與「玩得到」之間最沒有必要的一道牆。
 * 而繞過它的方式**不是**放寬驗證：magic link 仍然是 Auth.js 發的、
 * 仍然只能用一次、仍然會過期，只是投遞管道從 SMTP 換成 stdout。
 *
 * ★ `production` 一律關閉。不是因為印在 log 裡會被外部利用
 *   （那是伺服器端的輸出），而是因為「以為信寄出去了，其實沒有」
 *   在正式環境是災難 —— 沒設 SMTP 就該在登入頁明講沒設。
 */
export function usesDevMailbox(): boolean {
  return !hasSmtp() && process.env.NODE_ENV !== "production";
}

/** 登入頁該不該顯示 email 表單 */
export function hasEmailProvider(): boolean {
  return hasSmtp() || usesDevMailbox();
}
