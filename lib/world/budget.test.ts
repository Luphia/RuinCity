import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGET_CONFIG,
  buildBudget,
  grossUp,
  storageMicros,
  type BudgetInput,
} from "./budget";
import { splitDonation, toMicros } from "./ledger";
import { fallbackParams, paramsBrief, parseMapParams } from "./params";
import { emptyKindTotals, planSteps } from "./plan";
import type { ProviderId } from "./pricing";

const cfg = DEFAULT_BUDGET_CONFIG;
const pickAll = (p: ProviderId) => (kind: string): ProviderId => (kind === "PARAMS" ? "anthropic" : p);

function input(over: Partial<BudgetInput> = {}): BudgetInput {
  return {
    steps: planSteps(null),
    done: 0,
    pick: pickAll("google"),
    actual: { byKind: emptyKindTotals(), failed: { tokens: 0, micros: 0 } },
    received: { count: 0, grossMicros: 0, feeMicros: 0, taxMicros: 0, chargebackMicros: 0 },
    allocated: null,
    config: cfg,
    ...over,
  };
}

/** 預算書各行（不含結餘）加總 */
const sum = (b: ReturnType<typeof buildBudget>) =>
  b.lines.filter((l) => l.group !== "surplus").reduce((s, l) => s + l.microsProjected, 0);

describe("預算書", () => {
  it("★ 列出使用者指定的每一項，外加補齊的項目", () => {
    const b = buildBudget(input());
    const keys = b.lines.map((l) => l.key);
    for (const k of [
      "construction.PARAMS",
      "construction.SCENE",
      "construction.TILE",
      "construction.DSM",
      "construction.TEXTURE",
      "reference",
      "contingency.retry",
      "contingency.volatility",
      "operations.storage",
      "operations.compute",
      "operations.platform",
      "collection.fee",
      "collection.tax",
      "collection.chargeback",
    ]) {
      expect(keys, k).toContain(k);
    }
    expect(b.lines.find((l) => l.key === "construction.SCENE")!.label).toBe("標記座標場景圖 ×100");
    expect(b.lines.find((l) => l.key === "construction.TEXTURE")!.label).toBe("材質貼圖 ×8");
    for (const l of b.lines) expect(l.basis.length, l.key).toBeGreaterThan(10);
  });

  it("★ 各行加起來等於募款目標（每一分錢都找得到一行）", () => {
    const b = buildBudget(input());
    expect(Math.abs(sum(b) - b.meters.grossNeededMicros)).toBeLessThanOrEqual(5);
    // 已收一部分之後也一樣
    const d = splitDonation(500, 32, cfg);
    const b2 = buildBudget(
      input({ received: { count: 1, grossMicros: d.grossMicros, feeMicros: d.feeMicros, taxMicros: d.taxMicros, chargebackMicros: d.chargebackMicros } }),
    );
    expect(Math.abs(sum(b2) - b2.meters.grossNeededMicros)).toBeLessThanOrEqual(5);
  });

  it("★ 超募時多的錢列成結餘：所需不會因為捐得多而變大，所需 + 結餘 = 已募得", () => {
    const d = splitDonation(100_000, 32, cfg);
    const b = buildBudget(
      input({ received: { count: 1, grossMicros: d.grossMicros, feeMicros: d.feeMicros, taxMicros: d.taxMicros, chargebackMicros: d.chargebackMicros } }),
    );
    expect(b.grossGapMicros).toBe(0);
    const surplus = b.lines.find((l) => l.key === "surplus")!.microsProjected;
    expect(surplus).toBe(b.surplusProjectedMicros);
    expect(surplus).toBeGreaterThan(0);
    expect(Math.abs(sum(b) - b.meters.grossNeededMicros)).toBeLessThanOrEqual(5);
    expect(Math.abs(b.meters.grossNeededMicros + surplus - d.grossMicros)).toBeLessThanOrEqual(5);
    // 所需遠小於捐款總額
    expect(b.meters.grossNeededMicros).toBeLessThan(d.grossMicros / 10);
  });

  it("以 Gemini 蓋完一塊在臺北：約新台幣三到五百元，主要是一百張場景圖", () => {
    const b = buildBudget(input());
    const twd = (b.meters.grossNeededMicros / 1e6) * cfg.twdPerUsd;
    expect(twd).toBeGreaterThan(250);
    expect(twd).toBeLessThan(500);
    const scene = b.lines.find((l) => l.key === "construction.SCENE")!;
    const tokenLines = b.lines.filter((l) => l.group === "construction");
    expect(scene.microsProjected).toBeGreaterThan(0.8 * tokenLines.reduce((s, l) => s + l.microsProjected, 0));
  });

  it("★ 投票換模型，預算跟著變：GPT Image 的影像比 Gemini 貴", () => {
    const g = buildBudget(input({ pick: pickAll("google") }));
    const o = buildBudget(input({ pick: pickAll("openai") }));
    expect(o.meters.grossNeededMicros).toBeGreaterThan(g.meters.grossNeededMicros);
    expect(o.meters.tokensNeeded).not.toBe(g.meters.tokensNeeded);
  });

  it("★ 收款成本倒推：淨額要的是 X，總額得募到 X ÷ (1 − 費率 − 稅 − 準備) 再加每筆固定費", () => {
    const net = toMicros(1000, cfg.twdPerUsd);
    const { gross, donations } = grossUp(net, cfg);
    const keep = 1 - cfg.paymentFeeRate - cfg.taxRate - cfg.chargebackRate;
    expect(donations).toBe(Math.ceil(gross / toMicros(cfg.avgDonationTwd, cfg.twdPerUsd)));
    expect(gross).toBe(Math.ceil((net + donations * toMicros(cfg.paymentFeeFixedTwd, cfg.twdPerUsd)) / keep));
    expect(grossUp(0, cfg).gross).toBe(0);
    expect(() => grossUp(1, { ...cfg, taxRate: 0.99 })).toThrow();
  });

  it("★ 四年保存：容量照 AWS S3、委託手續費照 Ethereum gas，每一項都算得出來", () => {
    const s = storageMicros({ PARAMS: 1, SCENE: 100, TILE: 1, DSM: 1, TEXTURE: 8 }, cfg);
    expect(s.bytes).toBeGreaterThan(30e6);
    expect(s.bytes).toBeLessThan(40e6);
    expect(s.copies).toBe(4); // 站內 1 + SwarmStorage 3
    // 容量：GB × 4 份 × 48 個月 × US$0.023
    expect(s.capacityMicros).toBe(Math.ceil((s.bytes / 1e9) * 4 * 48 * 0.023 * 1e6));
    // 傳輸：2,000 次 × 5 MB × US$0.09/GB = US$0.90
    expect(s.egressMicros).toBe(900_000);
    // 主網一個 epoch 約一天：四年 1,461 個 epoch，一筆委託
    expect(s.epochs).toBe(1461);
    expect(s.deals).toBe(1);
    // 650k gas × 1.5 gwei × US$2,500 = US$2.4375
    expect(s.gasMicros).toBe(2_437_500);
    expect(s.micros).toBe(s.capacityMicros + s.requestMicros + s.egressMicros + s.gasMicros);
    // 測試網一個 epoch 1 小時：要接力 10 筆，手續費 ×10
    const testnet = storageMicros({ PARAMS: 1, SCENE: 100, TILE: 1, DSM: 1, TEXTURE: 8 }, { ...cfg, swarmEpochSeconds: 3_600 });
    expect(testnet.deals).toBe(10);
    expect(testnet.gasMicros).toBe(24_375_000);
  });

  it("★ 預備只對還沒做的提列；做完時預備歸零", () => {
    const steps = planSteps(0);
    const done = buildBudget(input({ steps, done: steps.length }));
    expect(done.lines.find((l) => l.key === "contingency.retry")!.microsProjected).toBe(0);
    expect(done.lines.find((l) => l.key === "contingency.volatility")!.microsProjected).toBe(0);
    expect(done.nextStepMicros).toBeNull();
  });

  it("★ 失敗的嘗試算在重試準備的實際欄，不重複算進建設行；token 照樣計入已花費", () => {
    const b = buildBudget(input({ actual: { byKind: emptyKindTotals(), failed: { tokens: 5000, micros: 70_000 } } }));
    const retry = b.lines.find((l) => l.key === "contingency.retry")!;
    expect(retry.microsActual).toBe(70_000);
    expect(b.meters.tokensSpent).toBe(5000);
    expect(b.meters.moneySpentMicros).toBe(70_000);
    expect(b.lines.filter((l) => l.group === "construction").every((l) => l.microsActual === 0)).toBe(true);
  });

  it("★ 施工餘額 = 淨額 − 圈存的保存與分攤 − 已花費", () => {
    const d = splitDonation(300, 32, cfg);
    const b = buildBudget(
      input({ received: { count: 1, grossMicros: d.grossMicros, feeMicros: d.feeMicros, taxMicros: d.taxMicros, chargebackMicros: d.chargebackMicros } }),
    );
    expect(b.netReceivedMicros).toBe(d.netMicros);
    expect(b.constructionBalanceMicros).toBe(d.netMicros - b.ringFencedMicros);
    expect(b.meters.moneySpentMicros).toBe(d.feeMicros + d.taxMicros + d.chargebackMicros);
  });

  it("平台管理費預設為 0，而且明說", () => {
    const l = buildBudget(input()).lines.find((x) => x.key === "operations.platform")!;
    expect(l.microsProjected).toBe(0);
    expect(l.basis).toContain("0%");
    const charged = buildBudget(input({ config: { ...cfg, platformFeeRate: 0.1 } }));
    expect(charged.lines.find((x) => x.key === "operations.platform")!.microsProjected).toBeGreaterThan(0);
  });
});

describe("地圖參數", () => {
  const good = JSON.stringify({
    biome: "flooded riverside forest",
    waterLevel: "partly flooded",
    vegetationDensity: 0.9,
    ruinState: "towers are hollow",
    palette: ["green", "rust"],
    landmarks: [{ name: "Taipei 101", description: "broken" }],
    materials: ["a", "b", "c", "d", "e", "f", "g", "h"],
    markers: [
      { index: 0, caption: "egret in a flooded avenue" },
      { index: 1, caption: "banyan over a shrine" },
    ],
    fieldNote: "水淹到膝蓋。",
  });

  it("合法的 JSON 原樣收下（含 Markdown 圍欄）", () => {
    const { params, repaired } = parseMapParams("```json\n" + good + "\n```", 2);
    expect(repaired).toBe(false);
    expect(params.waterLevel).toBe("partly flooded");
    expect(params.markers.map((m) => m.caption)).toEqual(["egret in a flooded avenue", "banyan over a shrine"]);
  });

  it("★ 修正而不是拒絕：夾回範圍、補足材質與每個標記的說明", () => {
    const { params, repaired } = parseMapParams(
      JSON.stringify({ waterLevel: "lava", vegetationDensity: 7, materials: ["only one"], markers: [{ index: 9, caption: "x" }] }),
      3,
    );
    expect(repaired).toBe(true);
    expect(params.waterLevel).toBe("damp");
    expect(params.vegetationDensity).toBe(1);
    expect(params.materials).toHaveLength(8);
    expect(params.materials[0]).toBe("only one");
    expect(params.markers).toHaveLength(3);
  });

  it("解析不了就用預設，施工不會卡在第二步", () => {
    const { params, repaired } = parseMapParams("I cannot help with that.", 4);
    expect(repaired).toBe(true);
    expect(params).toEqual(fallbackParams(4));
    expect(paramsBrief(params)).toContain("Water level: damp");
  });
});
