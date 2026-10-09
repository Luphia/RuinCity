/**
 * 施工引擎：一次做一步。**伺服器專用。**
 *
 * ## 一步的流程
 *
 *   1. 拿**租約**（有期限，不拿交易鎖）—— 一步要呼叫外部 API 幾十秒，
 *      不能抱著資料庫交易等；工作者當掉，租約逾時自動失效
 *   2. 讀狀態（`blocks.loadBlockState`，和頁面看到的是同一份）
 *   3. 還有下一步嗎？沒有 → 撥付保存費與分攤、標記完成
 *   4. 施工餘額夠下一步的估價 × 1.25 嗎？不夠 → 等錢
 *   5. **此刻**排名最前、做得了這一步的那一家 → 畫
 *   6. 成功失敗都記一列 `steps`（帳由它加總），成功的話存產出
 *
 * ★ 第 5 步是「建設過程會不停切換模型」的來源：每一步開工才計票，
 *   兩步之間進來一筆大額捐款投給別家，下一步就換人畫。
 *
 * ★ 失敗的那一次照樣記帳：上游可能已經收了輸入 token，參考影像也已經抓了。
 *   連續失敗 `MAX_FAILURES` 次就暫停這一塊，等人來看 ——
 *   無止盡地重試一個永遠會被擋的提示詞，等於把捐款燒光。
 */

import "server-only";

import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { BIBLE_VERSION } from "@/lib/world/bible";
import { blockKey, mercatorFrame, surveyProbes, surveyRadiusM, type BlockId } from "@/lib/world/grid";
import { canStartStep } from "@/lib/world/ledger";
import { fallbackParams, parseMapParams } from "@/lib/world/params";
import type { PlannedStep } from "@/lib/world/plan";
import {
  MODEL_PROFILES,
  PRICING_VERSION,
  REFERENCE_FEE_MICROS,
  ZERO_USAGE,
  profileForModel,
  usageCostMicros,
  type ProviderId,
  type TokenUsage,
} from "@/lib/world/pricing";
import {
  DIRECTIONS,
  dsmJob,
  neighborOf,
  paramsJob,
  sceneJob,
  textureJob,
  tileJob,
  type Direction,
  type ImageRef,
  type PaintJob,
  type Viewpoint,
} from "@/lib/world/prompts";
import { chooseViewpoints, type PanoCandidate } from "@/lib/world/survey";
import { pickFor } from "@/lib/world/vote";
import { NoStreetView, type ReferenceSource } from "@/lib/providers/google-maps";
import { normalizeImage } from "@/lib/providers/image";
import { PainterError, type ImageBytes, type Painter, type ResolvedPart } from "@/lib/providers/painter";

import { loadBlockState, type BlockState, type StateDeps } from "./blocks";

/** 一步最多跑多久就算租約到期（外部 API 偶爾很慢，抓寬） */
export const LEASE_MS = 10 * 60 * 1000;
/** 連續失敗幾次暫停 */
export const MAX_FAILURES = 3;
/** 勘查同時發出幾個 metadata 請求 */
const SURVEY_CONCURRENCY = 10;

export interface BuilderDeps {
  readonly db: TxDb;
  readonly tx: <T>(fn: (tx: TxDb) => Promise<T>) => Promise<T>;
  readonly painterFor: (p: ProviderId) => Painter;
  readonly reference: ReferenceSource | null;
  readonly state: StateDeps;
  readonly now: () => number;
  /** 這個工作者的名字（租約持有人） */
  readonly holder: string;
}

export type StepOutcome =
  | "NOT_FOUND"
  | "LOCKED"
  | "COMPLETE"
  | "PAUSED"
  | "COMPLETED_NOW"
  | "WAITING_FOR_FUNDS"
  | "NO_PROVIDER"
  | "SUCCEEDED"
  | "FAILED";

/** 拿租約。拿到回 true；別人正拿著、已完成或暫停回 false */
async function acquireLease(deps: BuilderDeps, blockId: number): Promise<boolean> {
  const now = deps.now();
  const got = await deps.db
    .update(schema.blocks)
    .set({ leaseUntil: new Date(now + LEASE_MS), leaseHolder: deps.holder })
    .where(
      and(
        eq(schema.blocks.id, blockId),
        isNull(schema.blocks.completedAt),
        isNull(schema.blocks.pausedAt),
        or(isNull(schema.blocks.leaseUntil), lt(schema.blocks.leaseUntil, new Date(now))),
      ),
    )
    .returning({ id: schema.blocks.id });
  return got.length > 0;
}

async function releaseLease(deps: BuilderDeps, blockId: number) {
  await deps.db
    .update(schema.blocks)
    .set({ leaseUntil: null, leaseHolder: null })
    .where(and(eq(schema.blocks.id, blockId), eq(schema.blocks.leaseHolder, deps.holder)));
}

export async function runOneStep(deps: BuilderDeps, key: string): Promise<StepOutcome> {
  const [row] = await deps.db.select().from(schema.blocks).where(eq(schema.blocks.key, key));
  if (!row) return "NOT_FOUND";
  if (row.completedAt) return "COMPLETE";
  if (row.pausedAt) return "PAUSED";
  if (!(await acquireLease(deps, row.id))) return "LOCKED";

  try {
    // 自己拿著租約時 `running` 會是 true —— 狀態用「沒有租約」的視角算
    const state = await loadBlockState(deps.db, key, deps.now() + LEASE_MS + 1, deps.state);
    if (!state || !state.row) return "NOT_FOUND";

    const step = state.steps[state.done];
    if (!step) {
      await complete(deps, state);
      return "COMPLETED_NOW";
    }
    if (state.budget.nextStepMicros === null || !canStartStep(state.budget.constructionBalanceMicros, state.budget.nextStepMicros)) {
      return "WAITING_FOR_FUNDS";
    }
    const provider = step.kind === "SURVEY" ? null : pickFor(state.tally, step.kind);
    // 沒有勘查員時地圖參數用預設值（不花錢）；出圖步驟沒有畫師就只能等
    if (step.kind !== "SURVEY" && step.kind !== "PARAMS" && provider === null) return "NO_PROVIDER";

    return await execute(deps, state, state.done, step, provider);
  } finally {
    await releaseLease(deps, row.id);
  }
}

/** 完工：撥付四年保存與伺服器分攤，標記完成 */
async function complete(deps: BuilderDeps, state: BlockState) {
  const line = (k: string) => state.budget.lines.find((l) => l.key === k)?.microsProjected ?? 0;
  await deps.db
    .update(schema.blocks)
    .set({
      completedAt: new Date(deps.now()),
      storageAllocatedMicros: line("operations.storage"),
      computeAllocatedMicros: line("operations.compute"),
    })
    .where(and(eq(schema.blocks.id, state.row!.id), isNull(schema.blocks.completedAt)));
}

interface Spent {
  referenceMicros: number;
}

async function execute(
  deps: BuilderDeps,
  state: BlockState,
  seq: number,
  step: PlannedStep,
  provider: ProviderId | null,
): Promise<StepOutcome> {
  const block = state.id;
  const blockRowId = state.row!.id;
  const startedAt = new Date(deps.now());
  const spent: Spent = { referenceMicros: 0 };
  const tally = { weights: { ...state.tally.weights }, ranking: [...state.tally.ranking] };
  const base = {
    blockId: blockRowId,
    seq,
    kind: step.kind,
    kindIndex: step.index,
    provider,
    pricingVersion: PRICING_VERSION,
    bibleVersion: BIBLE_VERSION,
    tally,
    startedAt,
  };

  try {
    if (step.kind === "SURVEY") {
      const viewpoints = await survey(deps, block);
      await deps.tx(async (tx) => {
        await tx.insert(schema.steps).values({
          ...base,
          status: "SUCCEEDED",
          note: `找到 ${viewpoints.length} 個標記座標`,
          finishedAt: new Date(deps.now()),
        });
        await tx.update(schema.blocks).set({ viewpoints, consecutiveFailures: 0 }).where(eq(schema.blocks.id, blockRowId));
      });
      return "SUCCEEDED";
    }

    const viewpoints = state.row!.viewpoints ?? [];
    if (step.kind === "PARAMS" && provider === null) {
      await deps.tx(async (tx) => {
        await tx.insert(schema.steps).values({
          ...base,
          status: "SUCCEEDED",
          note: "沒有可用的勘查員，使用預設地圖參數",
          finishedAt: new Date(deps.now()),
        });
        await tx
          .update(schema.blocks)
          .set({ params: fallbackParams(viewpoints.length), paramsRepaired: true, consecutiveFailures: 0 })
          .where(eq(schema.blocks.id, blockRowId));
      });
      return "SUCCEEDED";
    }
    const params = state.row!.params ?? null;
    const wishes = state.wishes.slice(0, 5);
    const scenesDone = state.log.filter((l) => l.status === "SUCCEEDED" && l.kind === "SCENE").length;

    let job: PaintJob;
    let label: string | null = null;
    let neighborIds = new Map<Direction, number>();
    switch (step.kind) {
      case "PARAMS":
        job = paramsJob({ block, viewpoints, wishes });
        break;
      case "SCENE":
        job = sceneJob({ block, viewpoint: viewpoints[step.index]!, viewpointIndex: step.index, params, wishes });
        label = params?.markers[step.index]?.caption ?? null;
        break;
      case "TILE":
        neighborIds = await completedNeighbors(deps.db, block);
        job = tileJob({ block, scenes: scenesDone, neighbors: [...neighborIds.keys()], params, wishes });
        break;
      case "DSM":
        job = dsmJob({ block, params });
        break;
      case "TEXTURE":
        label = params?.materials[step.index] ?? `material ${step.index + 1}`;
        job = textureJob({ block, material: label, textureIndex: step.index, scenes: scenesDone, params });
        break;
    }

    const ctx = { block, blockRowId, viewpoints, neighborIds };
    let parts: ResolvedPart[];
    let fallbackNote: string | null = null;
    try {
      parts = await resolveParts(deps, job.parts, ctx, spent);
    } catch (e) {
      // 這個標記座標拿不到任何街景：改用衛星影像構圖，不讓整塊卡在這一張
      if (!(e instanceof NoStreetView) || step.kind !== "SCENE") throw e;
      job = sceneJob({ block, viewpoint: viewpoints[step.index]!, viewpointIndex: step.index, params, wishes, reference: "layout" });
      parts = await resolveParts(deps, job.parts, ctx, spent);
      fallbackNote = `${e.message}；改用衛星影像構圖`;
    }
    const painter = deps.painterFor(provider!);
    const result = await painter.paint({ kind: job.kind, output: job.output, aspect: job.aspect, parts });
    const tokenMicros = cost(provider!, result.model, result.usage);
    const finishedAt = new Date(deps.now());

    if (result.output === "text") {
      const { params: parsed, repaired } = parseMapParams(result.text, viewpoints.length);
      await deps.tx(async (tx) => {
        await tx.insert(schema.steps).values({
          ...base,
          status: "SUCCEEDED",
          model: result.model,
          ...usageCols(result.usage),
          tokenMicros,
          referenceMicros: spent.referenceMicros,
          note: repaired ? "參數格式經過修正" : null,
          finishedAt,
        });
        await tx
          .update(schema.blocks)
          .set({ params: parsed, paramsRepaired: repaired, consecutiveFailures: 0 })
          .where(eq(schema.blocks.id, blockRowId));
      });
      return "SUCCEEDED";
    }

    let image = result.image;
    if (step.kind === "DSM") image = await toGrayscale(image);
    const stored = await normalizeImage(image, job.aspect);
    await deps.tx(async (tx) => {
      const [s] = await tx
        .insert(schema.steps)
        .values({
          ...base,
          status: "SUCCEEDED",
          model: result.model,
          ...usageCols(result.usage),
          tokenMicros,
          referenceMicros: spent.referenceMicros,
          note: [fallbackNote, result.note].filter(Boolean).join("\n").slice(0, 500) || null,
          finishedAt,
        })
        .returning({ id: schema.steps.id });
      await tx
        .insert(schema.artifacts)
        .values({
          blockId: blockRowId,
          stepId: s!.id,
          kind: step.kind,
          kindIndex: step.index,
          mime: "image/webp",
          width: stored.width,
          height: stored.height,
          data: stored.webp,
          thumb: stored.thumb,
          label,
        })
        .onConflictDoUpdate({
          target: [schema.artifacts.blockId, schema.artifacts.kind, schema.artifacts.kindIndex],
          set: { stepId: s!.id, data: stored.webp, thumb: stored.thumb, width: stored.width, height: stored.height, label },
        });
      await tx.update(schema.blocks).set({ consecutiveFailures: 0 }).where(eq(schema.blocks.id, blockRowId));
    });
    return "SUCCEEDED";
  } catch (e) {
    await recordFailure(deps, base, provider, e, spent);
    return "FAILED";
  }
}

function usageCols(u: TokenUsage) {
  return { textIn: u.textIn, imageIn: u.imageIn, textOut: u.textOut, imageOut: u.imageOut };
}

/** 帳記在**實際服務的模型**上；認不得的模型（例如 fallback 到新型號）以請求的那一家計價 */
function cost(provider: ProviderId, servedModel: string | null, usage: TokenUsage): number {
  const profile = (servedModel && profileForModel(servedModel)) || MODEL_PROFILES[provider];
  return usageCostMicros(profile.rates, usage);
}

async function recordFailure(
  deps: BuilderDeps,
  base: Omit<typeof schema.steps.$inferInsert, "status" | "finishedAt">,
  provider: ProviderId | null,
  e: unknown,
  spent: Spent,
) {
  const pe = e instanceof PainterError ? e : null;
  const usage = pe?.usage ?? ZERO_USAGE;
  const model = pe?.model ?? null;
  const code = pe?.code ?? "INTERNAL";
  const message = pe ? pe.message : e instanceof Error ? e.message : String(e);
  if (!pe) console.error(`[builder] ${base.kind}#${base.kindIndex} 內部錯誤`, e);

  await deps.tx(async (tx) => {
    await tx.insert(schema.steps).values({
      ...base,
      status: "FAILED",
      model,
      ...usageCols(usage),
      tokenMicros: provider ? cost(provider, model, usage) : 0,
      referenceMicros: spent.referenceMicros,
      errorCode: code,
      errorMessage: message.slice(0, 500),
      finishedAt: new Date(deps.now()),
    });
    const [b] = await tx
      .update(schema.blocks)
      .set({ consecutiveFailures: sql`${schema.blocks.consecutiveFailures} + 1` })
      .where(eq(schema.blocks.id, base.blockId))
      .returning({ failures: schema.blocks.consecutiveFailures });
    /**
     * ★ 金鑰被拒是**平台**的問題（金鑰過期、帳單沒付），不會自己好 —— 立刻暫停。
     *   其餘的連續失敗到上限才暫停；限流與上游故障也算進去，但它們通常下一輪就好。
     */
    if (code === "AUTH" || (b && b.failures >= MAX_FAILURES)) {
      await tx
        .update(schema.blocks)
        .set({ pausedAt: new Date(deps.now()), pauseReason: `STEP_FAILED:${code}` })
        .where(eq(schema.blocks.id, base.blockId));
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 勘查
// ─────────────────────────────────────────────────────────────

async function survey(deps: BuilderDeps, block: BlockId): Promise<Viewpoint[]> {
  if (!deps.reference) throw new PainterError("AUTH", "參考影像來源未設定（GOOGLE_MAPS_API_KEY）");
  const probes = surveyProbes(block);
  const radius = surveyRadiusM(block);
  const found: PanoCandidate[] = [];
  for (let i = 0; i < probes.length; i += SURVEY_CONCURRENCY) {
    const batch = await Promise.all(
      probes.slice(i, i + SURVEY_CONCURRENCY).map((p) => deps.reference!.nearestPano(p, radius)),
    );
    for (const c of batch) if (c) found.push(c);
  }
  return chooseViewpoints(block, found);
}

// ─────────────────────────────────────────────────────────────
// 參照 → 位元組
// ─────────────────────────────────────────────────────────────

async function completedNeighbors(db: TxDb, block: BlockId): Promise<Map<Direction, number>> {
  const keyed = new Map<string, Direction>();
  for (const dir of DIRECTIONS) {
    const n = neighborOf(block, dir);
    if (n) keyed.set(blockKey(n), dir);
  }
  if (keyed.size === 0) return new Map();
  const rows = await db
    .select({ blockId: schema.blocks.id, key: schema.blocks.key })
    .from(schema.blocks)
    .innerJoin(
      schema.artifacts,
      and(eq(schema.artifacts.blockId, schema.blocks.id), eq(schema.artifacts.kind, "TILE")),
    )
    .where(and(inArray(schema.blocks.key, [...keyed.keys()]), sql`${schema.blocks.completedAt} IS NOT NULL`));
  const out = new Map<Direction, number>();
  for (const r of rows) out.set(keyed.get(r.key)!, r.blockId);
  // 固定順序：北東南西
  return new Map(DIRECTIONS.filter((d) => out.has(d)).map((d) => [d, out.get(d)!]));
}

async function loadArtifact(db: TxDb, blockId: number, kind: string, kindIndex: number): Promise<ImageBytes> {
  const [a] = await db
    .select({ data: schema.artifacts.data, mime: schema.artifacts.mime })
    .from(schema.artifacts)
    .where(and(eq(schema.artifacts.blockId, blockId), eq(schema.artifacts.kind, kind), eq(schema.artifacts.kindIndex, kindIndex)));
  if (!a) throw new PainterError("BAD_REQUEST", `找不到參考的 ${kind}#${kindIndex}`);
  return { mime: a.mime, data: new Uint8Array(a.data) };
}

async function resolveParts(
  deps: BuilderDeps,
  parts: PaintJob["parts"],
  ctx: { block: BlockId; blockRowId: number; viewpoints: readonly Viewpoint[]; neighborIds: Map<Direction, number> },
  spent: Spent,
): Promise<ResolvedPart[]> {
  let layout: ImageBytes | null = null;
  const out: ResolvedPart[] = [];
  for (const p of parts) {
    if (p.kind === "text") {
      out.push(p);
      continue;
    }
    out.push({ kind: "image", image: await resolveRef(p.ref) });
  }
  return out;

  async function resolveRef(ref: ImageRef): Promise<ImageBytes> {
    switch (ref.type) {
      case "streetview": {
        if (!deps.reference) throw new PainterError("AUTH", "參考影像來源未設定（GOOGLE_MAPS_API_KEY）");
        const v = ctx.viewpoints[ref.viewpoint];
        if (!v) throw new PainterError("BAD_REQUEST", `沒有第 ${ref.viewpoint} 個標記座標`);
        spent.referenceMicros += REFERENCE_FEE_MICROS.streetViewImage;
        return deps.reference.streetView(v);
      }
      case "layout": {
        if (layout) return layout;
        if (!deps.reference) throw new PainterError("AUTH", "參考影像來源未設定（GOOGLE_MAPS_API_KEY）");
        spent.referenceMicros += REFERENCE_FEE_MICROS.staticMap;
        layout = await deps.reference.layout(mercatorFrame(ctx.block));
        return layout;
      }
      case "scene":
        return loadArtifact(deps.db, ctx.blockRowId, "SCENE", ref.sceneIndex);
      case "tile":
        return loadArtifact(deps.db, ctx.blockRowId, "TILE", 0);
      case "neighbor": {
        const id = ctx.neighborIds.get(ref.dir);
        if (!id) throw new PainterError("BAD_REQUEST", `${ref.dir} 鄰塊尚未完成`);
        return loadArtifact(deps.db, id, "TILE", 0);
      }
    }
  }
}

async function toGrayscale(img: ImageBytes): Promise<ImageBytes> {
  const { default: sharp } = await import("sharp");
  const png = await sharp(Buffer.from(img.data)).grayscale().png().toBuffer();
  return { mime: "image/png", data: new Uint8Array(png) };
}

// ─────────────────────────────────────────────────────────────
// 迴圈
// ─────────────────────────────────────────────────────────────

/** 這一塊一直做，直到要等錢、完成、暫停或時間到 */
export async function runBlock(deps: BuilderDeps, key: string, deadline: number): Promise<StepOutcome[]> {
  const outcomes: StepOutcome[] = [];
  while (deps.now() < deadline) {
    const o = await runOneStep(deps, key);
    outcomes.push(o);
    if (o !== "SUCCEEDED" && o !== "FAILED") break;
  }
  return outcomes;
}

/**
 * 全站：輪流替每一塊做一步，直到時間到或沒有任何一塊能動。
 *
 * ★ 輪流而不是一塊做完再做下一塊：一塊 NT$1,000 的大工程不該讓後面
 *   一百塊小額捐款的地方等上一整個小時。
 */
export async function runBuilder(
  deps: BuilderDeps,
  opts: { readonly deadline: number; readonly maxSteps?: number },
): Promise<{ steps: number; completed: number }> {
  let steps = 0;
  let completed = 0;
  const max = opts.maxSteps ?? Infinity;
  while (deps.now() < opts.deadline && steps < max) {
    const candidates = await deps.db
      .select({ key: schema.blocks.key })
      .from(schema.blocks)
      .where(
        and(
          isNull(schema.blocks.completedAt),
          isNull(schema.blocks.pausedAt),
          or(isNull(schema.blocks.leaseUntil), lt(schema.blocks.leaseUntil, new Date(deps.now()))),
          sql`exists (select 1 from ${schema.donations} where ${schema.donations.blockId} = ${schema.blocks.id} and ${schema.donations.status} = 'PAID')`,
        ),
      )
      .orderBy(schema.blocks.id)
      .limit(200);
    let progressed = false;
    for (const c of candidates) {
      if (deps.now() >= opts.deadline || steps >= max) break;
      const o = await runOneStep(deps, c.key);
      if (o === "SUCCEEDED" || o === "FAILED") {
        steps++;
        progressed = true;
      } else if (o === "COMPLETED_NOW") {
        completed++;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return { steps, completed };
}
