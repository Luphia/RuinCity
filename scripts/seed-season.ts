/**
 * 一鍵開一場可以真的走進去玩的賽季。
 *
 *   pnpm seed:season                            # 立刻開賽（T = 0 就是現在）
 *   pnpm seed:season you@example.com            # 順便把自己放進去
 *   pnpm seed:season --seed 99991
 *   pnpm seed:season --me you@example.com --faction 2 --band FRONTIER
 *   pnpm seed:season --phase REGISTRATION       # 只開登記，不封盤
 *
 * ★ 要走 `pnpm seed:season`，不是 `pnpm tsx scripts/seed-season.ts`。
 *   這支腳本會 import `lib/server/*`，而那裡的 `import "server-only"`
 *   在 Node 底下解不開（Next 是用內建 alias 解掉的）。
 *   `pnpm seed:season` 帶了 `--tsconfig tsconfig.scripts.json`，把它指到替身。
 *
 * ## ★ 為什麼需要這支腳本
 *
 * 賽季的正常生命週期是「登記 3 天 → 封盤 12 小時 → 開賽」，
 * 由結算迴圈按時間推進。開發時沒有人要等三天 ——
 * 這支腳本把時間軸往回推，讓 `advanceSeasons` 認為現在就該開賽了，
 * 然後走**完全相同**的 `lockdownSeason` / `startSeason` 路徑。
 *
 * 沒有任何一行是「開發用捷徑」：如果這支腳本開出來的賽季能玩，
 * 那正式排程開出來的也能玩。
 *
 * ★ I/O 與 `process.env` 都留在這一層。
 */

// ★ 一定要是第一個 import。`next dev` 會自動讀 .env.local，tsx 不會，
//   而且 import 會先於任何語句求值 —— 理由見該檔案
import "./load-env";

import { and, eq, isNull, ne } from "drizzle-orm";

import { hashSeed } from "../lib/game/rng";
import { formatFairness } from "../lib/game/map/fairness";
import { PHASE_DURATION, SPAWN_BANDS, type FactionId } from "../lib/game/season";
import { getDb, schema } from "../lib/db";
import { withTransaction } from "../lib/db/tx";
import {
  createSeason,
  lockdownSeason,
  registerFor,
  scheduleOf,
  startSeason,
} from "../lib/server/season-ops";
import { ensureGameUser } from "../lib/server/account";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/**
 * `--me you@example.com`，或直接把 email 丟在後面。
 *
 * ★ 位置參數看起來是多餘的貼心，但它擋掉一個很難察覺的失敗：
 *   忘了打 `--me` 時，腳本會**成功**開出一場沒有你的賽季 ——
 *   沒有錯誤訊息，只是打開 `/base` 之後說「你還沒有進行中的賽季」。
 */
function emailArg(): string | undefined {
  const flagged = arg("me");
  if (flagged) return flagged;
  return process.argv.slice(2).find((a) => !a.startsWith("--") && a.includes("@"));
}

const log = (m: string) => console.log(`  · ${m}`);

async function main() {
  if (!process.env.DATABASE_URL) {
    /**
     * ★ 不要只說「去複製 .env.example」—— 那個檔案曾經被 `.gitignore`
     *   的 `.env*` 吃掉，剛 clone 下來的人根本沒有它。訊息要能自己站得住。
     */
    console.error(
      [
        "需要 DATABASE_URL。這支腳本只要這一個變數。",
        "",
        "  cp .env.example .env.local     # 沒有這個檔案的話直接建 .env.local",
        "  # 填入 Neon 的連線字串：",
        '  DATABASE_URL="postgresql://user:pass@host.neon.tech/db?sslmode=require"',
        "",
        "資料表還沒建的話：pnpm db:migrate",
      ].join("\n"),
    );
    process.exit(1);
  }

  const rawSeed = arg("seed", String(Date.now() % 2 ** 31))!;
  const seed = /^\d+$/.test(rawSeed) ? Number(rawSeed) : hashSeed(rawSeed);
  const phase = (arg("phase", "RUNNING") ?? "RUNNING").toUpperCase();
  const email = emailArg();
  const faction = Number(arg("faction", "1")) as FactionId;
  const band = (arg("band", "HEARTLAND") ?? "HEARTLAND").toUpperCase();

  if (!SPAWN_BANDS.includes(band as never)) {
    console.error(`--band 只能是 ${SPAWN_BANDS.join(" | ")}`);
    process.exit(1);
  }

  const now = Date.now();

  /**
   * ★ 把登記開放時間往回推，讓「現在」剛好落在目標階段。
   *   賽季內部的所有時間戳都是從 `registrationOpensAt` 推導的
   *   （`scheduleFrom`），所以只要挑對這一個值，其餘全部自動對齊。
   */
  const back =
    phase === "REGISTRATION"
      ? PHASE_DURATION.registrationMs / 2
      : PHASE_DURATION.registrationMs + PHASE_DURATION.sealedMs;
  const opensAt = now - back;

  /**
   * ★ 先確認這個人報得進去，**再**開賽季。
   *
   *   反過來的話，「他已經在另一場裡」會在賽季建立之後才發現，
   *   留下一場半開的、沒有地圖的 REGISTRATION 賽季 ——
   *   而那正是 `/map` 曾經會去挑的那一場（`lib/game/map-season.ts`）。
   *   一個開發工具不該用一次失敗換掉所有人的地圖。
   */
  if (email) {
    const userId = await withTransaction((tx) => ensureGameUser(tx, email));
    const [busy] = await getDb()
      .select({ seasonId: schema.seasonRegistrations.seasonId })
      .from(schema.seasonRegistrations)
      .innerJoin(schema.seasons, eq(schema.seasonRegistrations.seasonId, schema.seasons.id))
      .where(
        and(
          eq(schema.seasonRegistrations.userId, userId),
          ne(schema.seasons.status, "ARCHIVED"),
          isNull(schema.seasonRegistrations.withdrawnAt),
        ),
      )
      .limit(1);
    if (busy) {
      console.error(
        `\n${email} 還在賽季 #${busy.seasonId} 裡，沒有開新賽季。\n` +
          `一位領主同時只能在一場（docs/13 §7 D1）。要換一場的話，\n` +
          `請他自己在 /seasons 按「放棄賽季 #${busy.seasonId}」—— ` +
          `那是玩家的路徑，這個腳本不是（docs/13 §8）。`,
      );
      process.exit(1);
    }
  }

  console.log(`\n開新賽季（seed ${seed}，目標階段 ${phase}）`);
  const seasonId = await withTransaction((tx) =>
    createSeason(tx, { seed, registrationOpensAt: opensAt }),
  );
  log(`season #${seasonId}`);

  // ── 把自己登記進去 ───────────────────────────────────────
  if (email) {
    const userId = await withTransaction((tx) => ensureGameUser(tx, email));

    // 登記期已經過了的話，用登記期中間的時刻送出 —— 走的仍是同一條驗證
    const at = phase === "REGISTRATION" ? now : opensAt + PHASE_DURATION.registrationMs / 2;
    const r = await withTransaction((tx) =>
      registerFor(tx, seasonId, userId, { faction, band }, at),
    );
    if (!r.ok) {
      console.error(`登記失敗：${r.reason}`);
      process.exit(1);
    }
    log(`${email} 已登記（陣營 ${faction} · ${band}）`);
  }

  if (phase === "REGISTRATION") {
    const [season] = await withTransaction((tx) =>
      tx.select().from(schema.seasons).where(eq(schema.seasons.id, seasonId)),
    );
    const s = scheduleOf(season!);
    console.log(`\n賽季 #${seasonId} 開放登記中，${new Date(s.registrationClosesAt).toISOString()} 截止`);
    console.log("結算迴圈（/api/cron/settle）會自動封盤與開賽。\n");
    return;
  }

  // ── 封盤：AI 補足 → 地圖生成 → 出生點 ──────────────────────
  console.log("\n封盤中（地圖生成約 7–20 秒）…");
  const lock = await withTransaction((tx) => lockdownSeason(tx, seasonId, { onProgress: log }));
  console.log(
    `\n真人 ${lock.humans} · AI ${lock.ai} · seed ${lock.seed}` +
      `（換了 ${lock.seedAttempts - 1} 次）· ${(lock.elapsedMs / 1000).toFixed(1)} 秒`,
  );
  if (lock.brokenSquads > 0) log(`⚠ ${lock.brokenSquads} 支小隊沒能整組放在一起`);

  const [sealed] = await withTransaction((tx) =>
    tx.select().from(schema.seasons).where(eq(schema.seasons.id, seasonId)),
  );
  if (sealed?.fairnessReport) {
    console.log("\n" + formatFairness(sealed.fairnessReport as never));
  }

  // ── T = 0 ────────────────────────────────────────────────
  console.log("\n開賽…");
  const start = await withTransaction((tx) => startSeason(tx, seasonId, now, { onProgress: log }));
  console.log(`寫入 ${start.players} 位玩家，T = 0 = ${new Date(start.startedAt).toISOString()}`);

  if (email) {
    const [me] = await withTransaction((tx) =>
      tx
        .select({
          x: schema.players.baseX,
          y: schema.players.baseY,
          band: schema.players.spawnBand,
          faction: schema.players.faction,
        })
        .from(schema.players)
        .innerJoin(schema.users, eq(schema.users.id, schema.players.userId))
        .where(and(eq(schema.players.seasonId, seasonId), eq(schema.users.email, email))),
    );
    if (me) {
      console.log(`\n${email} 的據點：(${me.x}, ${me.y}) · 陣營 ${me.faction} · ${me.band}`);
    }
  }

  console.log(`\n完成。pnpm dev 之後打開 /base 就能玩了。\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    /**
     * ★ Neon 的 WebSocket pool 連不上時丟的是一個 `ErrorEvent`，
     *   而它 `console.error` 出來只有 `{ type: 'error', timeStamp: 832 }` ——
     *   沒有訊息、沒有堆疊，看起來像程式壞了而不是連線壞了。
     */
    if (e && typeof e === "object" && !(e instanceof Error) && "type" in e) {
      console.error(
        "\n連不上資料庫。檢查 .env.local 的 DATABASE_URL —— " +
          "要是 Neon 的連線字串（`postgresql://…@…neon.tech/…?sslmode=require`）。",
      );
      console.error(e);
    } else {
      console.error(e);
    }
    process.exit(1);
  },
);
