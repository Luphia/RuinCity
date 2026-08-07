/**
 * 一鍵開一場可以真的走進去玩的賽季。
 *
 *   pnpm tsx scripts/seed-season.ts                       # 立刻開賽（T = 0 就是現在）
 *   pnpm tsx scripts/seed-season.ts --seed 99991
 *   pnpm tsx scripts/seed-season.ts --me you@example.com  # 順便把自己放進去
 *   pnpm tsx scripts/seed-season.ts --faction 2 --band FRONTIER
 *   pnpm tsx scripts/seed-season.ts --phase REGISTRATION  # 只開登記，不封盤
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

import { and, eq } from "drizzle-orm";

import { hashSeed } from "../lib/game/rng";
import { formatFairness } from "../lib/game/map/fairness";
import { PHASE_DURATION, SPAWN_BANDS, type FactionId } from "../lib/game/season";
import { schema } from "../lib/db";
import { withTransaction } from "../lib/db/tx";
import {
  createSeason,
  lockdownSeason,
  registerFor,
  scheduleOf,
  startSeason,
} from "../lib/server/season-ops";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const log = (m: string) => console.log(`  · ${m}`);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("需要 DATABASE_URL —— 先 cp .env.example .env.local 並填好");
    process.exit(1);
  }

  const rawSeed = arg("seed", String(Date.now() % 2 ** 31))!;
  const seed = /^\d+$/.test(rawSeed) ? Number(rawSeed) : hashSeed(rawSeed);
  const phase = (arg("phase", "RUNNING") ?? "RUNNING").toUpperCase();
  const email = arg("me");
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

  console.log(`\n開新賽季（seed ${seed}，目標階段 ${phase}）`);
  const seasonId = await withTransaction((tx) =>
    createSeason(tx, { seed, registrationOpensAt: opensAt }),
  );
  log(`season #${seasonId}`);

  // ── 把自己登記進去 ───────────────────────────────────────
  if (email) {
    const userId = await withTransaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email));
      if (existing) return existing.id;
      const [created] = await tx
        .insert(schema.users)
        .values({ email, provider: "email", displayName: email.split("@")[0]! })
        .returning({ id: schema.users.id });
      return created!.id;
    });

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
    console.error(e);
    process.exit(1);
  },
);
