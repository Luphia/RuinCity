import { SeasonBoardView } from "@/components/season/SeasonBoardView";
import { loadSeasonBoard, registerForSeason } from "@/app/actions/season";

/**
 * 賽季登記。**公開路由**，不在 `(game)` 群組下 ——
 * 還沒有據點的人（甚至還沒登入的人）本來就該看得到名額與公平性數字。
 */
export const metadata = { title: "賽季登記 · RuinCity" };
export const dynamic = "force-dynamic";

export default async function SeasonsPage() {
  let board: Awaited<ReturnType<typeof loadSeasonBoard>> = null;
  let error: string | null = null;

  try {
    board = await loadSeasonBoard();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!board) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">賽季登記</h1>
        <p className="mt-3 text-sm leading-relaxed opacity-80">
          目前沒有開放中的賽季。每 7 天會開一場新的 —— 結算迴圈會自動排上。
        </p>
        {error && <p className="mt-4 rounded bg-[#2e2723] p-3 text-xs opacity-70">{error}</p>}
      </main>
    );
  }

  return <SeasonBoardView board={board} onRegister={registerForSeason} />;
}
