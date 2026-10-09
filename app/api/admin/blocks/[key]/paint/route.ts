/**
 * 管理員：不經捐款直接把一塊蓋起來（`pnpm block:paint <區塊>` 打的就是這裡）。
 *
 * - `GET`  ：報價（要撥多少、預計還要付給模型多少），不寫任何東西。`?painter=openai` 照指定的畫師估
 *            —— 用的是與 POST 同一段撥款程式，在交易裡算完就回滾
 * - `POST` ：補足經費（平台撥款，見 `lib/server/grants.ts`）→ 施工到時間上限 → 回報進度。
 *            沒蓋完就再 POST 一次；每一次都會依最新的估價補差額
 *
 * ★ 只認 `Authorization: Bearer $CRON_SECRET`。沒設 CRON_SECRET 時**一律拒絕** ——
 *   排程路由沒設密碼可以開放（它只會推進已經付了錢的塊），這條會花平台的錢，不行。
 */

import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/tx";
import { usingFakeProviders } from "@/lib/providers/registry";
import type { BlockState } from "@/lib/server/blocks";
import { loadBlockState } from "@/lib/server/blocks";
import { runBlock } from "@/lib/server/builder";
import { apiSpentMicros, grantQuote, grantToBlock, remainingApiMicros } from "@/lib/server/grants";
import { builderDeps, db, stateDeps } from "@/lib/server/runtime";
import { KIND_LABEL, PAUSE_TEXT } from "@/lib/server/view";
import { STATUS_LABEL, formatTwd, formatUsd } from "@/lib/world/ledger";
import { MODEL_PROFILES, isPainterId } from "@/lib/world/pricing";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** 一次 POST 最多施工多久（留時間釋放租約、回應） */
const RUN_BUDGET_MS = 45_000;

function unauthorized(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "伺服器沒有設定 CRON_SECRET，管理員指令停用" }, { status: 503 });
  if (req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}

function report(s: BlockState, twdPerUsd: number) {
  const step = s.steps[s.done];
  const failed = s.log.findLast((l) => l.status === "FAILED");
  return {
    key: s.key,
    status: s.status,
    statusLabel: STATUS_LABEL[s.status],
    done: s.done,
    total: s.steps.length,
    next: step ? `${KIND_LABEL[step.kind] ?? step.kind}${step.kind === "SCENE" || step.kind === "TEXTURE" ? ` #${step.index + 1}` : ""}` : null,
    pauseReason: s.row?.pauseReason ? (PAUSE_TEXT[s.row.pauseReason] ?? s.row.pauseReason) : null,
    painter: s.tally.winner ? MODEL_PROFILES[s.tally.winner].displayName : null,
    granted: formatTwd(s.grantedMicros, twdPerUsd),
    grantNeeded: formatTwd(grantQuote(s), twdPerUsd),
    apiRemaining: formatUsd(remainingApiMicros(s)),
    apiSpent: formatUsd(apiSpentMicros(s)),
    fake: usingFakeProviders(),
    /** 最近一次失敗（暫停時就是暫停的原因） */
    lastError: failed
      ? {
          step: `${KIND_LABEL[failed.kind] ?? failed.kind}${failed.kind === "SCENE" || failed.kind === "TEXTURE" ? ` #${failed.kindIndex + 1}` : ""}`,
          code: failed.errorCode,
          message: failed.errorMessage,
        }
      : null,
  };
}

/** 報價用：跑完撥款就丟掉（交易回滾） */
type Report = ReturnType<typeof report>;
class DryRun extends Error {
  constructor(readonly quote: Report) {
    super("dry run");
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { key } = await params;
  const painter = new URL(req.url).searchParams.get("painter");
  if (painter !== null && !isPainterId(painter)) return NextResponse.json({ error: "painter 只能是 google 或 openai" }, { status: 400 });
  try {
    const deps = await stateDeps();
    const now = Date.now();
    const s = await loadBlockState(db(), key, now, deps);
    if (!s) return NextResponse.json({ error: `不是有效的區塊：${key}` }, { status: 400 });
    const current = report(s, deps.config.twdPerUsd);
    if (s.status === "COMPLETE") return NextResponse.json(current);
    // 照指定的畫師撥一次、看要多少，然後回滾
    try {
      await withTransaction(async (tx) => {
        const g = await grantToBlock(tx, { key, painter: isPainterId(painter) ? painter : null, resume: false, now, deps });
        if (!g.ok) throw new Error(g.reason);
        throw new DryRun({ ...report(g.state, deps.config.twdPerUsd), grantNeeded: formatTwd(g.grantedMicros, deps.config.twdPerUsd) });
      });
    } catch (e) {
      if (e instanceof DryRun) {
        // 狀態與進度報「現在」的，金額報「撥下去之後」的
        return NextResponse.json({ ...current, painter: e.quote.painter, grantNeeded: e.quote.grantNeeded, apiRemaining: e.quote.apiRemaining });
      }
      if (e instanceof Error && e.message === "PROVIDER_DISABLED") {
        return NextResponse.json({ error: "這一家模型沒有啟用（沒有設定它的 API 金鑰）" }, { status: 400 });
      }
      throw e;
    }
    return NextResponse.json(current);
  } catch (e) {
    console.error("[admin/paint]", e);
    return NextResponse.json({ error: "資料庫無法連線" }, { status: 503 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const denied = unauthorized(req);
  if (denied) return denied;
  const { key } = await params;
  const body = (await req.json().catch(() => ({}))) as { painter?: unknown; resume?: unknown };
  if (body.painter != null && !isPainterId(body.painter)) {
    return NextResponse.json({ error: `painter 只能是 google 或 openai` }, { status: 400 });
  }
  const start = Date.now();
  try {
    const deps = await builderDeps(`admin-${randomUUID().slice(0, 8)}`);
    const g = await withTransaction((tx) =>
      grantToBlock(tx, {
        key,
        painter: isPainterId(body.painter) ? body.painter : null,
        resume: body.resume === true,
        now: Date.now(),
        deps: deps.state,
      }),
    );
    if (!g.ok) {
      const text = {
        BAD_BLOCK: `不是有效的區塊：${key}`,
        OCEAN_OR_POLE: "極區的區塊不能畫",
        BLOCK_COMPLETE: "這一塊已經完成了",
        PROVIDER_DISABLED: "這一家模型沒有啟用（沒有設定它的 API 金鑰）",
      }[g.reason];
      return NextResponse.json({ error: text, reason: g.reason }, { status: g.reason === "BLOCK_COMPLETE" ? 409 : 400 });
    }
    const outcomes = await runBlock(deps, key, start + RUN_BUDGET_MS);
    const s = (await loadBlockState(db(), key, Date.now(), deps.state))!;
    return NextResponse.json({
      ...report(s, deps.state.config.twdPerUsd),
      grantedNow: g.grantedTwd > 0 ? formatTwd(g.grantedMicros, deps.state.config.twdPerUsd) : null,
      resumed: g.resumed,
      outcomes,
    });
  } catch (e) {
    console.error("[admin/paint]", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "施工失敗" }, { status: 500 });
  }
}
