import { describe, expect, it } from "vitest";

import {
  BLOCK_DEG,
  COLS,
  ORIGIN_BLOCK,
  ROWS,
  TAIPEI_101,
  blockBounds,
  blockCenter,
  blockKey,
  blockLabel,
  blockOf,
  blockShortLabel,
  blockSizeM,
  blocksInBounds,
  bearingDeg,
  mercatorFrame,
  parseBlockKey,
  surveyProbes,
} from "./grid";
import {
  MODEL_PROFILES,
  PROVIDER_ORDER,
  REFERENCE_FEE_MICROS,
  supports,
  usageCostMicros,
  type ProviderId,
} from "./pricing";
import {
  DEFAULT_SCENES,
  MIN_OBSERVED,
  TEXTURES_PER_BLOCK,
  averageObserved,
  estimateRemaining,
  planSteps,
} from "./plan";
import { pickFor, tallyVotes } from "./vote";
import { START_MARGIN, blockStatus, canStartStep, formatTwd, splitDonation, toMicros } from "./ledger";
import {
  TAIPEI_101_VISIBLE_M,
  dsmJob,
  neighborOf,
  paramsJob,
  sampleIndexes,
  sceneJob,
  textureJob,
  tileAspect,
  tileJob,
  wishesText,
} from "./prompts";
import { chooseViewpoints } from "./survey";

describe("經緯度網格", () => {
  it("★ 臺北 101 落在 25.03_121.56 —— 世界的原點", () => {
    expect(blockKey(ORIGIN_BLOCK)).toBe("25.03_121.56");
    expect(blockShortLabel(ORIGIN_BLOCK)).toBe("N25.03° E121.56°");
    const b = blockBounds(ORIGIN_BLOCK);
    expect(TAIPEI_101.lat).toBeGreaterThanOrEqual(b.south);
    expect(TAIPEI_101.lat).toBeLessThan(b.north);
    expect(TAIPEI_101.lng).toBeGreaterThanOrEqual(b.west);
    expect(TAIPEI_101.lng).toBeLessThan(b.east);
  });

  it("★ 落在格線上的點屬於以它為西南角的那一塊（浮點不能把它推到隔壁）", () => {
    // 25.03 * 100 在 IEEE 754 是 2502.9999999999995
    expect(blockKey(blockOf({ lat: 25.03, lng: 121.56 }))).toBe("25.03_121.56");
    expect(blockKey(blockOf({ lat: -33.87, lng: 151.2 }))).toBe("-33.87_151.20");
    expect(blockKey(blockOf({ lat: 0, lng: 0 }))).toBe("0.00_0.00");
    expect(blockKey(blockOf({ lat: -0.000001, lng: -0.000001 }))).toBe("-0.01_-0.01");
  });

  it("每一塊的名字解析回同一塊；非正規寫法一律拒絕", () => {
    for (const p of [TAIPEI_101, { lat: -33.8688, lng: 151.2093 }, { lat: 51.5, lng: -0.12 }, { lat: 89.999, lng: 179.999 }]) {
      const b = blockOf(p);
      expect(parseBlockKey(blockKey(b))).toEqual(b);
    }
    expect(parseBlockKey("25.030_121.56")).toBeNull();
    expect(parseBlockKey("25.03_121.5")).toBeNull();
    expect(parseBlockKey("-0.00_0.00")).toBeNull(); // 與 0.00_0.00 同一塊，只能有一個名字
    expect(parseBlockKey("90.00_0.00")).toBeNull();
    expect(parseBlockKey("0.00_180.00")).toBeNull();
    expect(parseBlockKey("../etc")).toBeNull();
  });

  it("北極點與換日線不會產生不存在的格子", () => {
    expect(blockOf({ lat: 90, lng: 0 }).row).toBe(ROWS - 1);
    expect(blockOf({ lat: 0, lng: 180 }).col).toBe(0); // 180°E = 180°W
    expect(blockOf({ lat: 0, lng: -180 }).col).toBe(0);
    expect(blockOf({ lat: 0, lng: 179.999 }).col).toBe(COLS - 1);
  });

  it("中心與邊界一致；在臺北一塊約 1.0 km × 1.1 km", () => {
    const c = blockCenter(ORIGIN_BLOCK);
    expect(c.lat).toBeCloseTo(25.035, 9);
    expect(c.lng).toBeCloseTo(121.565, 9);
    const { width, height } = blockSizeM(ORIGIN_BLOCK);
    expect(width).toBeGreaterThan(1000);
    expect(width).toBeLessThan(1020);
    expect(height).toBeGreaterThan(1100);
    expect(height).toBeLessThan(1120);
    expect(blockLabel(ORIGIN_BLOCK)).toBe("北緯 25.03°–25.04° · 東經 121.56°–121.57°");
  });

  it("★ 範圍查詢有上限 —— 縮到整個亞洲時不配置幾千萬個物件", () => {
    const small = blocksInBounds({ south: 25.03, north: 25.0499, west: 121.56, east: 121.5799 }, 100);
    expect(small).toHaveLength(4);
    expect(blocksInBounds({ south: 0, north: 50, west: 70, east: 140 }, 10_000)).toBeNull();
    // 跨換日線
    const wrap = blocksInBounds({ south: 0, north: 0.005, west: 179.995, east: -179.995 }, 100);
    expect(wrap?.map(blockKey)).toEqual(["0.00_179.99", "0.00_-180.00"]);
  });

  it("勘查探針 10×10，全部在塊內", () => {
    const probes = surveyProbes(ORIGIN_BLOCK);
    expect(probes).toHaveLength(100);
    for (const p of probes) expect(blockOf(p)).toEqual(ORIGIN_BLOCK);
  });

  it("★ 靜態地圖剛好框住一塊：寬高比與經緯度方塊在 Mercator 上的比一致，且不超過 640", () => {
    const f = mercatorFrame(ORIGIN_BLOCK);
    expect(f.zoom).toBe(16);
    expect(f.width).toBe(466);
    expect(f.height).toBeGreaterThan(510);
    expect(f.height).toBeLessThan(520);
    const far = mercatorFrame(blockOf({ lat: 65, lng: 25 }));
    expect(far.width).toBeLessThanOrEqual(640);
    expect(far.height).toBeLessThanOrEqual(640);
  });

  it("方位角：正北 0°、正東 90°", () => {
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 6);
    expect(bearingDeg({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 6);
    expect(BLOCK_DEG).toBe(0.01);
  });
});

describe("價格與施工計畫", () => {
  const always = (p: ProviderId) => () => p;

  it("token → 微美元：每百萬 $60 的 1,120 個輸出 token ≈ $0.0672", () => {
    const g = MODEL_PROFILES.google;
    expect(usageCostMicros(g.rates, { textIn: 0, imageIn: 0, textOut: 0, imageOut: 1120 })).toBe(67_200);
  });

  it("每一家做得了的步驟都有先驗；GPT Image 不寫文字", () => {
    expect([...PROVIDER_ORDER].sort()).toEqual(Object.keys(MODEL_PROFILES).sort());
    for (const id of PROVIDER_ORDER) {
      for (const k of ["SCENE", "TILE", "DSM", "TEXTURE"] as const) {
        expect(supports(id, k), `${id} ${k}`).toBe(true);
        const cost = usageCostMicros(MODEL_PROFILES[id].rates, MODEL_PROFILES[id].typical[k]!);
        expect(cost, `${id} ${k} 一步不該超過 1 美元`).toBeLessThan(1_000_000);
        expect(cost).toBeGreaterThan(0);
      }
    }
    expect(supports("openai", "PARAMS")).toBe(false);
    expect(supports("google", "PARAMS")).toBe(true);
    expect(supports("anthropic", "PARAMS")).toBe(true);
  });

  it("★ 施工順序：勘查 → 參數 → 100 張場景 → 底圖 → 3D → 8 張材質", () => {
    const steps = planSteps(null);
    expect(steps.filter((s) => s.kind === "SCENE")).toHaveLength(DEFAULT_SCENES);
    expect(DEFAULT_SCENES).toBe(100);
    expect(steps.slice(0, 2).map((s) => s.kind)).toEqual(["SURVEY", "PARAMS"]);
    expect(steps.slice(-10).map((s) => s.kind)).toEqual([
      "TILE",
      "DSM",
      ...Array(TEXTURES_PER_BLOCK).fill("TEXTURE"),
    ]);
    expect(planSteps(0).map((s) => s.kind)).toEqual(["SURVEY", "PARAMS", "TILE", "DSM", ...Array(8).fill("TEXTURE")]);
    expect(planSteps(250).filter((s) => s.kind === "SCENE")).toHaveLength(100);
  });

  it("★ 剩餘估計只算還沒做的步驟，參考影像費另計", () => {
    const steps = planSteps(1);
    const p = MODEL_PROFILES.google;
    const all = estimateRemaining(steps, 0, always("google"));
    expect(all.next?.step.kind).toBe("SURVEY");
    expect(all.byKind.SCENE.count).toBe(1);
    expect(all.byKind.TEXTURE.count).toBe(8);
    expect(all.byKind.SCENE.referenceMicros).toBe(REFERENCE_FEE_MICROS.streetViewImage);
    expect(all.byKind.SCENE.tokenMicros).toBe(usageCostMicros(p.rates, p.typical.SCENE!));
    const afterTile = estimateRemaining(steps, steps.findIndex((s) => s.kind === "DSM"), always("google"));
    expect(afterTile.byKind.SCENE.count).toBe(0);
    expect(afterTile.next?.step.kind).toBe("DSM");
    expect(estimateRemaining(steps, steps.length, always("google")).next).toBeNull();
  });

  it("★ 實際用量累積到門檻之後取代先驗 —— 估計會愈來愈準", () => {
    const usage = { textIn: 1000, imageIn: 1000, textOut: 0, imageOut: 2000 };
    const rows = (n: number) => Array.from({ length: n }, () => ({ provider: "openai" as const, kind: "SCENE" as const, usage }));
    expect(averageObserved(rows(MIN_OBSERVED - 1)).openai).toBeUndefined();
    const enough = averageObserved(rows(MIN_OBSERVED));
    expect(enough.openai?.SCENE).toEqual(usage);
    const steps = planSteps(1);
    const est = estimateRemaining(steps, 2, always("openai"), enough);
    expect(est.next?.usage).toEqual(usage);
  });
});

describe("依捐款金額加權投票", () => {
  const enabled = ["google", "openai", "anthropic"] as const;

  it("★ 權重是錢不是人頭：一位捐 300 的勝過兩位各捐 100", () => {
    const t = tallyVotes(
      [
        { donorId: "a", paidMicros: 300, vote: "anthropic" },
        { donorId: "b", paidMicros: 100, vote: "openai" },
        { donorId: "c", paidMicros: 100, vote: "openai" },
      ],
      enabled,
      "google",
    );
    expect(t.winner).toBe("anthropic");
    expect(t.weights.openai).toBe(200);
    expect(t.decidedBy).toBe("VOTES");
  });

  it("★ 不投票的錢照樣入帳，但不參與決定", () => {
    const t = tallyVotes(
      [
        { donorId: "a", paidMicros: 1000, vote: null },
        { donorId: "b", paidMicros: 1, vote: "openai" },
      ],
      enabled,
      "google",
    );
    expect(t.winner).toBe("openai");
    expect(t.totalMicros).toBe(1001);
    expect(t.votedMicros).toBe(1);
  });

  it("沒有人投票就用平台預設；預設停用時用第一個可用的", () => {
    const t0 = tallyVotes([{ donorId: "a", paidMicros: 5, vote: null }], enabled, "openai");
    expect(t0.winner).toBe("openai");
    expect(t0.ranking).toEqual(["openai", "google", "anthropic"]);
    expect(t0.decidedBy).toBe("DEFAULT");
    const t = tallyVotes([], ["anthropic"], "google");
    expect(t.winner).toBe("anthropic");
    expect(t.decidedBy).toBe("DEFAULT");
  });

  it("★ 投給停用那一家的票照樣顯示，但不能贏", () => {
    const t = tallyVotes(
      [
        { donorId: "a", paidMicros: 900, vote: "openai" },
        { donorId: "b", paidMicros: 100, vote: "google" },
      ],
      ["google", "anthropic"],
      "anthropic",
    );
    expect(t.weights.openai).toBe(900);
    expect(t.winner).toBe("google");
  });

  it("平手依固定順位，不是隨機", () => {
    const t = tallyVotes(
      [
        { donorId: "a", paidMicros: 100, vote: "anthropic" },
        { donorId: "b", paidMicros: 100, vote: "openai" },
      ],
      enabled,
      "google",
    );
    expect(t.winner).toBe("openai");
  });

  it("★ GPT Image 贏了也寫不了地圖參數：那一步交給排名下一家", () => {
    const t = tallyVotes(
      [
        { donorId: "a", paidMicros: 900, vote: "openai" },
        { donorId: "b", paidMicros: 100, vote: "anthropic" },
      ],
      enabled,
      "google",
    );
    expect(t.ranking).toEqual(["openai", "anthropic", "google"]);
    expect(pickFor(t, "SCENE")).toBe("openai");
    expect(pickFor(t, "PARAMS")).toBe("anthropic");
    expect(pickFor(t, "SURVEY")).toBe("openai");
  });

  it("一家都沒有啟用時誰也不能畫", () => {
    const t = tallyVotes([{ donorId: "a", paidMicros: 1, vote: "google" }], [], "google");
    expect(t.winner).toBeNull();
    expect(t.decidedBy).toBe("NONE");
    expect(pickFor(t, "SCENE")).toBeNull();
  });
});

describe("帳與狀態", () => {
  const cfg = { paymentFeeRate: 0.028, paymentFeeFixedTwd: 5, taxRate: 0.05, chargebackRate: 0.01 };

  it("新台幣入帳換成微美元（匯率快照）", () => {
    expect(toMicros(320, 32)).toBe(10_000_000);
    expect(formatTwd(10_000_000, 32)).toBe("NT$320");
    expect(formatTwd(100_000, 32)).toBe("NT$3.20");
  });

  it("★ 一筆捐款拆帳：手續費、稅、拒付準備都依總額計，剩下才是淨額", () => {
    const s = splitDonation(1000, 32, cfg);
    expect(s.grossMicros).toBe(31_250_000);
    expect(s.feeMicros).toBe(toMicros(1000 * 0.028 + 5, 32));
    expect(s.taxMicros).toBe(Math.round(31_250_000 * 0.05));
    expect(s.chargebackMicros).toBe(Math.round(31_250_000 * 0.01));
    expect(s.netMicros).toBe(s.grossMicros - s.feeMicros - s.taxMicros - s.chargebackMicros);
    // 金流商回報的實際手續費優先
    expect(splitDonation(1000, 32, cfg, 20).feeMicros).toBe(toMicros(20, 32));
    // 手續費不可能比捐款還多
    expect(splitDonation(1, 32, cfg).feeMicros).toBeLessThanOrEqual(toMicros(1, 32));
  });

  it("★ 開工要留緩衝：餘額剛好等於估價還不夠", () => {
    expect(canStartStep(100, 100)).toBe(false);
    expect(canStartStep(Math.ceil(100 * START_MARGIN), 100)).toBe(true);
  });

  it("狀態由帳推導；暫停要講出來", () => {
    const base = { constructionBalanceMicros: 0, completedAt: null, nextStepMicros: 1000, running: false };
    expect(blockStatus({ ...base, grossReceivedMicros: 0 })).toBe("UNFUNDED");
    expect(blockStatus({ ...base, grossReceivedMicros: 5, constructionBalanceMicros: 1000 })).toBe("FUNDING");
    expect(blockStatus({ ...base, grossReceivedMicros: 5, constructionBalanceMicros: 2000 })).toBe("BUILDING");
    expect(blockStatus({ ...base, grossReceivedMicros: 5, running: true })).toBe("BUILDING");
    expect(blockStatus({ ...base, grossReceivedMicros: 5, constructionBalanceMicros: 2000, paused: true })).toBe("PAUSED");
    expect(blockStatus({ ...base, grossReceivedMicros: 1, completedAt: new Date(0) })).toBe("COMPLETE");
  });
});

describe("繪製工作", () => {
  const vp = {
    panoId: "p1",
    location: { lat: 25.034, lng: 121.564 },
    heading: 45,
    pitch: 0,
    fov: 90,
    date: "2024-03",
  };
  const images = (job: { parts: readonly { kind: string }[] }) =>
    job.parts.filter((p) => p.kind === "image").map((p) => (p as unknown as { ref: unknown }).ref);

  it("場景：正典在最前、參考照在中間、16:9", () => {
    const job = sceneJob({ block: ORIGIN_BLOCK, viewpoint: vp, viewpointIndex: 7 });
    expect(job.aspect).toBe("16:9");
    expect(job.output).toBe("image");
    expect((job.parts[0] as { text: string }).text).toContain("One Thousand Years After");
    expect(images(job)).toEqual([{ type: "streetview", viewpoint: 7 }]);
  });

  it("★ 101 只在看得到的距離內被提起", () => {
    const near = sceneJob({ block: ORIGIN_BLOCK, viewpoint: vp, viewpointIndex: 0 });
    expect(JSON.stringify(near)).toContain("Taipei 101");
    const far = sceneJob({ block: blockOf({ lat: 22.6, lng: 120.3 }), viewpoint: vp, viewpointIndex: 0 });
    expect(JSON.stringify(far)).not.toContain("Taipei 101");
    expect(TAIPEI_101_VISIBLE_M).toBeGreaterThan(1000);
  });

  it("★ 參數：版型 + 平均挑 4 張街景 + 每個標記座標都列出來，要回 JSON", () => {
    const vps = Array.from({ length: 10 }, (_, i) => ({ ...vp, panoId: `p${i}` }));
    const job = paramsJob({ block: ORIGIN_BLOCK, viewpoints: vps });
    expect(job.output).toBe("text");
    expect(images(job)).toEqual([
      { type: "layout" },
      ...sampleIndexes(10, 4).map((i) => ({ type: "streetview", viewpoint: i })),
    ]);
    const text = JSON.stringify(job);
    expect(text).toContain("9: lat");
    expect(text).toContain("materials");
    expect(sampleIndexes(10, 4)).toEqual([1, 3, 6, 8]);
    expect(sampleIndexes(3, 4)).toEqual([0, 1, 2]);
    expect(sampleIndexes(0, 4)).toEqual([]);
  });

  it("底圖：版型 + 最多兩張場景 + 只有完成的鄰塊", () => {
    const job = tileJob({ block: ORIGIN_BLOCK, scenes: 100, neighbors: ["north", "west"] });
    expect(images(job)).toEqual([
      { type: "layout" },
      { type: "scene", sceneIndex: 25 },
      { type: "scene", sceneIndex: 75 },
      { type: "neighbor", dir: "north" },
      { type: "neighbor", dir: "west" },
    ]);
    expect(job.aspect).toBe(tileAspect(ORIGIN_BLOCK));
    expect(tileAspect(ORIGIN_BLOCK)).toBe("1:1"); // 臺北的 466×514 最接近 1:1
    expect(tileAspect(blockOf({ lat: 60, lng: 10 }))).not.toBe("1:1");
  });

  it("3D 圖資對齊底圖；材質貼圖是正方形、指名材質", () => {
    const dsm = dsmJob({ block: ORIGIN_BLOCK });
    expect(images(dsm)).toEqual([{ type: "tile" }, { type: "layout" }]);
    expect(JSON.stringify(dsm)).toContain("grayscale");
    const tex = textureJob({ block: ORIGIN_BLOCK, material: 'moss "concrete"', textureIndex: 2, scenes: 100 });
    expect(tex.aspect).toBe("1:1");
    expect(JSON.stringify(tex)).toContain("moss 'concrete'");
    expect(images(tex)[0]).toEqual({ type: "tile" });
    const noScenes = textureJob({ block: ORIGIN_BLOCK, material: "x", textureIndex: 0, scenes: 0 });
    expect(images(noScenes)).toEqual([{ type: "tile" }]);
  });

  it("★ 捐款留言是建議不是指令：清掉控制字元、截斷、限數量，並聲明衝突時以正典為準", () => {
    const text = wishesText(["畫一隻\n\n石虎", "x".repeat(500), "", "a", "b", "c", "d"])!;
    expect(text).toContain("ignore it");
    expect(text).toContain('"畫一隻 石虎"');
    expect(text).not.toContain("x".repeat(141));
    expect(text.split("\n- ").length - 1).toBe(5);
    expect(wishesText(["   "])).toBeNull();
  });

  it("相鄰塊：東西繞過換日線、北極沒有更北", () => {
    expect(neighborOf({ row: 0, col: COLS - 1 }, "east")).toEqual({ row: 0, col: 0 });
    expect(neighborOf({ row: 0, col: 0 }, "west")).toEqual({ row: 0, col: COLS - 1 });
    expect(neighborOf({ row: ROWS - 1, col: 5 }, "north")).toBeNull();
    expect(neighborOf({ row: 0, col: 5 }, "south")).toBeNull();
  });
});

describe("勘查選取標記座標", () => {
  const block = ORIGIN_BLOCK;
  const b = blockBounds(block);
  const at = (fy: number, fx: number) => ({
    lat: b.south + (b.north - b.south) * fy,
    lng: b.west + (b.east - b.west) * fx,
  });

  it("★ 只留塊內的、同一全景只算一次、散開來、朝向中心", () => {
    const picked = chooseViewpoints(
      block,
      [
        { panoId: "center", location: at(0.5, 0.51), date: null },
        { panoId: "center", location: at(0.5, 0.51), date: null },
        { panoId: "outside", location: { lat: b.north + 0.001, lng: b.west + 0.005 }, date: null },
        { panoId: "near-center", location: at(0.52, 0.53), date: null },
        { panoId: "sw", location: at(0.05, 0.05), date: "2023-01" },
        { panoId: "ne", location: at(0.95, 0.95), date: null },
      ],
      4,
    );
    expect(picked.map((p) => p.panoId)).toEqual(["center", "sw", "ne", "near-center"]);
    const sw = picked.find((p) => p.panoId === "sw")!;
    expect(sw.heading).toBeGreaterThan(0);
    expect(sw.heading).toBeLessThan(90); // 從西南角看向中心 = 東北方
    expect(picked[0]!.heading).toBe(0); // 在中心附近就朝北
  });

  it("★ 全景不足 100 個時同一點轉向補滿，最多四個方向", () => {
    const panos = Array.from({ length: 30 }, (_, i) => ({
      panoId: `p${i}`,
      location: at(0.1 + (i % 6) * 0.15, 0.1 + Math.floor(i / 6) * 0.18),
      date: null,
    }));
    const picked = chooseViewpoints(block, panos);
    expect(picked).toHaveLength(100);
    const keys = new Set(picked.map((p) => `${p.panoId}@${p.heading}`));
    expect(keys.size).toBe(100);
    const perPano = new Map<string, number>();
    for (const p of picked) perPano.set(p.panoId, (perPano.get(p.panoId) ?? 0) + 1);
    expect(Math.max(...perPano.values())).toBeLessThanOrEqual(4);

    const few = chooseViewpoints(block, panos.slice(0, 5));
    expect(few).toHaveLength(20); // 5 個全景 × 4 個方向
  });

  it("沒有街景就沒有標記座標", () => {
    expect(chooseViewpoints(block, [])).toEqual([]);
  });
});
