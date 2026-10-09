/**
 * 排程施工（Vercel Cron 每分鐘一次；自架用 `pnpm worker`）。
 * 輪流替每一塊做一步，跑到時間上限為止；剩下的時間推進長期保存（`lib/server/archive.ts`）。
 */

import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { runArchiver } from "@/lib/server/archive";
import { runBuilder } from "@/lib/server/builder";
import { archiveDeps, builderDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: true, skipped: "no database" });
  const start = Date.now();
  const deps = await builderDeps(`cron-${randomUUID().slice(0, 8)}`);
  const r = await runBuilder(deps, { deadline: start + 35_000 });
  // 施工之後是保存：完工的塊打包成場景包，交給 Boltchain SwarmStorage
  const archive = await runArchiver(archiveDeps(), { deadline: start + 50_000 });
  return NextResponse.json({ ok: true, ...r, archive });
}
