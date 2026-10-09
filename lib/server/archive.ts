/**
 * 長期保存：完成的區塊 → 場景包 → Boltchain SwarmStorage。**伺服器專用。**
 *
 * ## 一塊的保存流程（`runArchiver` 每一輪推進一點）
 *
 *   1. **凍結附檔**：產生 scene.json、index.html、viewer.js、README.txt，存進 `scene_files`，之後只讀
 *   2. **打包 + 自我驗證**：UnixFS 打包得到根 CID；拆回檔案、逐一比對 SHA-256 ——
 *      付錢保存之前先確定它重建得出來。建立 `scene_archives`（PACKED）
 *   3. **交給平台節點**：`bolt_hostBlocks`（場景包的每個區塊 + 委託索引）
 *   4. **送出委託**：`createDeal`，託管款照合約的算式（`lib/swarm/quote.ts`）→ `scene_deals`（SUBMITTED）
 *   5. **確認**：讀交易收據的 `DealCreated` → ACTIVE；封存狀態 → STORED
 *   6. **接力**：一筆委託最多 3,650 個 epoch。目前的委託剩不到 `renewLeadEpochs` 時，
 *      重新交給節點並開下一筆，直到保存期滿 → DONE
 *
 * ★ 每一次要開新委託都**重新打包並比對 CID**。打出來的根與當初記下的不同，
 *   代表重建不出同一份（例如有人改了凍結的附檔）—— 那就停下來報錯，不付錢保存一份不一樣的東西。
 *
 * ★ 沒有設定 Boltchain（`swarm` 為 null）時只做 1–2：CID 照算、場景包照樣能從網站下載與驗證，
 *   只是沒有付費的異地副本。畫面會講出來。
 */

import "server-only";

import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Hex } from "viem";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { packBundle, unpackBundle, type PackedBundle } from "@/lib/ipfs/pack";
import {
  MANIFEST_PATH,
  RENDER_V1,
  SCENE_LICENSE,
  artifactPath,
  isSceneManifest,
  type RenderSpec,
  type SceneLicense,
} from "@/lib/scene/format";
import { artifactFiles, buildExtras, verifyBundleFiles, type BundleArtifact, type BundleFile } from "@/lib/scene/bundle";
import { VIEWER_HTML, VIEWER_JS } from "@/lib/scene/viewer.generated";
import { SwarmError, type SwarmClient } from "@/lib/swarm/client";
import { buildDealIndex } from "@/lib/swarm/deal-index";
import { MAX_DEAL_EPOCHS, boltToWei, dealCost, epochsFor } from "@/lib/swarm/quote";
import { swarmTerms, type BudgetConfig } from "@/lib/world/budget";
import { parseBlockKey } from "@/lib/world/grid";
import { MODEL_PROFILES, isProviderId } from "@/lib/world/pricing";

export interface ArchiveDeps {
  readonly db: TxDb;
  readonly tx: <T>(fn: (tx: TxDb) => Promise<T>) => Promise<T>;
  readonly now: () => number;
  readonly swarm: SwarmClient | null;
  readonly config: BudgetConfig;
}

/** 失敗後多久再試 */
const RETRY_MS = 15 * 60_000;
/** 送出後多久還沒有收據就當作沒送成 */
const SUBMIT_TIMEOUT_MS = 30 * 60_000;
/** 副本狀態多久讀一次 */
const SLOTS_REFRESH_MS = 60 * 60_000;

// ─────────────────────────────────────────────────────────────
// 場景包
// ─────────────────────────────────────────────────────────────

async function loadArtifacts(db: TxDb, blockId: number): Promise<BundleArtifact[]> {
  const rows = await db
    .select({
      kind: schema.artifacts.kind,
      kindIndex: schema.artifacts.kindIndex,
      mime: schema.artifacts.mime,
      width: schema.artifacts.width,
      height: schema.artifacts.height,
      label: schema.artifacts.label,
      data: schema.artifacts.data,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.blockId, blockId))
    .orderBy(asc(schema.artifacts.kind), asc(schema.artifacts.kindIndex));
  return rows.map((r) => ({ ...r, bytes: new Uint8Array(r.data) }));
}

async function loadExtras(db: TxDb, blockId: number): Promise<BundleFile[]> {
  const rows = await db
    .select({ path: schema.sceneFiles.path, data: schema.sceneFiles.data })
    .from(schema.sceneFiles)
    .where(eq(schema.sceneFiles.blockId, blockId))
    .orderBy(asc(schema.sceneFiles.path));
  return rows.map((r) => ({ path: r.path, bytes: new Uint8Array(r.data) }));
}

/** 第一次：產生附檔並凍結。已經凍結過就什麼都不做（併發時以先寫入的為準） */
async function freezeExtras(deps: Pick<ArchiveDeps, "db">, blockId: number, artifacts: BundleArtifact[]) {
  const [row] = await deps.db.select().from(schema.blocks).where(eq(schema.blocks.id, blockId));
  if (!row?.completedAt) throw new Error("區塊尚未完成");
  const id = parseBlockKey(row.key);
  if (!id) throw new Error(`壞掉的區塊鍵 ${row.key}`);
  const steps = await deps.db
    .select()
    .from(schema.steps)
    .where(and(eq(schema.steps.blockId, blockId), eq(schema.steps.status, "SUCCEEDED")))
    .orderBy(asc(schema.steps.seq));
  const { extras } = await buildExtras({
    block: id,
    key: row.key,
    completedAt: row.completedAt,
    viewpoints: row.viewpoints ?? [],
    params: row.params ?? null,
    artifacts,
    steps: steps.map((s) => {
      const p = isProviderId(s.provider) ? MODEL_PROFILES[s.provider] : null;
      return {
        seq: s.seq,
        kind: s.kind,
        kindIndex: s.kindIndex,
        provider: s.provider,
        model: s.model,
        company: p?.company ?? null,
        displayName: p?.displayName ?? null,
        tokens: s.textIn + s.imageIn + s.textOut + s.imageOut,
        costMicros: s.tokenMicros + s.referenceMicros,
        bibleVersion: s.bibleVersion,
        pricingVersion: s.pricingVersion,
      };
    }),
    viewer: { html: VIEWER_HTML, js: VIEWER_JS },
  });
  await deps.db
    .insert(schema.sceneFiles)
    .values(extras.map((f) => ({ blockId, path: f.path, data: f.bytes })))
    .onConflictDoNothing();
}

/** 一塊完整的場景包檔案。未完成回 null */
export async function sceneBundleFiles(deps: Pick<ArchiveDeps, "db">, blockId: number): Promise<BundleFile[] | null> {
  const [row] = await deps.db
    .select({ completedAt: schema.blocks.completedAt })
    .from(schema.blocks)
    .where(eq(schema.blocks.id, blockId));
  if (!row?.completedAt) return null;
  const artifacts = await loadArtifacts(deps.db, blockId);
  let extras = await loadExtras(deps.db, blockId);
  if (extras.length === 0) {
    await freezeExtras(deps, blockId, artifacts);
    extras = await loadExtras(deps.db, blockId);
  }
  return [...extras, ...artifactFiles(artifacts)];
}

export interface PackedScene {
  readonly files: BundleFile[];
  readonly packed: PackedBundle;
  readonly dealIndex: Awaited<ReturnType<typeof buildDealIndex>>;
}

/** 打包並驗證。`roundTrip` 時還會把打好的區塊拆回檔案逐一比對（第一次打包時做） */
export async function packScene(
  deps: Pick<ArchiveDeps, "db">,
  blockId: number,
  opts: { roundTrip?: boolean } = {},
): Promise<PackedScene | null> {
  const files = await sceneBundleFiles(deps, blockId);
  if (!files) return null;
  const check = await verifyBundleFiles(files);
  if (!check.ok) throw new Error(`場景包驗證失敗：${check.problems.slice(0, 3).join("；")}`);
  const packed = await packBundle(files);
  if (opts.roundTrip) {
    const back = await unpackBundle(packed.root, packed.blocks);
    const want = new Map(files.map((f) => [f.path, f.bytes]));
    const same =
      back.length === files.length &&
      back.every((f) => {
        const w = want.get(f.path);
        return !!w && w.length === f.bytes.length && w.every((b, i) => b === f.bytes[i]);
      });
    if (!same) throw new Error("打包後拆不回同樣的檔案");
  }
  const dealIndex = await buildDealIndex(packed.blocks, packed.root);
  return { files, packed, dealIndex };
}

/**
 * 已凍結的清單裡網站要用的兩樣東西：渲染規格（網站上的 3D 照它畫，與場景包一樣）與授權。
 * 還沒凍結時用目前的預設。
 */
export async function frozenManifest(db: TxDb, blockId: number): Promise<{ render: RenderSpec; license: SceneLicense | null }> {
  const [row] = await db
    .select({ data: schema.sceneFiles.data })
    .from(schema.sceneFiles)
    .where(and(eq(schema.sceneFiles.blockId, blockId), eq(schema.sceneFiles.path, MANIFEST_PATH)));
  if (!row) return { render: RENDER_V1, license: SCENE_LICENSE };
  try {
    const m: unknown = JSON.parse(new TextDecoder().decode(row.data));
    return isSceneManifest(m) ? { render: m.render, license: m.license ?? null } : { render: RENDER_V1, license: null };
  } catch {
    return { render: RENDER_V1, license: null };
  }
}

/**
 * 讀場景包裡的一個檔案（網站上的「瀏覽場景包」用）。
 * 附檔讀 `scene_files`，圖讀 `artifacts` —— 與打包用的是同一批位元組。
 */
export async function readBundleFile(
  db: TxDb,
  blockId: number,
  path: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const [extra] = await db
    .select({ data: schema.sceneFiles.data })
    .from(schema.sceneFiles)
    .where(and(eq(schema.sceneFiles.blockId, blockId), eq(schema.sceneFiles.path, path)));
  if (extra) {
    const mime = path.endsWith(".html")
      ? "text/html; charset=utf-8"
      : path.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : path.endsWith(".json")
          ? "application/json"
          : "text/plain; charset=utf-8";
    return { bytes: new Uint8Array(extra.data), mime };
  }
  const arts = await db
    .select({
      kind: schema.artifacts.kind,
      kindIndex: schema.artifacts.kindIndex,
      mime: schema.artifacts.mime,
      data: schema.artifacts.data,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.blockId, blockId));
  const hit = arts.find((a) => artifactPath(a.kind, a.kindIndex, a.mime) === path);
  return hit ? { bytes: new Uint8Array(hit.data), mime: hit.mime } : null;
}

// ─────────────────────────────────────────────────────────────
// 推進
// ─────────────────────────────────────────────────────────────

type ArchiveRow = typeof schema.sceneArchives.$inferSelect;
type DealRow = typeof schema.sceneDeals.$inferSelect;

export interface ArchiverResult {
  packed: number;
  submitted: number;
  confirmed: number;
  errors: number;
}

/** 完工但還沒打包的塊 → 打包、驗證、建立封存 */
async function packNew(deps: ArchiveDeps, limit: number, out: ArchiverResult) {
  const rows = await deps.db
    .select({ id: schema.blocks.id, completedAt: schema.blocks.completedAt })
    .from(schema.blocks)
    .leftJoin(schema.sceneArchives, eq(schema.sceneArchives.blockId, schema.blocks.id))
    .where(and(sql`${schema.blocks.completedAt} is not null`, isNull(schema.sceneArchives.id)))
    .orderBy(asc(schema.blocks.id))
    .limit(limit);
  for (const r of rows) {
    try {
      const p = await packScene(deps, r.id, { roundTrip: true });
      if (!p) continue;
      const retainUntil = new Date(r.completedAt!.getTime());
      retainUntil.setUTCMonth(retainUntil.getUTCMonth() + deps.config.retentionMonths);
      await deps.db
        .insert(schema.sceneArchives)
        .values({
          blockId: r.id,
          sceneCid: p.packed.root.toString(),
          dealIndexCid: p.dealIndex.cid.toString(),
          blockCount: p.dealIndex.index.count,
          bytes: p.dealIndex.index.size,
          retainUntil,
        })
        .onConflictDoNothing();
      out.packed++;
    } catch (e) {
      out.errors++;
      console.error(`[archive] 區塊 ${r.id} 打包失敗`, e);
    }
  }
}

async function setError(deps: ArchiveDeps, a: ArchiveRow, message: string) {
  await deps.db
    .update(schema.sceneArchives)
    .set({ lastError: message.slice(0, 500), nextAttemptAt: new Date(deps.now() + RETRY_MS) })
    .where(eq(schema.sceneArchives.id, a.id));
}

/** 一筆封存往前推一步 */
async function advance(deps: ArchiveDeps, swarm: SwarmClient, a: ArchiveRow, out: ArchiverResult) {
  const deals = await deps.db
    .select()
    .from(schema.sceneDeals)
    .where(and(eq(schema.sceneDeals.archiveId, a.id), eq(schema.sceneDeals.network, swarm.network)))
    .orderBy(asc(schema.sceneDeals.id));

  // ── 1. 確認送出去的交易 ──
  for (const d of deals.filter((x) => x.status === "SUBMITTED")) {
    const r = await swarm.receipt(d.txHash as Hex);
    if (r.state === "PENDING") {
      if (deps.now() - d.createdAt.getTime() < SUBMIT_TIMEOUT_MS) return;
      await deps.db.update(schema.sceneDeals).set({ status: "FAILED", error: "逾時沒有收據" }).where(eq(schema.sceneDeals.id, d.id));
      continue;
    }
    if (r.state === "FAILED") {
      await deps.db.update(schema.sceneDeals).set({ status: "FAILED", error: r.error }).where(eq(schema.sceneDeals.id, d.id));
      await setError(deps, a, r.error);
      return;
    }
    await deps.tx(async (tx) => {
      await tx
        .update(schema.sceneDeals)
        .set({ status: "ACTIVE", dealId: r.dealId.toString(), startEpoch: r.startEpoch, endEpoch: r.endEpoch })
        .where(eq(schema.sceneDeals.id, d.id));
      await tx
        .update(schema.sceneArchives)
        .set({ status: "STORED", lastError: null, nextAttemptAt: null })
        .where(eq(schema.sceneArchives.id, a.id));
    });
    Object.assign(d, { status: "ACTIVE", dealId: r.dealId.toString(), startEpoch: r.startEpoch, endEpoch: r.endEpoch });
    out.confirmed++;
  }

  // ── 2. 讀副本狀態（不必每分鐘） ──
  for (const d of deals.filter((x) => x.status === "ACTIVE" && x.dealId)) {
    if (d.checkedAt && deps.now() - d.checkedAt.getTime() < SLOTS_REFRESH_MS) continue;
    const s = await swarm.slots(BigInt(d.dealId!));
    await deps.db
      .update(schema.sceneDeals)
      .set({ slots: s.slots, checkedAt: new Date(deps.now()) })
      .where(eq(schema.sceneDeals.id, d.id));
  }

  // ── 3. 涵蓋到哪裡？需要下一筆嗎？ ──
  const terms = swarmTerms(deps.config);
  const current = await swarm.currentEpoch();
  const coveredUntil = Math.max(current, ...deals.filter((d) => d.status === "ACTIVE").map((d) => d.endEpoch ?? 0));
  const remainingMs = a.retainUntil.getTime() - deps.now();
  if (remainingMs <= 0) {
    if (coveredUntil <= current) {
      await deps.db.update(schema.sceneArchives).set({ status: "DONE" }).where(eq(schema.sceneArchives.id, a.id));
    }
    return;
  }
  const targetEnd = current + epochsFor(remainingMs / (30.436875 * 86_400_000), terms.epochSeconds);
  if (coveredUntil >= targetEnd) return;
  if (deals.some((d) => d.status === "ACTIVE") && coveredUntil - current > terms.renewLeadEpochs) return;
  const epochs = Math.min(MAX_DEAL_EPOCHS, targetEnd - current);
  if (epochs <= 0) return;

  // ── 4. 重新打包、比對、交給節點、送出委託 ──
  const p = await packScene(deps, a.blockId);
  if (!p) return;
  if (p.packed.root.toString() !== a.sceneCid || p.dealIndex.cid.toString() !== a.dealIndexCid) {
    await setError(deps, a, `重新打包得到不同的 CID（${p.packed.root.toString()}），停止保存，請檢查 scene_files`);
    out.errors++;
    return;
  }
  await swarm.host(p.dealIndex.cid, [...p.packed.blocks, ...p.dealIndex.indexBlocks]);
  const priceWei = boltToWei(terms.priceBolt);
  const cost = dealCost({ sizeBytes: p.dealIndex.index.size, replicas: terms.replicas, epochs, priceWei });
  const txHash = await swarm.createDeal({
    dealIndex: p.dealIndex.cid,
    blocks: p.dealIndex.index.count,
    size: p.dealIndex.index.size,
    replicas: terms.replicas,
    epochs,
    priceWei,
    valueWei: cost.totalWei,
  });
  await deps.db.insert(schema.sceneDeals).values({
    archiveId: a.id,
    network: swarm.network,
    status: "SUBMITTED",
    txHash,
    replicas: terms.replicas,
    epochs,
    priceWei: priceWei.toString(),
    costWei: cost.totalWei.toString(),
  });
  out.submitted++;
}

export async function runArchiver(
  deps: ArchiveDeps,
  opts: { readonly deadline: number; readonly maxPack?: number },
): Promise<ArchiverResult> {
  const out: ArchiverResult = { packed: 0, submitted: 0, confirmed: 0, errors: 0 };
  await packNew(deps, opts.maxPack ?? 2, out);
  const swarm = deps.swarm;
  if (!swarm || deps.now() >= opts.deadline) return out;
  const due = await deps.db
    .select()
    .from(schema.sceneArchives)
    .where(
      and(
        inArray(schema.sceneArchives.status, ["PACKED", "STORED"]),
        or(isNull(schema.sceneArchives.nextAttemptAt), lte(schema.sceneArchives.nextAttemptAt, new Date(deps.now()))),
      ),
    )
    .orderBy(asc(schema.sceneArchives.id))
    .limit(20);
  for (const a of due) {
    if (deps.now() >= opts.deadline) break;
    try {
      await advance(deps, swarm, a, out);
    } catch (e) {
      out.errors++;
      await setError(deps, a, e instanceof SwarmError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 給畫面
// ─────────────────────────────────────────────────────────────

export interface ArchiveInfo {
  readonly archive: ArchiveRow;
  readonly deals: DealRow[];
}

export async function archiveOf(db: TxDb, blockId: number): Promise<ArchiveInfo | null> {
  const [archive] = await db.select().from(schema.sceneArchives).where(eq(schema.sceneArchives.blockId, blockId));
  if (!archive) return null;
  const deals = await db
    .select()
    .from(schema.sceneDeals)
    .where(eq(schema.sceneDeals.archiveId, archive.id))
    .orderBy(asc(schema.sceneDeals.id));
  return { archive, deals };
}

/** 全世界已封存的塊（給「整個世界的索引」用） */
export async function archiveIndex(db: TxDb) {
  const rows = await db
    .select({
      key: schema.blocks.key,
      sceneCid: schema.sceneArchives.sceneCid,
      dealIndexCid: schema.sceneArchives.dealIndexCid,
      status: schema.sceneArchives.status,
      bytes: schema.sceneArchives.bytes,
      archiveId: schema.sceneArchives.id,
    })
    .from(schema.sceneArchives)
    .innerJoin(schema.blocks, eq(schema.blocks.id, schema.sceneArchives.blockId))
    .orderBy(asc(schema.blocks.key));
  const deals = rows.length
    ? await db
        .select({
          archiveId: schema.sceneDeals.archiveId,
          network: schema.sceneDeals.network,
          dealId: schema.sceneDeals.dealId,
          startEpoch: schema.sceneDeals.startEpoch,
          endEpoch: schema.sceneDeals.endEpoch,
        })
        .from(schema.sceneDeals)
        .where(eq(schema.sceneDeals.status, "ACTIVE"))
    : [];
  return rows.map(({ archiveId, ...r }) => ({
    ...r,
    deals: deals
      .filter((d) => d.archiveId === archiveId)
      .map((d) => ({ network: d.network, dealId: d.dealId, startEpoch: d.startEpoch, endEpoch: d.endEpoch })),
  }));
}
