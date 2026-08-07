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
import { hasGoogleProvider } from "@/lib/env";

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

if (process.env.EMAIL_SERVER && process.env.EMAIL_FROM) {
  providers.push(
    Nodemailer({
      server: process.env.EMAIL_SERVER,
      from: process.env.EMAIL_FROM,
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
