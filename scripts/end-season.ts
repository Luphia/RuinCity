/**
 * 強制結束賽季。
 *
 *   pnpm end:season                  # 結束目前這一場（推進到 ENDING：凍結 + 結算）
 *   pnpm end:season --archive        # 一路歸檔（ARCHIVED），下一場可以立刻開
 *   pnpm end:season --season 3       # 指定賽季
 *   pnpm end:season --next           # 結束之後順便開下一場的登記
 *   pnpm end:season --dry            # 只印出會發生什麼，不寫任何東西
 *
 * ★ 要走 `pnpm end:season`，不是 `pnpm tsx scripts/end-season.ts`。
 *   這支腳本 import `lib/server/*`，而那裡的 `import "server-only"`
 *   在 Node 底下解不開 —— `pnpm end:season` 帶了 `--tsconfig tsconfig.scripts.json`。
 *
 * ## ★ 為什麼不是「把 status 改成 ENDING」就好
 *
 * 賽季的階段是**由時間戳推導**的（`phaseAt`），而 `seasons.status`
 * 只是那個推導結果的快取（`docs/11` §20.9）。更要命的是：
 * 整條時間軸只由**一個**欄位推出來 —— `registrationOpensAt`
 * （見 `scheduleOf`）。
 *
 *   registrationOpensAt
 *     +3 天   → 登記截止
 *     +12 小時 → T = 0 開賽
 *     +12 天   → 結束
 *     +12 小時 → 歸檔
 *
 * 所以只 UPDATE status 的話，下一次 `advanceSeasons`（每分鐘一次）
 * 會照時間戳重新推導，發現「現在明明還在 RUNNING」，
 * 然後把它**推回去**。症狀是「我明明結束了它，一分鐘後又活過來」。
 *
 * 正確的做法是**把時間軸往回推**，讓推導本身得到你要的答案 ——
 * 這與 `seed-season.ts` 是同一招（那支往回推是為了讓它開賽）。
 *
 * ★ I/O 與 `process.env` 都留在這一層。
 */

// ★ 一定要是第一個 import（理由見該檔案）
import "./load-env";

import { desc, eq, ne } from "drizzle-orm";

import { PHASE_DURATION } from "../lib/game/season";
import { schema } from "../lib/db";
import { withTransaction } from "../lib/db/tx";
import { advanceSeasons, ensureNextSeason, phaseOf, scheduleOf } from "../lib/server/season-ops";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
const has = (name: string) => process.argv.includes(`--${name}`);

/** 從 `registrationOpensAt` 到各階段的位移（與 `scheduleFrom` 同一份算術） */
const TO_ENDS =
  PHASE_DURATION.registrationMs + PHASE_DURATION.sealedMs + PHASE_DURATION.runningMs;
const TO_ARCHIVE = TO_ENDS + PHASE_DURATION.endingMs;

const iso = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 19);

async function main() {
  const archive = has("archive");
  const dry = has("dry");
  const explicit = arg("season");

  const now = Date.now();

  const db = (await import("../lib/db")).getDb();
  const rows = explicit
    ? await db
        .select()
        .from(schema.seasons)
        .where(eq(schema.seasons.id, Number(explicit)))
    : await db
        .select()
        .from(schema.seasons)
        .where(ne(schema.seasons.status, "ARCHIVED"))
        .orderBy(desc(schema.seasons.id))
        .limit(1);

  const season = rows[0];
  if (!season) {
    console.error(
      explicit
        ? `\n  找不到賽季 ${explicit}\n`
        : "\n  沒有進行中的賽季（全部都已歸檔）。要開一場：pnpm seed:season\n",
    );
    process.exit(1);
  }

  const before = scheduleOf(season);
  const players = await db
    .select({ id: schema.players.id, userId: schema.players.userId })
    .from(schema.players)
    .where(eq(schema.players.seasonId, season.id));
  const humans = players.filter((p) => p.userId !== null).length;

  const target = archive ? "ARCHIVED" : "ENDING";
  /**
   * 往回推到「剛好越過那條線」再多一分鐘 —— 不要推到很遠的過去：
   * `ensureNextSeason` 看的是 `registrationOpensAt + 7 天`，
   * 推太遠會讓「下一場」的開放時刻也跟著被判定成很久以前。
   */
  const opensAt = now - (archive ? TO_ARCHIVE : TO_ENDS) - 60_000;

  console.log(`\n  賽季 s${season.id} · 目前 ${season.status}（推導：${phaseOf(season, now)}）`);
  console.log(`  玩家 ${players.length} 位 —— 真人 ${humans}、AI ${players.length - humans}`);
  console.log("\n  ── 時間軸 ────────────────────────────────────────");
  console.log(`  登記開放   ${iso(before.registrationOpensAt)}  →  ${iso(opensAt)}`);
  console.log(`  T = 0      ${iso(before.startsAt)}  →  ${iso(opensAt + PHASE_DURATION.registrationMs + PHASE_DURATION.sealedMs)}`);
  console.log(`  結束       ${iso(before.endsAt)}  →  ${iso(opensAt + TO_ENDS)}`);
  console.log(`  歸檔       ${iso(before.archivesAt)}  →  ${iso(opensAt + TO_ARCHIVE)}`);
  console.log(`\n  → 推導階段會變成 **${target}**`);

  if (dry) {
    console.log("\n  --dry：什麼都沒有寫入。\n");
    return;
  }

  await withTransaction(async (tx) => {
    /**
     * 兩個欄位一起改：
     * - `registrationOpensAt` 是**推導的來源**（真正決定階段的那一個）
     * - `endsAt` 是給 UI 讀的快取（`app/actions/season.ts` 的看板）
     *   不同步的話畫面會顯示一個早就過去的倒數
     */
    await tx
      .update(schema.seasons)
      .set({
        registrationOpensAt: new Date(opensAt),
        registrationClosesAt: new Date(opensAt + PHASE_DURATION.registrationMs),
        endsAt: new Date(opensAt + TO_ENDS),
        status: target,
      })
      .where(eq(schema.seasons.id, season.id));
  });

  // 走**正式的**推進路徑再確認一次 —— 與 cron 每分鐘做的事完全相同
  const summary = await withTransaction((tx) => advanceSeasons(tx, now));
  console.log(`\n  advanceSeasons：locked ${summary.locked} · started ${summary.started} · ended ${summary.ended}`);

  const [after] = await db.select().from(schema.seasons).where(eq(schema.seasons.id, season.id));
  console.log(`  賽季 s${season.id} 現在是 ${after?.status}（推導：${after ? phaseOf(after, now) : "?"}）`);

  if (has("next")) {
    const created = await withTransaction((tx) => ensureNextSeason(tx, now));
    console.log(created ? `  已開下一場：s${created}（登記中）` : "  下一場還沒到開放時間");
  }

  console.log(
    `\n  完成。${target === "ENDING" ? "終戰期 12 小時後自動歸檔；要立刻歸檔加 --archive。" : "已歸檔，下一場可以開了（--next 或 pnpm seed:season）。"}\n`,
  );
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error("\n  失敗：", e instanceof Error ? e.message : e, "\n");
    process.exit(1);
  },
);
