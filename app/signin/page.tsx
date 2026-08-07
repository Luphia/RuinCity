import Link from "next/link";
import { redirect } from "next/navigation";

import { auth, signIn } from "@/auth";
import { hasEmailProvider, hasGoogleProvider, usesDevMailbox } from "@/lib/env";

export const metadata = { title: "登入" };

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) redirect("/");

  const google = hasGoogleProvider();
  const email = hasEmailProvider();
  const devMailbox = usesDevMailbox();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-parchment text-2xl font-bold">登入 RuinCity</h1>
        <p className="text-ash text-sm leading-relaxed">
          賽季需要一個能收來襲警報、能在第 11 日報名下一場的真實身分，
          所以我們不做訪客帳號。
        </p>
      </div>

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
              className="border-ink-mid text-parchment hover:border-relic hover:text-relic w-full rounded border px-5 py-3 transition-colors"
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
              className="border-ink-mid bg-ink-soft text-parchment placeholder:text-ink-mid focus:border-relic rounded border px-4 py-3 outline-none"
            />
            <button
              type="submit"
              className="border-ink-mid text-parchment hover:border-relic hover:text-relic w-full rounded border px-5 py-3 transition-colors"
            >
              {devMailbox ? "產生登入連結" : "寄送登入連結"}
            </button>
            {devMailbox ? (
              <p className="text-ash-deep text-xs leading-relaxed">
                目前沒有設定 SMTP，連結會<b>印在跑 <code>pnpm dev</code> 的終端機上</b>
                ，不會真的寄出。要寄真的信就填 <code>EMAIL_SERVER</code> 與{" "}
                <code>EMAIL_FROM</code>。
              </p>
            ) : null}
          </form>
        ) : null}

        {!google && !email ? (
          <p className="border-alarm text-alarm rounded border border-dashed p-4 text-sm leading-relaxed">
            尚未設定任何登入方式。填入 <code>AUTH_GOOGLE_ID</code> 或{" "}
            <code>EMAIL_SERVER</code>。
            （開發模式下會自動提供「把連結印在終端機」的登入方式，
            這裡看到這段訊息代表現在跑的是 production build。）
          </p>
        ) : null}
      </div>

      <Link href="/" className="text-ash-deep hover:text-ash text-center text-sm">
        ← 回首頁
      </Link>
    </main>
  );
}
