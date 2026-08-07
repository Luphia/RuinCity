import { WarView } from "@/components/war/WarView";
import { loadWarBoard, recallMarch, sendMarch } from "@/app/actions/war";

export const metadata = { title: "軍事 · RuinCity" };
export const dynamic = "force-dynamic";

export default async function WarPage() {
  let board: Awaited<ReturnType<typeof loadWarBoard>> | null = null;
  let error: string | null = null;

  try {
    board = await loadWarBoard();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!board) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">軍事</h1>
        <p className="mt-3 text-sm opacity-80">你還沒有進行中的賽季。</p>
        <p className="mt-4 rounded bg-[#2e2723] p-3 text-xs opacity-70">{error}</p>
      </main>
    );
  }

  return <WarView board={board} onSend={sendMarch} onRecall={recallMarch} />;
}
