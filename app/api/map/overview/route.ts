/**
 * 地圖總覽：賽季的靜態世界資料。
 *
 * 地形 chunk 本身是靜態檔（`/terrain/{seasonId}/{cx}_{cy}.bin`，見 `docs/01` §3.2），
 * 走 CDN 長期快取，不經過這個路由。這裡只回傳「一次就夠」的中繼資料：
 * 三座遺跡、陣營面積、公平性驗證數字、以及出生點。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { MAP } from "@/lib/game/balance";
import type { KeepTier } from "@/lib/game/keep-icon";
import { pickMapSeason } from "@/lib/game/map-season";
import type { MapBattle } from "@/lib/server/map-battles";
import { CHUNK_COLS, CHUNK_ROWS, CHUNK_SIZE } from "@/lib/render/chunks";

/** `pnpm map:generate` 產的開發地圖。沒有真實賽季時的退路 */
const FALLBACK_SEASON = "s0";

/**
 * ★ 不能寫死 `s0`。
 *
 * M5b 之後每一場賽季都有自己的 seed 與自己的地形檔（封盤期寫出，
 * 見 `lib/server/terrain-files.ts`）。指著 `s0` 的話，玩家在 `/map` 看到的是
 * 一張跟自己那一局完全無關的地圖 —— 連自己的據點都不在上面，
 * 而且畫面上不會有任何跡象顯示看錯了。
 *
 * ★★ 也不能是「最新的那一場」。
 *
 * 下一場在第 7 天就開放登記（`ensureNextSeason`），而**那一場還沒有地圖**
 * —— 地形是封盤時才生成的。取最新的話，賽季走到第 7 天，
 * 所有還在打的人的地圖會突然換成 `s0` 開發地圖：
 * 自己的據點、領土、行軍全部畫在一張無關的地形上，
 * 而 `s0` 不存在的部署（`public/terrain` 沒進映像檔）直接 404 →
 * 畫面變成「地圖載入失敗」。這不是邊界情況，它會準時發生在每一位玩家身上。
 *
 * 正確的判準是**這位觀看者現在在哪一場裡**：
 *
 *   1. 明確指定 → 照做（開發與除錯用）
 *   2. 這位觀看者的 player 所在的那一場 —— 由 `lib/server/current-player.ts`
 *      解析，**與遊戲其他每一頁同一份實作**（出局的也算，他要看的仍是那張圖）
 *   3. 沒登入／不在任何一場 → 最新的**有地圖**的一場（RUNNING/ENDING/SEALED）
 *   4. 都沒有 → 開發地圖
 *
 * 而**有賽季的人永遠不會退回開發地圖**：拿不到自己那一場的地形就回 404。
 */
async function resolveSeason(
  explicit: string | null,
): Promise<{ seasonId: string; viewerSeason: string | null }> {
  try {
    const { getDb, schema } = await import("@/lib/db");
    const { desc, ne } = await import("drizzle-orm");
    const db = getDb();

    /**
     * ★ 「我在哪一場」與遊戲其他每一頁**走同一份實作**
     *   （`lib/server/current-player.ts`）。這一點不能為了少一次 join 而放棄：
     *   地圖與據點對同一位玩家給出不同的賽季，就是「開錯賽季地圖」。
     */
    const { currentPlayer } = await import("@/lib/server/current-player");
    const me = await currentPlayer();
    const viewerSeason = me ? `s${me.seasonId}` : null;
    if (explicit) return { seasonId: explicit, viewerSeason };

    const seasons = await db
      .select({ id: schema.seasons.id, status: schema.seasons.status })
      .from(schema.seasons)
      .where(ne(schema.seasons.status, "ARCHIVED"))
      .orderBy(desc(schema.seasons.id))
      .limit(10);

    return {
      seasonId: pickMapSeason(
        null,
        me ? { id: me.seasonId, status: me.seasonStatus } : null,
        seasons,
        FALLBACK_SEASON,
      ),
      viewerSeason,
    };
  } catch {
    // 沒有資料庫的環境（E2E、預覽）就用開發地圖
  }
  return { seasonId: explicit ?? FALLBACK_SEASON, viewerSeason: null };
}

/** 每次請求都要問資料庫「現在是哪一場」，所以不能整路由靜態化 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const explicit = new URL(request.url).searchParams.get("season");
  const { seasonId, viewerSeason } = await resolveSeason(explicit);
  if (!/^[a-z0-9-]{1,32}$/.test(seasonId)) {
    return NextResponse.json({ error: "invalid season id" }, { status: 400 });
  }

  const load = async (id: string) => {
    const raw = await readFile(join(process.cwd(), "public", "terrain", id, "meta.json"));
    return JSON.parse(raw.toString()) as Record<string, unknown>;
  };

  let meta: Record<string, unknown> | null = null;
  let resolved = seasonId;
  let chunkBaseUrl = `/terrain/${seasonId}`;
  try {
    meta = await load(seasonId);
  } catch {
    /**
     * 磁碟上沒有（新實例、唯讀檔案系統）→ 問資料庫。
     * `terrain_files` 是地形的真相（封盤時入庫，啟動時 `ensureLatestTerrain`
     * 會補磁碟快取）；還在補的空窗期，chunk 直接走 `/api/terrain`。
     */
    try {
      const numeric = /^s(\d+)$/.exec(seasonId)?.[1];
      if (numeric) {
        const { getDb, schema } = await import("@/lib/db");
        const { and, eq } = await import("drizzle-orm");
        const [row] = await getDb()
          .select({ data: schema.terrainFiles.data })
          .from(schema.terrainFiles)
          .where(
            and(
              eq(schema.terrainFiles.seasonId, Number(numeric)),
              eq(schema.terrainFiles.name, "meta.json"),
            ),
          )
          .limit(1);
        if (row) {
          meta = JSON.parse(Buffer.from(row.data).toString()) as Record<string, unknown>;
          chunkBaseUrl = `/api/terrain/${seasonId}`;
        }
      }
    } catch {
      // 沒有資料庫的環境（E2E、預覽）—— 往下走磁碟的退路
    }

    /**
     * 資料庫也沒有 → 退回開發地圖。
     *
     * ★★ 但**只給沒有賽季的訪客**。一位真的在打的玩家拿到另一場的地形，
     *   就是「開錯賽季地圖」：他的據點、領土、行軍會畫在一個
     *   跟他無關的世界上，而畫面上只有一行小字說明。
     *   對他來說**報錯比換一張圖誠實** —— 而且地形本來就補得回來
     *   （`ensureLatestTerrain` 會以 seed 重新生成）。
     */
    if (!meta) {
      const missing = NextResponse.json(
        { error: `賽季 ${seasonId} 的地形尚未生成，執行 pnpm map:generate` },
        { status: 404 },
      );
      if (explicit || seasonId === FALLBACK_SEASON) return missing;
      if (viewerSeason === seasonId) return missing;
      try {
        meta = await load(FALLBACK_SEASON);
        resolved = FALLBACK_SEASON;
        chunkBaseUrl = `/terrain/${FALLBACK_SEASON}`;
      } catch {
        return missing;
      }
    }
  }
  const isFallback = resolved !== seasonId;

  /**
   * ★ 交戰標示:戰鬥地點全賽季公開(烽火全世界看得到)。
   *   `fresh` = 還在觀戰窗口內(脈動紅 ✕、點進去可以看重播);
   *   窗口過了的殘跡再留 6 小時 —— 「這一帶最近打得兇」本身就是
   *   值得繞路的情報。只給座標與戰報 id,數字帳目仍然只有當事人看得到。
   *
   *   ★ 查詢實作在 `lib/server/map-battles.ts`，與輪詢用的
   *   `/api/map/battles` **共用同一份** —— 兩邊各寫一份的話，
   *   遲早分岔成「開圖說有仗、輪詢說沒有」，而畫面會在兩者之間閃。
   */
  let battles: MapBattle[] = [];
  /** 每座主城的城牆段（`spawns` 的座標是封盤時寫死的，城牆卻是活的） */
  let wallTiers = new Map<string, KeepTier>();
  let serverTime = Date.now();
  const numericSeason = /^s(\d+)$/.exec(seasonId)?.[1];
  if (numericSeason) {
    try {
      const { serverNow } = await import("@/lib/time");
      const { loadKeepWallTiers, loadMapBattles } = await import("@/lib/server/map-battles");
      serverTime = await serverNow();
      battles = await loadMapBattles(Number(numericSeason), serverTime);
      wallTiers = await loadKeepWallTiers(Number(numericSeason));
    } catch {
      // 沒有資料庫的環境(E2E、預覽)就沒有烽火，城牆一律退回第 1 段
      battles = [];
      wallTiers = new Map();
    }
  }

  const spawns = (Array.isArray(meta.spawns) ? meta.spawns : []) as {
    x: number;
    y: number;
  }[];

  return NextResponse.json(
    {
      seasonId: resolved,
      /** true = 這不是你那一局的地圖，是開發用的替代品 */
      isFallback,
      requestedSeason: seasonId,
      /**
       * ★ 這位觀看者自己那一場（沒有就是 null）。
       *   客戶端拿它與 `seasonId` 對一次帳 —— 伺服器已經保證了，
       *   但「開錯賽季地圖」的代價高到值得在畫面上再擋一層。
       */
      viewerSeason,
      seed: meta.seed,
      width: MAP.width,
      height: MAP.height,
      chunk: { size: CHUNK_SIZE, cols: CHUNK_COLS, rows: CHUNK_ROWS },
      chunkBaseUrl,
      terrainCodes: meta.terrainCodes,
      ruins: meta.ruins,
      areas: meta.areas,
      fairness: meta.fairness,
      /** ★ 出生點多帶一個**城牆段**（1–3）—— 地圖上那一眼要回答的是
          「我打得下來嗎」，而那是城牆的事，不是主堡的事 */
      spawns: spawns.map((s) => ({ ...s, wallTier: wallTiers.get(`${s.x},${s.y}`) ?? 1 })),
      battles,
      /** ★ 交戰動畫的下架時刻要跟伺服器的鐘比，不信任客戶端時鐘的絕對值 */
      serverTime,
    },
    {
      headers: {
        /**
         * 地形檔本身走長期快取；這份中繼資料會隨賽季換人，只快取一分鐘。
         *
         * ★ 交戰與城牆會在這一分鐘裡變舊 —— 那是刻意的分工：
         *   會變的那一份由 `/api/map/battles` 十幾秒輪詢一次（不快取），
         *   開圖這一次只要有個起點。快取整份總覽換得的是 CDN 命中，
         *   而總覽裡最貴的是地形中繼資料，不是烽火。
         */
        "Cache-Control": "public, max-age=60, stale-while-revalidate=600",
      },
    },
  );
}
