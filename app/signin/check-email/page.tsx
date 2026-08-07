export const metadata = { title: "檢查你的信箱" };

export default function CheckEmailPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 text-center">
      <h1 className="text-parchment text-2xl font-bold">檢查你的信箱</h1>
      <p className="text-ash text-sm leading-relaxed">
        登入連結已寄出。連結有效期 24 小時，只能使用一次。
      </p>
    </main>
  );
}
