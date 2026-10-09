import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import { DEFAULT_BUDGET_CONFIG } from "@/lib/world/budget";
import { ORIGIN_BLOCK, blockBounds, blockKey, blockOf } from "@/lib/world/grid";
import { TEXTURES_PER_BLOCK } from "@/lib/world/plan";
import { PROVIDER_ORDER, type ProviderId } from "@/lib/world/pricing";
import { fakePainter } from "@/lib/providers/fake";
import type { ReferenceSource } from "@/lib/providers/google-maps";
import { PainterError, type Painter } from "@/lib/providers/painter";

import { readArtifact, listArtifacts } from "./artifacts";
import { loadBlockState, type StateDeps } from "./blocks";
import { runBlock, runOneStep, type BuilderDeps } from "./builder";
import { attachProcessorRef, confirmDonation, createDonation, setMyVote } from "./donations";
import { createHarness, seedUser, type Harness } from "./testing/pg-harness";

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

/** 只有兩個全景的參考來源：兩個全景 × 四個方向 = 8 個標記座標，測試跑得快 */
function smallReference(key: string): ReferenceSource {
  const b = blockBounds(blockOf({ lat: Number(key.split("_")[0]) + 0.005, lng: Number(key.split("_")[1]) + 0.005 }));
  const panos = [
    { panoId: "pa", location: { lat: b.south + 0.002, lng: b.west + 0.002 }, date: "2024-01" },
    { panoId: "pb", location: { lat: b.north - 0.002, lng: b.east - 0.002 }, date: "2024-02" },
  ];
  let i = 0;
  const gray = async () => {
    const { rasterizeSvg } = await import("@/lib/providers/image");
    return rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"><rect width="16" height="9" fill="#888"/></svg>', "16:9");
  };
  return {
    nearestPano: async () => panos[i++ % 7] ?? null,
    streetView: gray,
    layout: gray,
  };
}

function deps(over: Partial<BuilderDeps> & { key: string }): BuilderDeps {
  return {
    db: h.db,
    tx: h.tx,
    painterFor: (p) => fakePainter(p),
    reference: smallReference(over.key),
    state: stateDeps,
    now,
    holder: "test-worker",
    ...over,
  };
}

async function donate(key: string, donorId: string, amountTwd: number, vote: ProviderId | null, wish?: string) {
  const r = await createDonation(h.db, {
    blockKey: key,
    donorId,
    amountTwd,
    vote,
    wish,
    processor: "demo",
    enabled: [...PROVIDER_ORDER],
    config: cfg,
  });
  if (!r.ok) throw new Error(r.reason);
  const ref = `demo-${r.donationId}`;
  await attachProcessorRef(h.db, r.donationId, ref);
  const c = await confirmDonation(h.db, { processor: "demo", processorRef: ref, amountTwd, now: now(), config: cfg });
  if (!c.ok) throw new Error(c.reason);
  return { donationId: r.donationId, ref };
}

const state = (key: string) => loadBlockState(h.db, key, now() + 10 * 60_000 + 5_000, stateDeps);

describe("捐款", () => {
  it("★ 驗證：金額下限、停用的模型、無效區塊", async () => {
    const donor = await seedUser(h);
    const base = { donorId: donor, processor: "demo", enabled: ["google"] as ProviderId[], config: cfg, vote: null };
    expect(await createDonation(h.db, { ...base, blockKey: "25.03_121.56", amountTwd: 10 })).toEqual({ ok: false, reason: "AMOUNT_TOO_SMALL" });
    expect(await createDonation(h.db, { ...base, blockKey: "25.03_121.56", amountTwd: 100, vote: "openai" })).toEqual({ ok: false, reason: "PROVIDER_DISABLED" });
    expect(await createDonation(h.db, { ...base, blockKey: "nope", amountTwd: 100 })).toEqual({ ok: false, reason: "BAD_BLOCK" });
    expect(await createDonation(h.db, { ...base, blockKey: "89.99_0.00", amountTwd: 100 })).toEqual({ ok: false, reason: "OCEAN_OR_POLE" });
  });

  it("★ 入帳冪等、金額對不上拒收、拆帳寫入", async () => {
    const donor = await seedUser(h);
    const key = "25.04_121.56";
    const r = await createDonation(h.db, { blockKey: key, donorId: donor, amountTwd: 500, vote: "google", processor: "demo", enabled: [...PROVIDER_ORDER], config: cfg });
    if (!r.ok) throw new Error("create failed");
    await attachProcessorRef(h.db, r.donationId, "ref-a");
    expect(await confirmDonation(h.db, { processor: "demo", processorRef: "ref-a", amountTwd: 50, now: now(), config: cfg })).toEqual({ ok: false, reason: "AMOUNT_MISMATCH" });
    const first = await confirmDonation(h.db, { processor: "demo", processorRef: "ref-a", amountTwd: 500, now: now(), config: cfg });
    const again = await confirmDonation(h.db, { processor: "demo", processorRef: "ref-a", amountTwd: 500, now: now(), config: cfg });
    expect(first).toMatchObject({ ok: true, alreadyPaid: false });
    expect(again).toMatchObject({ ok: true, alreadyPaid: true });
    const [d] = await h.db.select().from(schema.donations).where(eq(schema.donations.id, r.donationId));
    expect(d!.status).toBe("PAID");
    expect(d!.grossMicros).toBe(15_625_000);
    expect(d!.netMicros).toBe(d!.grossMicros - d!.feeMicros - d!.taxMicros - d!.chargebackMicros);
    const s = await state(key);
    expect(s!.donationCount).toBe(1);
    expect(s!.budget.grossReceivedMicros).toBe(15_625_000);
  });

  it("★ 一筆捐款一張票；可以整批改投或撤回", async () => {
    const key = "25.05_121.56";
    const a = await seedUser(h);
    const b = await seedUser(h);
    await donate(key, a, 300, "google");
    await donate(key, a, 100, null);
    await donate(key, b, 200, "anthropic");
    let s = await state(key);
    expect(s!.tally.weights.google).toBe(9_375_000);
    expect(s!.tally.weights.anthropic).toBe(6_250_000);
    expect(s!.tally.votedMicros).toBe(15_625_000);
    expect(s!.tally.totalMicros).toBe(18_750_000);
    expect(s!.tally.winner).toBe("google");

    expect(await setMyVote(h.db, { blockKey: key, donorId: a, vote: "anthropic", enabled: [...PROVIDER_ORDER] })).toEqual({ ok: true, changed: 2 });
    s = await state(key);
    expect(s!.tally.winner).toBe("anthropic");
    expect(s!.tally.weights.anthropic).toBe(18_750_000);
  });
});

describe("施工", () => {
  it("★ 從捐款到完工：勘查 → 參數 → 場景 → 底圖 → 3D → 材質，帳對得上", async () => {
    const key = blockKey(ORIGIN_BLOCK);
    const donor = await seedUser(h);
    await donate(key, donor, 2000, "google", "請保留河邊的白鷺");
    const d = deps({ key });

    const outcomes = await runBlock(d, key, Infinity);
    expect(outcomes.at(-1)).toBe("COMPLETED_NOW");
    expect(outcomes.filter((o) => o === "FAILED")).toEqual([]);

    const s = await state(key);
    expect(s!.status).toBe("COMPLETE");
    expect(s!.row!.viewpoints).toHaveLength(8); // 2 個全景 × 4 個方向
    expect(s!.steps.map((x) => x.kind)).toEqual([
      "SURVEY",
      "PARAMS",
      ...Array(8).fill("SCENE"),
      "TILE",
      "DSM",
      ...Array(TEXTURES_PER_BLOCK).fill("TEXTURE"),
    ]);
    expect(s!.done).toBe(s!.steps.length);
    expect(s!.row!.params!.markers).toHaveLength(8);

    // 帳：已花費 = token + 參考影像 + 收款成本 + 撥付的保存與分攤；建設行的實際 = 預計
    const b = s!.budget;
    expect(b.nextStepMicros).toBeNull();
    expect(s!.row!.storageAllocatedMicros).toBeGreaterThan(0);
    expect(b.meters.tokensSpent).toBe(b.meters.tokensNeeded);
    for (const l of b.lines.filter((x) => x.group === "construction")) expect(l.microsActual).toBe(l.microsProjected);
    expect(b.surplusMicros).toBeGreaterThan(0);

    // 完成了才拿得到圖
    const arts = await listArtifacts(h.db, key);
    expect(arts!.filter((a) => a.kind === "SCENE")).toHaveLength(8);
    expect(arts!.filter((a) => a.kind === "TEXTURE")).toHaveLength(TEXTURES_PER_BLOCK);
    const tile = await readArtifact(h.db, key, "TILE", 0, "full");
    expect(tile.ok).toBe(true);
  });

  it("★ 未完成的區塊不給圖", async () => {
    const key = "25.03_121.57";
    const donor = await seedUser(h);
    await donate(key, donor, 2000, "google");
    const d = deps({ key });
    for (let i = 0; i < 4; i++) await runOneStep(d, key);
    expect((await state(key))!.status).not.toBe("COMPLETE");
    expect(await readArtifact(h.db, key, "SCENE", 0, "full")).toEqual({ ok: false, reason: "NOT_COMPLETE" });
    expect(await listArtifacts(h.db, key)).toBeNull();
  });

  it("★ 錢不夠就停在那一步等；再捐就接著蓋", async () => {
    const key = "25.02_121.56";
    const donor = await seedUser(h);
    await donate(key, donor, 30, "google");
    const d = deps({ key });
    const first = await runBlock(d, key, Infinity);
    expect(first.at(-1)).toBe("WAITING_FOR_FUNDS");
    let s = await state(key);
    expect(s!.status).toBe("FUNDING");
    const doneBefore = s!.done;
    expect(doneBefore).toBeGreaterThan(0); // 勘查免費，至少做得了

    await donate(key, donor, 2000, null);
    const second = await runBlock(d, key, Infinity);
    expect(second.at(-1)).toBe("COMPLETED_NOW");
    s = await state(key);
    expect(s!.status).toBe("COMPLETE");
  });

  it("★ 施工途中票數翻盤，下一步就換模型畫", async () => {
    const key = "25.03_121.55";
    const a = await seedUser(h);
    const b = await seedUser(h);
    await donate(key, a, 500, "google");
    const d = deps({ key });
    for (let i = 0; i < 4; i++) await runOneStep(d, key); // 勘查、參數、兩張場景
    await donate(key, b, 3000, "anthropic");
    await runBlock(d, key, Infinity);

    const steps = await h.db.select().from(schema.steps).where(eq(schema.steps.blockId, (await state(key))!.row!.id)).orderBy(schema.steps.seq);
    const providers = steps.filter((s) => s.kind !== "SURVEY").map((s) => s.provider);
    expect(providers.slice(0, 3)).toEqual(["google", "google", "google"]);
    expect(providers.slice(3).every((p) => p === "anthropic")).toBe(true);
    // 每一步都記下了開工當下的排名
    expect(steps.at(-1)!.tally!.ranking[0]).toBe("anthropic");
  });

  it("★ GPT Image 贏了，地圖參數那一步交給排名下一家", async () => {
    const key = "25.03_121.54";
    const donor = await seedUser(h);
    await donate(key, donor, 2000, "openai");
    const d = deps({ key });
    await runOneStep(d, key); // 勘查
    await runOneStep(d, key); // 參數
    await runOneStep(d, key); // 第一張場景
    const steps = await h.db.select().from(schema.steps).where(eq(schema.steps.blockId, (await state(key))!.row!.id)).orderBy(schema.steps.seq);
    expect(steps.map((s) => [s.kind, s.provider])).toEqual([
      ["SURVEY", null],
      ["PARAMS", "google"],
      ["SCENE", "openai"],
    ]);
  });

  it("★ 失敗照樣記帳；連續失敗三次就暫停；金鑰被拒立刻暫停", async () => {
    const key = "25.01_121.56";
    const donor = await seedUser(h);
    await donate(key, donor, 2000, "google");
    let calls = 0;
    const blocked: Painter = {
      provider: "google",
      model: "gemini-3.1-flash-image-preview",
      async paint() {
        calls++;
        throw new PainterError("SAFETY", "blocked", { textIn: 1000, imageIn: 0, textOut: 0, imageOut: 0 }, "gemini-3.1-flash-image-preview");
      },
    };
    const d = deps({ key, painterFor: () => blocked });
    const outcomes = await runBlock(d, key, Infinity);
    expect(outcomes).toEqual(["SUCCEEDED", "FAILED", "FAILED", "FAILED", "PAUSED"]);
    expect(calls).toBe(3);
    const s = await state(key);
    expect(s!.status).toBe("PAUSED");
    expect(s!.row!.pauseReason).toBe("STEP_FAILED:SAFETY");
    expect(s!.budget.meters.tokensSpent).toBe(3000);
    const retry = s!.budget.lines.find((l) => l.key === "contingency.retry")!;
    expect(retry.microsActual).toBeGreaterThan(3 * 500); // 3 × 1000 token × $0.5/M + 參考影像費

    const key2 = "25.00_121.56";
    await donate(key2, donor, 2000, "google");
    const denied: Painter = { ...blocked, async paint() { throw new PainterError("AUTH", "bad key"); } };
    const d2 = deps({ key: key2, painterFor: () => denied });
    expect(await runBlock(d2, key2, Infinity)).toEqual(["SUCCEEDED", "FAILED", "PAUSED"]);
  });

  it("★ 租約：同一塊同時只有一個工作者在畫", async () => {
    const key = "25.03_121.53";
    const donor = await seedUser(h);
    await donate(key, donor, 2000, "google");
    const d = deps({ key });
    const [x, y] = await Promise.all([runOneStep(d, key), runOneStep({ ...d, holder: "other" }, key)]);
    expect([x, y].sort()).toEqual(["LOCKED", "SUCCEEDED"]);
  });

  it("★ 完工後不能再捐、不能改票", async () => {
    const key = blockKey(ORIGIN_BLOCK);
    const donor = await seedUser(h);
    const r = await createDonation(h.db, { blockKey: key, donorId: donor, amountTwd: 100, vote: null, processor: "demo", enabled: [...PROVIDER_ORDER], config: cfg });
    expect(r).toEqual({ ok: false, reason: "BLOCK_COMPLETE" });
    expect(await setMyVote(h.db, { blockKey: key, donorId: donor, vote: "google", enabled: [...PROVIDER_ORDER] })).toEqual({ ok: false, reason: "BLOCK_COMPLETE" });
  });
});
