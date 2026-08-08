/**
 * 伺服器啟動鉤子（Next.js instrumentation）。
 *
 * ★ 啟動時立刻確保**最新一季的地形檔**可用（`docs/01` §3.2）：
 *   磁碟有 → 無事；資料庫有 → 實體化到磁碟；都沒有 → 以賽季 seed
 *   重新生成並存入資料庫。少了這一步，每個新實例、每次重新部署，
 *   /map 都會退回開發地圖 —— 因為封盤時寫的檔案跟著舊容器蒸發了。
 *
 * ★ 不擋啟動：生成要 7–20 秒，讓伺服器先開門收請求 ——
 *   這段期間 /map 會誠實地顯示 fallback 橫幅，地形好了自然換過來。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  void (async () => {
    const { ensureLatestTerrain } = await import("@/lib/server/terrain-files");
    const how = await ensureLatestTerrain((line) => console.log(`[terrain] ${line}`));
    if (how !== "disk" && how !== "none") console.log(`[terrain] 啟動確保完成（${how}）`);
  })().catch((e) => {
    // 沒有資料庫的環境（E2E、build 預覽）走到這裡是正常的 —— 講一聲就好
    console.warn(`[terrain] 啟動確保跳過：${e instanceof Error ? e.message : e}`);
  });
}
