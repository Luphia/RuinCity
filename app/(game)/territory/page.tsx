import { TerritoryView } from "@/components/territory/TerritoryView";
import { buildFacility, claimTile, loadTerritory } from "@/app/actions/base";

export const metadata = { title: "領土 · RuinCity" };
export const dynamic = "force-dynamic";

export default async function TerritoryPage() {
  let board: Awaited<ReturnType<typeof loadTerritory>> | null = null;
  let error: string | null = null;

  try {
    board = await loadTerritory();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!board) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">領土</h1>
        <p className="mt-3 text-sm opacity-80">你還沒有進行中的賽季。</p>
        <p className="mt-4 rounded bg-[#2e2723] p-3 text-xs opacity-70">{error}</p>
      </main>
    );
  }

  return <TerritoryView board={board} onClaim={claimTile} onBuild={buildFacility} />;
}
