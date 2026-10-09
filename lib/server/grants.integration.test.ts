import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "@/lib/db";
import { fakePainter } from "@/lib/providers/fake";
import type { ReferenceSource } from "@/lib/providers/google-maps";
import { DEFAULT_BUDGET_CONFIG } from "@/lib/world/budget";
import { blockBounds, blockOf } from "@/lib/world/grid";
import { GRANT_PROCESSOR } from "@/lib/world/ledger";
import { PROVIDER_ORDER, type PainterId } from "@/lib/world/pricing";

import { loadBlockState, type StateDeps } from "./blocks";
import { runBlock, type BuilderDeps } from "./builder";
import { attachProcessorRef, confirmDonation, createDonation } from "./donations";
import { grantQuote, grantToBlock } from "./grants";
import { createHarness, seedUser, type Harness } from "./testing/db-harness";

const cfg = DEFAULT_BUDGET_CONFIG;
const stateDeps: StateDeps = { enabled: [...PROVIDER_ORDER], fallback: "google", config: cfg };

let h: Harness;
let clock = Date.UTC(2026, 9, 9, 12);
const now = () => (clock += 1000);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

/** 兩個全景 × 四個方向 = 8 個標記座標，測試跑得快 */
function smallReference(key: string): ReferenceSource {
  const [lat, lng] = key.split("_").map(Number) as [number, number];
  const b = blockBounds(blockOf({ lat: lat + 0.005, lng: lng + 0.005 }));
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

function deps(key: string): BuilderDeps {
  return { db: h.db, tx: h.tx, painterFor: (p) => fakePainter(p), reference: smallReference(key), state: stateDeps, now, holder: "admin-test" };
}

const grant = (key: string, painter: PainterId | null, resume = false) =>
  h.tx((tx) => grantToBlock(tx, { key, painter, resume, now: now(), deps: stateDeps }));

/** 管理員指令的迴圈：撥款 → 施工，直到完成 */
async function paint(key: string, painter: PainterId | null) {
  for (let round = 0; round < 20; round++) {
    const g = await grant(key, painter);
    if (!g.ok) return g;
    const out = await runBlock(deps(key), key, Infinity);
    if (out.at(-1) === "COMPLETED_NOW") return g;
  }
  throw new Error("二十輪還沒蓋完");
}

describe("平台撥款（pnpm block:paint）", () => {
  it("★ 沒有任何捐款：撥款 → 施工到完成；撥款不算捐款、不算捐款人", async () => {
    const key = "24.20_120.70";
    const first = await grant(key, "openai");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.grantedTwd).toBeGreaterThan(0);
    expect(first.state.status).toBe("BUILDING");
    expect(first.state.donationCount).toBe(0);
    expect(first.state.donorCount).toBe(0);
    expect(first.state.grantedMicros).toBe(first.grantedMicros);
    // 撥款是平台的票：指定由 OpenAI 畫
    expect(first.state.tally.winner).toBe("openai");
    // 沒有收款成本：預算書的手續費、稅只剩已收的實際（0）
    expect(first.state.budget.lines.find((l) => l.key === "collection.fee")!.microsProjected).toBe(0);
    expect(grantQuote(first.state)).toBe(0);

    await paint(key, "openai");
    const s = (await loadBlockState(h.db, key, now(), stateDeps))!;
    expect(s.status).toBe("COMPLETE");
    const painters = new Set(s.log.filter((l) => l.status === "SUCCEEDED" && l.kind !== "SURVEY" && l.kind !== "PARAMS").map((l) => l.provider));
    expect([...painters]).toEqual(["openai"]);
    // 帳：收入全部是撥款，結餘不會是負的
    expect(s.grantedMicros).toBe(s.budget.grossReceivedMicros);
    expect(s.budget.surplusMicros).toBeGreaterThanOrEqual(0);
    const rows = await h.db.select().from(schema.donations);
    expect(rows.every((r) => r.processor === GRANT_PROCESSOR && r.feeMicros === 0 && r.taxMicros === 0 && r.status === "PAID")).toBe(true);

    // 完成之後不能再撥
    const again = await grant(key, null);
    expect(again).toEqual({ ok: false, reason: "BLOCK_COMPLETE" });
  });

  it("★ 已經有人捐款：只補差額；捐款人與捐款筆數照舊，撥款另外列", async () => {
    const key = "24.21_120.70";
    const donor = await seedUser(h);
    const d = await createDonation(h.db, { blockKey: key, donorId: donor, amountTwd: 100, vote: "google", processor: "demo", enabled: [...PROVIDER_ORDER], config: cfg });
    if (!d.ok) throw new Error(d.reason);
    await attachProcessorRef(h.db, d.donationId, "ref-g1");
    await h.tx((tx) => confirmDonation(tx, { processor: "demo", processorRef: "ref-g1", amountTwd: 100, now: now(), config: cfg }));
    const before = (await loadBlockState(h.db, key, now(), stateDeps))!;
    const quote = grantQuote(before);
    expect(quote).toBeGreaterThan(0);

    const g = await grant(key, null);
    if (!g.ok) throw new Error(g.reason);
    // 撥的是淨額缺口（換成新台幣整數時進位，誤差在一元以內）
    expect(g.grantedMicros).toBeGreaterThanOrEqual(quote);
    expect(g.grantedMicros - quote).toBeLessThan(1_000_000 / cfg.twdPerUsd + 1);
    expect(g.state.donationCount).toBe(1);
    expect(g.state.donorCount).toBe(1);
    // 不投票的撥款不改變捐款人的選擇
    expect(g.state.tally.winner).toBe("google");
    expect(g.state.budget.netGapMicros).toBe(0);
  });

  it("暫停的塊：不加 resume 就不動；加了才解除", async () => {
    const key = "24.22_120.70";
    const g = await grant(key, null);
    if (!g.ok) throw new Error(g.reason);
    await h.db.update(schema.blocks).set({ pausedAt: new Date(now()), pauseReason: "STEP_FAILED:AUTH" }).where(eq(schema.blocks.key, key));
    expect((await runBlock(deps(key), key, Infinity)).at(-1)).toBe("PAUSED");

    const still = await grant(key, null);
    expect(still.ok && still.resumed).toBe(false);
    expect(still.ok && still.state.status).toBe("PAUSED");

    const resumed = await grant(key, null, true);
    expect(resumed.ok && resumed.resumed).toBe(true);
    expect(resumed.ok && resumed.state.status).toBe("BUILDING");
  });

  it("拒絕：無效區塊、極區、沒啟用的畫師", async () => {
    expect(await grant("not-a-key", null)).toEqual({ ok: false, reason: "BAD_BLOCK" });
    expect(await grant("89.50_10.00", null)).toEqual({ ok: false, reason: "OCEAN_OR_POLE" });
    const onlyGoogle: StateDeps = { ...stateDeps, enabled: ["google"] };
    expect(await h.tx((tx) => grantToBlock(tx, { key: "24.23_120.70", painter: "openai", resume: false, now: now(), deps: onlyGoogle }))).toEqual({
      ok: false,
      reason: "PROVIDER_DISABLED",
    });
  });
});
