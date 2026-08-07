import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth, { type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import Nodemailer from "next-auth/providers/nodemailer";

import { db } from "@/lib/db";
import {
  authAccounts,
  authSessions,
  authUsers,
  authVerificationTokens,
} from "@/lib/db/auth-schema";
import { hasGoogleProvider, hasSmtp, usesDevMailbox } from "@/lib/env";

/**
 * Auth.js v5。**不做訪客帳號** —— 只有 Google OAuth 與 Email OTP。
 *
 * 12 天的賽季需要一個能收推播、能在第 11 日報名下一場、
 * 能跨場延續傳承的真實身分。訪客帳號在這個結構下幾乎沒有價值。
 *
 * 註冊門檻的緩解方式是**讓登記頁本身就是註冊頁**：
 * 玩家在選陣營的同一個流程裡完成註冊，而不是先註冊再登記。
 */
const providers: NextAuthConfig["providers"] = [];

if (hasGoogleProvider()) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
  );
}

if (hasSmtp()) {
  providers.push(
    Nodemailer({
      server: process.env.EMAIL_SERVER!,
      from: process.env.EMAIL_FROM!,
    }),
  );
} else if (usesDevMailbox()) {
  /**
   * ★ 開發用的「信箱」＝ 終端機。
   *
   *   驗證流程一步都沒有少：token 仍由 Auth.js 產生、寫進
   *   `auth_verification_tokens`、只能用一次、會過期。
   *   換掉的只有投遞管道 —— `sendVerificationRequest` 不寄信，改印出來。
   *
   *   `jsonTransport` 是 nodemailer 的 no-op transport：provider 的型別
   *   要求一個 server，但我們覆寫了寄送，所以它永遠不會被用到，
   *   更不會去連任何一台 SMTP。
   */
  providers.push(
    Nodemailer({
      server: { jsonTransport: true },
      from: "RuinCity <dev@ruincity.local>",
      async sendVerificationRequest({ identifier, url }) {
        console.log(
          [
            "",
            "┌─ 登入連結（開發模式，沒有真的寄信）",
            `│  ${identifier}`,
            `│  ${url}`,
            "└─ 設定 EMAIL_SERVER 與 EMAIL_FROM 就會改走真的 SMTP",
            "",
          ].join("\n"),
        );
      },
    }),
  );
}

export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: authUsers,
    accountsTable: authAccounts,
    sessionsTable: authSessions,
    verificationTokensTable: authVerificationTokens,
  }),
  providers,
  session: { strategy: "database" },
  /**
   * Vercel 會自動偵測 host，但自架、Docker 與 E2E（127.0.0.1:3100）
   * 都需要顯式信任，否則 Auth.js 會擋下所有請求。
   * 生產環境務必同時設定 AUTH_URL，讓 callback URL 是固定的。
   */
  trustHost: true,
  pages: {
    signIn: "/signin",
    verifyRequest: "/signin/check-email",
  },
  callbacks: {
    session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
