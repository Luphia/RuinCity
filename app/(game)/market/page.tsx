import { MarketView } from "@/components/market/MarketView";
import { acceptListing, cancelListing, createListing, loadBoard } from "@/app/actions/market";

export const metadata = { title: "集市 · RuinCity" };
export const dynamic = "force-dynamic";

export default async function MarketPage() {
  let board: Awaited<ReturnType<typeof loadBoard>> | null = null;
  let error: string | null = null;

  try {
    board = await loadBoard();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!board) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">集市</h1>
        <p className="mt-3 text-sm opacity-80">你還沒有進行中的賽季。</p>
        <p className="mt-4 rounded bg-[#2e2723] p-3 text-xs opacity-70">{error}</p>
      </main>
    );
  }

  return (
    <MarketView
      board={board}
      onCreate={createListing}
      onAccept={acceptListing}
      onCancel={cancelListing}
    />
  );
}
