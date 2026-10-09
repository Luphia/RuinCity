import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";

import { packBundle, readCar, unpackBundle, writeCar } from "@/lib/ipfs/pack";
import { demoSwarmClient, hostBatches } from "@/lib/swarm/client";
import { buildDealIndex, decodeDealGroup, decodeDealIndex } from "@/lib/swarm/deal-index";
import {
  MAX_DEAL_EPOCHS,
  boltToWei,
  dealChain,
  dealCost,
  epochsFor,
  quoteRetention,
  s3ParityPriceBolt,
  weiToBolt,
} from "@/lib/swarm/quote";
import { DEFAULT_BUDGET_CONFIG, buildBudget } from "@/lib/world/budget";
import { ORIGIN_BLOCK } from "@/lib/world/grid";
import { emptyKindTotals, planSteps } from "@/lib/world/plan";

import { artifactFiles, buildExtras, verifyBundleFiles, type BundleArtifact } from "./bundle";
import { RENDER_V1, SCENE_LICENSE, artifactPath, canonicalJson, markerPosition } from "./format";
import { buildTerrainMesh } from "./terrain-gl";
import { VIEWER_HTML, VIEWER_JS } from "./viewer.generated";

const enc = new TextEncoder();

function art(kind: string, kindIndex: number, seed: number, size = 2000): BundleArtifact {
  const bytes = new Uint8Array(size).map((_, i) => (i * 7 + seed * 13) & 255);
  return { kind, kindIndex, mime: "image/webp", width: 64, height: 36, label: kind === "TEXTURE" ? `material ${kindIndex}` : null, bytes };
}

async function sampleBundle() {
  const artifacts = [art("TILE", 0, 1, 1_500_000), art("DSM", 0, 2), art("SCENE", 0, 3), art("SCENE", 1, 4), art("TEXTURE", 0, 5)];
  const { extras, manifest } = await buildExtras({
    block: ORIGIN_BLOCK,
    key: "25.03_121.56",
    completedAt: new Date("2026-10-01T00:00:00Z"),
    viewpoints: [
      { panoId: "a", location: { lat: 25.031, lng: 121.561 }, heading: 10, pitch: 0, fov: 90, date: "2024-01" },
      { panoId: "b", location: { lat: 25.038, lng: 121.568 }, heading: 200, pitch: 0, fov: 90, date: null },
    ],
    params: null,
    artifacts,
    steps: [
      { seq: 1, kind: "PARAMS", kindIndex: 0, provider: "anthropic", model: "claude-opus-5-5", company: "Anthropic", displayName: "Claude Opus 5.5", tokens: 12000, costMicros: 70000, bibleVersion: "2", pricingVersion: "2026-10-09" },
      { seq: 2, kind: "SCENE", kindIndex: 0, provider: "google", model: "gemini", company: "Google", displayName: "Gemini", tokens: 3000, costMicros: 40000, bibleVersion: "2", pricingVersion: "2026-10-09" },
    ],
    viewer: { html: VIEWER_HTML, js: VIEWER_JS },
  });
  return { files: [...extras, ...artifactFiles(artifacts)], manifest, artifacts };
}

describe("場景包格式", () => {
  it("★ 正規化 JSON：鍵排序、固定縮排、結尾換行；不收 undefined 與 NaN", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });

  it("產出的路徑固定（改了會讓同樣的場景得到不同 CID）", () => {
    expect(artifactPath("SCENE", 7, "image/webp")).toBe("scenes/007.webp");
    expect(artifactPath("TEXTURE", 3, "image/webp")).toBe("textures/3.webp");
    expect(artifactPath("TILE", 0, "image/webp")).toBe("map/tile.webp");
    expect(artifactPath("DSM", 0, "image/png")).toBe("map/dsm.png");
    expect(() => artifactPath("PARAMS", 0, "x")).toThrow();
  });

  it("★ 清單列出每個檔案的 SHA-256；驗證抓得到竄改、缺檔與多出來的檔案", async () => {
    const { files, manifest } = await sampleBundle();
    expect(manifest.render).toEqual(RENDER_V1);
    // ★ 授權寫在清單裡，跟著每一份副本走
    expect(manifest.license).toEqual(SCENE_LICENSE);
    expect(manifest.license!.id).toBe("CC0-1.0");
    const readme = new TextDecoder().decode(files.find((f) => f.path === "README.txt")!.bytes);
    expect(readme).toContain("CC0 1.0 Universal");
    expect(readme).toContain("creativecommons.org/publicdomain/zero/1.0");
    expect(manifest.scenes.map((s) => s.file)).toEqual(["scenes/000.webp", "scenes/001.webp"]);
    expect(manifest.credits).toEqual([
      { company: "Anthropic", model: "Claude Opus 5.5", steps: 1 },
      { company: "Google", model: "Gemini", steps: 1 },
    ]);
    expect(Object.keys(manifest.files)).toContain("viewer.js");
    expect(await verifyBundleFiles(files)).toMatchObject({ ok: true, files: files.length });

    const tampered = files.map((f) => (f.path === "scenes/001.webp" ? { ...f, bytes: f.bytes.map((b, i) => (i === 0 ? b ^ 1 : b)) } : f));
    const r1 = await verifyBundleFiles(tampered);
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.problems).toContain("scenes/001.webp 的 SHA-256 不符");
    const r2 = await verifyBundleFiles(files.filter((f) => f.path !== "map/dsm.webp"));
    expect(!r2.ok && r2.problems).toContain("缺少 map/dsm.webp");
    const r3 = await verifyBundleFiles([...files, { path: "extra.txt", bytes: enc.encode("x") }]);
    expect(!r3.ok && r3.problems).toContain("多出清單沒列的檔案 extra.txt");
  });

  it("檢視器不連外：沒有 http(s) 的網址、CSP 只允許同源", () => {
    // 唯一出現的網址是給人看的說明（「開 http://localhost:8000/」）
    expect(VIEWER_JS).not.toMatch(/https?:\/\/(?!localhost:8000\/)/);
    expect(VIEWER_HTML).toContain("default-src 'none'");
    expect(VIEWER_HTML).toContain('<script src="viewer.js"');
    expect(VIEWER_JS.length).toBeLessThan(60_000);
  });

  it("底圖上的標記位置（網站與檢視器共用）", () => {
    const b = { south: 25, north: 25.01, west: 121, east: 121.01 };
    expect(markerPosition(b, 25.01, 121)).toEqual({ left: 0, top: 0 });
    const mid = markerPosition(b, 25.005, 121.005);
    expect(mid.left).toBeCloseTo(50);
    expect(mid.top).toBeCloseTo(50);
  });

  it("3D 網格：平地的法線朝上、北在 +y、頂點數 = (段數+1)²", () => {
    const flat = { data: new Float32Array(16).fill(0.5), width: 4, height: 4 };
    const m = buildTerrainMesh(flat, 1.2, 8, 0.12);
    expect(m.positions.length).toBe(81 * 3);
    expect(m.indices.length).toBe(8 * 8 * 6);
    for (let i = 0; i < 81; i++) expect([...m.normals.slice(i * 3, i * 3 + 3)].map((x) => x + 0)).toEqual([0, 0, 1]);
    expect(m.positions[1]).toBeCloseTo(0.6); // 第一列 = 北邊
    expect(m.positions[2]).toBeCloseTo(0.06);
    // 東高西低 → 法線往西倒
    const ramp = { data: Float32Array.from({ length: 16 }, (_, i) => (i % 4) / 3), width: 4, height: 4 };
    const r = buildTerrainMesh(ramp, 1, 4, 1);
    expect(r.normals[12 * 3]!).toBeLessThan(0);
  });
});

describe("IPFS 打包", () => {
  it("★ 決定性：同樣的檔案不論輸入順序都是同一個根 CID；葉子就是標準的 raw CID", async () => {
    const files = [
      { path: "b/x.bin", bytes: new Uint8Array(3_000_000).map((_, i) => (i * 131) % 251) },
      { path: "a.txt", bytes: enc.encode("hello world") },
    ];
    const p1 = await packBundle(files);
    const p2 = await packBundle([...files].reverse());
    expect(p1.root.toString()).toBe(p2.root.toString());
    expect(p1.root.version).toBe(1);
    // 「hello world」的 raw CIDv1 —— 任何 IPFS 實作算出來都是這個
    expect(p1.blocks.map((b) => b.cid.toString())).toContain("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e");
    // 3 MB 以 1 MiB 分塊 → 3 片葉子 + 1 個檔案節點
    expect(p1.blocks.filter((b) => b.cid.code === 0x55).length).toBe(4);
    expect(p1.blocks[0]!.cid.toString()).toBe(p1.root.toString());
  });

  it("★ 往返：打包 → CAR → 拆回，位元組完全相同", async () => {
    const { files } = await sampleBundle();
    const p = await packBundle(files);
    const car = readCar(writeCar([p.root], p.blocks));
    expect(car.roots[0]!.toString()).toBe(p.root.toString());
    const back = await unpackBundle(car.roots[0]!, car.blocks);
    expect(back.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort());
    for (const f of back) expect(Buffer.from(f.bytes).equals(Buffer.from(files.find((x) => x.path === f.path)!.bytes))).toBe(true);
    expect((await packBundle(back)).root.toString()).toBe(p.root.toString());
  });

  it("拆包時不信任雜湊對不上的區塊", async () => {
    const p = await packBundle([{ path: "a.txt", bytes: enc.encode("hello world") }]);
    const bad = p.blocks.map((b) => (b.cid.code === 0x55 ? { ...b, bytes: enc.encode("hello WORLD") } : b));
    await expect(unpackBundle(p.root, bad)).rejects.toThrow(/不符/);
  });

  it("拒絕不合法的路徑與重複的路徑", async () => {
    await expect(packBundle([{ path: "../x", bytes: enc.encode("x") }])).rejects.toThrow();
    await expect(packBundle([{ path: "/x", bytes: enc.encode("x") }])).rejects.toThrow();
    await expect(packBundle([{ path: "x", bytes: enc.encode("1") }, { path: "x", bytes: enc.encode("2") }])).rejects.toThrow(/重複/);
  });
});

describe("Boltchain 委託索引", () => {
  async function rawBlocks(n: number) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, i);
      out.push({ cid: CID.create(1, 0x55, await sha256.digest(b)), bytes: b });
    }
    return out;
  }

  it("★ 與 Boltchain 的 Rust 實作（bolt-ipld `deal_index`）逐位元組相同", async () => {
    // 向量由 Boltchain 01205ae 的 crates/ipld 算出：2500 個 raw 區塊（第 i 個 = u32 大端序 i），入口 = 第 7 個
    const blocks = await rawBlocks(2500);
    const r = await buildDealIndex(blocks, blocks[7]!.cid);
    expect(r.cid.toString()).toBe("bafyreidldrytxza6yday7vw25ndur2oiz3tsiv6lg262lla6bcflhxommm");
    expect(r.index.groups.map(String)).toEqual([
      "bafyreig5y47u4qq64rysztfgfkbkzweu7mroadtxhjtk2veps2tmnsnpje",
      "bafyreicceepa35cfapbkule75hkm7dr6uybdi4s67zowwvudfrthesr7j4",
      "bafyreidxyisqnm6hoydqxl3gwxidiuphaoiln2sjs5opg44hiqqkpaswwy",
    ]);
    expect(r.index).toMatchObject({ v: 1, count: 2500, size: 10_000 });
    expect(r.indexBlocks.at(-1)!.cid.toString()).toBe(r.cid.toString());
    const small = await buildDealIndex(blocks.slice(0, 3), blocks[0]!.cid);
    expect(small.cid.toString()).toBe("bafyreihj6tnk3ddol7svey5wu44b6w3k53c5j6zulgi2qaf5jodu2zbwgi");
  });

  it("解碼回來：入口與分組列出的區塊都對得上", async () => {
    const blocks = await rawBlocks(1100);
    const r = await buildDealIndex(blocks, blocks[3]!.cid);
    const idx = decodeDealIndex(r.indexBlocks.at(-1)!.bytes)!;
    expect(idx.root!.toString()).toBe(blocks[3]!.cid.toString());
    expect(decodeDealGroup(r.indexBlocks[1]!.bytes).map(String)).toEqual(blocks.slice(1024).map((b) => b.cid.toString()));
    expect(decodeDealIndex(enc.encode("nope"))).toBeNull();
  });
});

describe("SwarmStorage 計價", () => {
  it("★ 照抄合約：MiB 無條件進位、每 epoch 費用無條件進位、× 副本 × epoch", () => {
    const priceWei = boltToWei("0.001");
    const c = dealCost({ sizeBytes: 968_359, replicas: 3, epochs: 100, priceWei });
    expect(c.mib).toBe(1n);
    expect(c.perEpochWei).toBe((priceWei * 1n + 1023n) / 1024n);
    expect(c.totalWei).toBe(c.perEpochWei * 300n);
    expect(dealCost({ sizeBytes: (1 << 20) + 1, replicas: 1, epochs: 1, priceWei: 1024n }).perEpochWei).toBe(2n);
  });

  it("★ S3 parity 出價：照這個單價付給 SwarmStorage 的錢 ≈ 同樣容量放在 S3 同樣時間", () => {
    const price = s3ParityPriceBolt(0.023, 86_400, 0.005);
    expect(price).toBeCloseTo(0.16226, 4);
    const sizeBytes = 512 * 2 ** 20; // 整數 MiB，避開進位
    const c = dealCost({ sizeBytes, replicas: 3, epochs: 1461, priceWei: boltToWei(price.toFixed(18)) });
    const paidUsd = (Number(c.totalWei) / 1e18) * 0.005;
    const s3Usd = (sizeBytes / 1e9) * 3 * 0.023 * 48;
    expect(paidUsd / s3Usd).toBeCloseTo(1, 3);
    expect(() => s3ParityPriceBolt(0.023, 86_400, 0)).toThrow();
  });

  it("BOLT ↔ wei 不經過浮點", () => {
    expect(boltToWei("1")).toBe(10n ** 18n);
    expect(boltToWei("0.000000000000000001")).toBe(1n);
    expect(boltToWei("12.5")).toBe(125n * 10n ** 17n);
    expect(() => boltToWei("1e-3")).toThrow();
    expect(weiToBolt(1_234_567_000_000_000_000n, 4)).toBe("1.2345");
    expect(weiToBolt(10n ** 18n)).toBe("1");
  });

  it("★ 四年在測試網（1 小時一個 epoch）超過單筆上限：拆成接力的委託", () => {
    const epochs = epochsFor(48, 3_600);
    expect(epochs).toBe(35_064);
    const chain = dealChain(epochs);
    expect(chain.length).toBe(10);
    expect(chain.every((e) => e <= MAX_DEAL_EPOCHS)).toBe(true);
    expect(chain.reduce((s, e) => s + e, 0)).toBe(epochs);
    expect(dealChain(epochsFor(48, 86_400))).toEqual([1461]);
    const q = quoteRetention(37_000_000, { replicas: 3, priceBolt: "0.01", epochSeconds: 3_600, months: 48, renewLeadEpochs: 24 });
    expect(q.deals).toBe(10);
    expect(q.totalWei).toBe(dealCost({ sizeBytes: 37_000_000, replicas: 3, epochs: 35_064, priceWei: boltToWei("0.01") }).totalWei);
  });

  it("★ 預算書的保存那一行講明是 SwarmStorage，並算進總額", () => {
    const b = buildBudget({
      steps: planSteps(null),
      done: 0,
      pick: (k) => (k === "PARAMS" ? "anthropic" : "google"),
      actual: { byKind: emptyKindTotals(), failed: { tokens: 0, micros: 0 } },
      received: { count: 0, grossMicros: 0, feeMicros: 0, taxMicros: 0, chargebackMicros: 0 },
      allocated: null,
      config: DEFAULT_BUDGET_CONFIG,
    });
    const line = b.lines.find((l) => l.key === "operations.storage")!;
    expect(line.basis).toContain("Boltchain SwarmStorage 3");
    expect(line.basis).toContain("參考 AWS S3 Standard");
    expect(line.basis).toContain("參考 Ethereum 主網");
    expect(line.basis).toContain("1 筆（1,461 個 epoch）");
    const more = buildBudget({
      steps: planSteps(null),
      done: 0,
      pick: (k) => (k === "PARAMS" ? "anthropic" : "google"),
      actual: { byKind: emptyKindTotals(), failed: { tokens: 0, micros: 0 } },
      received: { count: 0, grossMicros: 0, feeMicros: 0, taxMicros: 0, chargebackMicros: 0 },
      allocated: null,
      config: { ...DEFAULT_BUDGET_CONFIG, swarmReplicas: 6 },
    });
    expect(more.lines.find((l) => l.key === "operations.storage")!.microsProjected).toBeGreaterThan(line.microsProjected);
  });

  it("bolt_hostBlocks 分批不超過上限；示範用戶端的交易雜湊自帶委託內容", async () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ cid: CID.parse("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e"), bytes: new Uint8Array(400 + i) }));
    const batches = hostBatches(blocks, 1000);
    expect(batches.flat().length).toBe(10);
    expect(batches.every((b) => b.reduce((s, x) => s + x.bytes.length, 0) <= 1000)).toBe(true);

    const demo = demoSwarmClient(3600, () => 3600_000 * 500);
    const tx = await demo.createDeal({ dealIndex: blocks[0]!.cid, blocks: 1, size: 1, replicas: 3, epochs: 3650, priceWei: 1n, valueWei: 1n });
    expect(await demo.receipt(tx)).toMatchObject({ state: "ACTIVE", startEpoch: 500, endEpoch: 4150 });
  });
});
