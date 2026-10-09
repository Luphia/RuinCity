import { eq } from "drizzle-orm";
import type { Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "@/lib/db";
import { packBundle, unpackBundle } from "@/lib/ipfs/pack";
import { fakePainter } from "@/lib/providers/fake";
import type { ReferenceSource } from "@/lib/providers/google-maps";
import { verifyBundleFiles } from "@/lib/scene/bundle";
import type { DealReceipt, SwarmClient } from "@/lib/swarm/client";
import { MAX_DEAL_EPOCHS, boltToWei, dealCost } from "@/lib/swarm/quote";
import { DEFAULT_BUDGET_CONFIG, swarmTerms } from "@/lib/world/budget";
import { blockBounds, blockOf } from "@/lib/world/grid";
import { PROVIDER_ORDER } from "@/lib/world/pricing";

import { archiveOf, packScene, runArchiver, sceneBundleFiles, type ArchiveDeps } from "./archive";
import type { StateDeps } from "./blocks";
import { runBlock, type BuilderDeps } from "./builder";
import { attachProcessorRef, confirmDonation, createDonation } from "./donations";
import { createHarness, seedUser, type Harness } from "./testing/db-harness";

// 測試網的 epoch（1 小時）：四年要接力多筆委託，才測得到接力
const cfg = { ...DEFAULT_BUDGET_CONFIG, swarmEpochSeconds: 3_600 };
const stateDeps: StateDeps = { enabled: [...PROVIDER_ORDER], fallback: "google", config: cfg };
const KEY = "24.10_120.60";

let h: Harness;
let clock = Date.UTC(2026, 9, 9, 12);
const now = () => (clock += 1000);
let blockId = 0;

function smallReference(): ReferenceSource {
  const b = blockBounds(blockOf({ lat: 24.105, lng: 120.605 }));
  const panos = [
    { panoId: "pa", location: { lat: b.south + 0.002, lng: b.west + 0.002 }, date: "2024-01" },
    { panoId: "pb", location: { lat: b.north - 0.002, lng: b.east - 0.002 }, date: "2024-02" },
  ];
  let i = 0;
  const gray = async () => {
    const { rasterizeSvg } = await import("@/lib/providers/image");
    return rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#888"/></svg>', "16:9");
  };
  return { nearestPano: async () => panos[i++ % 7] ?? null, streetView: gray, layout: gray };
}

/** 記下每一次呼叫的 SwarmStorage；epoch 由測試控制 */
function recordingSwarm() {
  let epoch = 100;
  const hosted: { root: string; count: number }[] = [];
  const created: { tx: Hex; start: number; epochs: number; valueWei: bigint; size: number; blocks: number; root: string }[] = [];
  const failTx = new Set<string>();
  const client: SwarmClient = {
    network: "test",
    gateways: ["http://gw"],
    async host(root, blocks) {
      hosted.push({ root: root.toString(), count: blocks.length });
    },
    async currentEpoch() {
      return epoch;
    },
    async createDeal(a) {
      const tx = `0x${(created.length + 1).toString(16).padStart(64, "0")}` as Hex;
      created.push({ tx, start: epoch, epochs: a.epochs, valueWei: a.valueWei, size: a.size, blocks: a.blocks, root: a.dealIndex.toString() });
      return tx;
    },
    async receipt(tx): Promise<DealReceipt> {
      if (failTx.has(tx)) return { state: "FAILED", error: "交易被回退（reverted）" };
      const i = created.findIndex((c) => c.tx === tx);
      if (i < 0) return { state: "PENDING" };
      const c = created[i]!;
      return { state: "ACTIVE", dealId: BigInt(i), startEpoch: c.start, endEpoch: c.start + c.epochs };
    },
    async slots() {
      return { closed: false, endEpoch: 0, slots: [1, 2, 3].map((p) => ({ provider: p, since: 0, paidThrough: 0, open: true })) };
    },
  };
  return { client, hosted, created, failTx, setEpoch: (e: number) => (epoch = e) };
}

function archiveDeps(swarm: SwarmClient | null): ArchiveDeps {
  return { db: h.db, tx: h.tx, now: () => clock, swarm, config: cfg };
}

beforeAll(async () => {
  h = await createHarness();
  const donor = await seedUser(h);
  const r = await createDonation(h.db, {
    blockKey: KEY,
    donorId: donor,
    amountTwd: 3000,
    vote: "google",
    processor: "demo",
    enabled: [...PROVIDER_ORDER],
    config: cfg,
  });
  if (!r.ok) throw new Error(r.reason);
  await attachProcessorRef(h.db, r.donationId, "ref-archive");
  await confirmDonation(h.db, { processor: "demo", processorRef: "ref-archive", amountTwd: 3000, now: now(), config: cfg });
  const deps: BuilderDeps = {
    db: h.db,
    tx: h.tx,
    painterFor: (p) => fakePainter(p),
    reference: smallReference(),
    state: stateDeps,
    now,
    holder: "test",
  };
  const out = await runBlock(deps, KEY, Infinity);
  expect(out.at(-1)).toBe("COMPLETED_NOW");
  const [b] = await h.db.select().from(schema.blocks).where(eq(schema.blocks.key, KEY));
  blockId = b!.id;
});

afterAll(async () => {
  await h?.close();
});

describe("場景包", () => {
  it("★ 完工 → 打包：附檔凍結、清單驗證通過、拆回來的位元組一模一樣、CID 可重算", async () => {
    const r = await runArchiver(archiveDeps(null), { deadline: Infinity });
    expect(r.packed).toBe(1);
    const info = (await archiveOf(h.db, blockId))!;
    expect(info.archive.status).toBe("PACKED");
    expect(info.deals).toEqual([]);

    const extras = await h.db.select({ path: schema.sceneFiles.path }).from(schema.sceneFiles).where(eq(schema.sceneFiles.blockId, blockId));
    expect(extras.map((e) => e.path).sort()).toEqual(["README.txt", "index.html", "scene.json", "viewer.js"]);

    const files = (await sceneBundleFiles({ db: h.db }, blockId))!;
    const check = await verifyBundleFiles(files);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.manifest.scenes).toHaveLength(8);
      expect(check.manifest.textures).toHaveLength(8);
      expect(check.manifest.map).not.toBeNull();
    }
    const packed = await packBundle(files);
    expect(packed.root.toString()).toBe(info.archive.sceneCid);
    const back = await unpackBundle(packed.root, packed.blocks);
    expect(back).toHaveLength(files.length);

    // 再跑一次：不重複打包
    expect((await runArchiver(archiveDeps(null), { deadline: Infinity })).packed).toBe(0);
  });
});

describe("Boltchain SwarmStorage", () => {
  const s = recordingSwarm();

  it("★ 送交保存：交給節點的是整包 + 委託索引；託管款照合約算式；第一筆不超過 3,650 個 epoch", async () => {
    const r = await runArchiver(archiveDeps(s.client), { deadline: Infinity });
    expect(r.submitted).toBe(1);
    const info = (await archiveOf(h.db, blockId))!;
    const a = info.archive;
    expect(s.hosted).toHaveLength(1);
    expect(s.hosted[0]!.root).toBe(a.dealIndexCid);
    expect(s.hosted[0]!.count).toBe(a.blockCount + 2); // 一個分組 + 索引根
    const c = s.created[0]!;
    expect(c.root).toBe(a.dealIndexCid);
    expect(c.blocks).toBe(a.blockCount);
    expect(c.size).toBe(a.bytes);
    expect(c.epochs).toBe(MAX_DEAL_EPOCHS);
    const t = swarmTerms(cfg);
    expect(c.valueWei).toBe(dealCost({ sizeBytes: a.bytes, replicas: t.replicas, epochs: c.epochs, priceWei: boltToWei(t.priceBolt) }).totalWei);
    expect(info.deals[0]).toMatchObject({ status: "SUBMITTED", network: "test", epochs: MAX_DEAL_EPOCHS });
  });

  it("★ 確認：讀到 DealCreated → 委託生效、封存變成「保存中」、副本狀態寫回", async () => {
    const r = await runArchiver(archiveDeps(s.client), { deadline: Infinity });
    expect(r.confirmed).toBe(1);
    const info = (await archiveOf(h.db, blockId))!;
    expect(info.archive.status).toBe("STORED");
    expect(info.deals[0]).toMatchObject({ status: "ACTIVE", dealId: "0", startEpoch: 100, endEpoch: 100 + MAX_DEAL_EPOCHS });
    expect(info.deals[0]!.slots).toHaveLength(3);
    // 還早：不開下一筆
    expect((await runArchiver(archiveDeps(s.client), { deadline: Infinity })).submitted).toBe(0);
    expect(s.created).toHaveLength(1);
  });

  it("★ 接力：快到期時以同一個委託索引開下一筆", async () => {
    s.setEpoch(100 + MAX_DEAL_EPOCHS - 10);
    const r = await runArchiver(archiveDeps(s.client), { deadline: Infinity });
    expect(r.submitted).toBe(1);
    expect(s.created).toHaveLength(2);
    expect(s.created[1]!.root).toBe(s.created[0]!.root);
    expect(s.hosted).toHaveLength(2); // 重新交給節點：新的保存者要有地方取資料
    await runArchiver(archiveDeps(s.client), { deadline: Infinity });
    const info = (await archiveOf(h.db, blockId))!;
    expect(info.deals.filter((d) => d.status === "ACTIVE")).toHaveLength(2);
  });

  it("★ 凍結的附檔被改過 → 重新打包的 CID 對不上 → 停止保存，不付錢", async () => {
    await h.db
      .update(schema.sceneFiles)
      .set({ data: new TextEncoder().encode("tampered") })
      .where(eq(schema.sceneFiles.path, "README.txt"));
    s.setEpoch(100 + 2 * MAX_DEAL_EPOCHS - 20);
    const before = s.created.length;
    const r = await runArchiver(archiveDeps(s.client), { deadline: Infinity });
    expect(r.submitted).toBe(0);
    expect(s.created).toHaveLength(before);
    const info = (await archiveOf(h.db, blockId))!;
    expect(info.archive.lastError).toMatch(/場景包驗證失敗|不同的 CID/);
    expect(info.archive.nextAttemptAt).not.toBeNull();
    // 打包也拒絕：清單記載的 SHA-256 對不上
    await expect(packScene({ db: h.db }, blockId)).rejects.toThrow(/README\.txt/);
  });

  it("交易被回退 → 委託記為失敗，稍後重試", async () => {
    const files = (await sceneBundleFiles({ db: h.db }, blockId))!;
    expect((await verifyBundleFiles(files)).ok).toBe(false);
    // 換一塊乾淨的資料來測：把 README 改回去（從清單外的來源重建它）
    const { readmeText } = await import("@/lib/scene/format");
    await h.db
      .update(schema.sceneFiles)
      .set({ data: new TextEncoder().encode(readmeText({ title: "N24.10° E120.60°", block: { key: KEY } as never })) })
      .where(eq(schema.sceneFiles.path, "README.txt"));
    await h.db.update(schema.sceneArchives).set({ nextAttemptAt: null, lastError: null });
    const r1 = await runArchiver(archiveDeps(s.client), { deadline: Infinity });
    expect(r1.submitted).toBe(1);
    s.failTx.add(s.created.at(-1)!.tx);
    await runArchiver(archiveDeps(s.client), { deadline: Infinity });
    const info = (await archiveOf(h.db, blockId))!;
    expect(info.deals.at(-1)).toMatchObject({ status: "FAILED", error: "交易被回退（reverted）" });
    expect(info.archive.lastError).toContain("reverted");
    expect(info.archive.nextAttemptAt!.getTime()).toBeGreaterThan(clock);
  });
});
