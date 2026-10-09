import { glass } from "@/components/hud";

export const metadata = { title: "檢查你的信箱" };

export default function CheckEmailPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10">
      <div className={`${glass} flex flex-col gap-2 p-6 text-center`}>
        <h1 className="text-2xl font-semibold text-white">檢查你的信箱</h1>
        <p className="text-sm leading-relaxed text-white/65">登入連結已寄出。連結有效期 24 小時，只能使用一次。</p>
      </div>
    </main>
  );
}
