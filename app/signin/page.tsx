import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";
import { IconArrowLeft, alarm, cta, field, ghost, glass, label } from "@/components/hud";
import { hasEmailProvider, hasGoogleProvider, usesDevMailbox } from "@/lib/env";

export const metadata = { title: "登入" };

/**
 * Auth.js 的錯誤碼 → 一句說得出「現在該做什麼」的中文。
 *
 * ★ `Configuration` 幾乎一定是 SMTP。Auth.js 把「設定有問題」與
 *   「寄信失敗」歸成同一碼，而在這個專案裡前者只有一種可能。
 */
const ERROR_TEXT: Record<string, string> = {
  Configuration:
    "寄送登入信失敗 —— 伺服器的 EMAIL_SERVER 設定有問題（帳密錯誤或連不上 SMTP）。" +
    "本機開發可以把 EMAIL_SERVER 與 EMAIL_FROM 整個拿掉，登入連結就會改印在終端機上。",
  AccessDenied: "這個帳號沒有登入權限。",
  Verification: "這個登入連結已經用過或過期了。重新要一個新的。",
  EmailSignin: "寄送登入信失敗。檢查 EMAIL_SERVER，或把它拿掉改用終端機模式。",
  OAuthSignin: "OAuth provider 連線失敗。",
  OAuthCallback: "OAuth 回呼失敗 —— 通常是 callback URL 與 AUTH_URL 對不上。",
  Default: "登入失敗。",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (session?.user) redirect("/");

  const google = hasGoogleProvider();
  const email = hasEmailProvider();
  const devMailbox = usesDevMailbox();

  const raw = (await searchParams).error;
  const code = Array.isArray(raw) ? raw[0] : raw;
  const errorText = code ? (ERROR_TEXT[code] ?? ERROR_TEXT.Default!) : null;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-4 px-4 py-10">
      <div className={`${glass} flex flex-col gap-6 p-6`}>
      <div className="flex flex-col gap-2">
        <div className={label}>RuinCity · 千年之後</div>
        <h1 className="text-2xl font-semibold text-white">登入</h1>
        <p className="text-sm leading-relaxed text-white/65">
          捐款需要一個能寄收據、能讓你之後改票的身分，所以我們不做訪客捐款。
        </p>
      </div>

      {errorText ? (
        <p className={`${alarm} leading-relaxed`}>
          {errorText}
          <span className="mt-2 block font-mono text-xs text-rose-200/60">error={code}</span>
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {google ? (
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className={`${ghost} w-full py-3`}
            >
              使用 Google 登入
            </button>
          </form>
        ) : null}

        {email ? (
          <form
            action={async (formData: FormData) => {
              "use server";
              await signIn("nodemailer", {
                email: String(formData.get("email") ?? ""),
                redirectTo: "/",
              });
            }}
            className="flex flex-col gap-2"
          >
            <input
              name="email"
              type="email"
              required
              placeholder="you@example.com"
              className={`${field} px-4 py-3`}
            />
            <button
              type="submit"
              className={`${cta} w-full py-3`}
            >
              {devMailbox ? "產生登入連結" : "寄送登入連結"}
            </button>
            {devMailbox ? (
              <p className="text-xs leading-relaxed text-white/50">
                目前沒有設定 SMTP，連結會<b>印在跑 <code className="text-sky-100">pnpm dev</code> 的終端機上</b>
                ，不會真的寄出。要寄真的信就填 <code className="text-sky-100">EMAIL_SERVER</code> 與{" "}
                <code className="text-sky-100">EMAIL_FROM</code>。
              </p>
            ) : null}
          </form>
        ) : null}

        {!google && !email ? (
          <p className={`${alarm} leading-relaxed`}>
            尚未設定任何登入方式。填入 <code className="text-sky-100">AUTH_GOOGLE_ID</code> 或{" "}
            <code className="text-sky-100">EMAIL_SERVER</code>。
            （開發模式下會自動提供「把連結印在終端機」的登入方式，
            這裡看到這段訊息代表現在跑的是 production build。）
          </p>
        ) : null}
      </div>

      </div>
      <Link href="/" className="inline-flex items-center justify-center gap-1 text-sm text-white/55 transition hover:text-white">
        <IconArrowLeft /> 回首頁
      </Link>
    </main>
  );
}
