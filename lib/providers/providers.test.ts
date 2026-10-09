import sharp from "sharp";
import { describe, expect, it } from "vitest";

import type Anthropic from "@anthropic-ai/sdk";

import { anthropicPainter } from "./anthropic";
import { fakePainter, fakeReferenceSource } from "./fake";
import { geminiPainter, geminiUsage } from "./gemini";
import { googleMapsSource } from "./google-maps";
import { normalizeImage, rasterizeSvg } from "./image";
import { flattenForOpenAI, openaiPainter, openaiSize } from "./openai";
import { PainterError, redact, type FetchLike, type PaintRequest } from "./painter";
import { enabledProviders, painterFor, usingFakeProviders } from "./registry";
import { MODEL_PROFILES } from "@/lib/world/pricing";
import { parseMapParams } from "@/lib/world/params";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function capture(response: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { calls, fetchImpl };
}

const imageReq: PaintRequest = {
  kind: "SCENE",
  output: "image",
  aspect: "16:9",
  parts: [
    { kind: "text", text: "canon" },
    { kind: "image", image: { mime: "image/png", data: new Uint8Array(PNG_1x1) } },
    { kind: "text", text: "go" },
  ],
};

describe("Gemini", () => {
  const ok = () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: "thinking…", thought: true },
                { text: "A drowned avenue." },
                { inlineData: { mimeType: "image/png", data: PNG_1x1.toString("base64") } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 2000,
          candidatesTokenCount: 1200,
          thoughtsTokenCount: 50,
          promptTokensDetails: [
            { modality: "TEXT", tokenCount: 880 },
            { modality: "IMAGE", tokenCount: 1120 },
          ],
          candidatesTokensDetails: [
            { modality: "IMAGE", tokenCount: 1120 },
            { modality: "TEXT", tokenCount: 80 },
          ],
        },
        modelVersion: "gemini-3.1-flash-image-preview",
      }),
      { status: 200 },
    );

  it("★ 金鑰放在 header，不在網址；文字與圖交錯；比例照工作要求", async () => {
    const { calls, fetchImpl } = capture(ok);
    const r = await geminiPainter("AIzaSECRET", fetchImpl).paint(imageReq);
    expect(calls[0]!.url).not.toContain("AIza");
    expect((calls[0]!.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIzaSECRET");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.contents[0].parts.map((p: object) => Object.keys(p)[0])).toEqual(["text", "inlineData", "text"]);
    expect(body.generationConfig.imageConfig.aspectRatio).toBe("16:9");
    expect(r.output).toBe("image");
    if (r.output !== "image") return;
    expect(r.note).toBe("A drowned avenue."); // 思考不算
    expect(r.usage).toEqual({ textIn: 880, imageIn: 1120, textOut: 80 + 50, imageOut: 1120 });
  });

  it("沒有模態拆分時偏高估：輸入全算文字、輸出全算影像", () => {
    expect(geminiUsage({ promptTokenCount: 100, candidatesTokenCount: 50 })).toEqual({
      textIn: 100,
      imageIn: 0,
      textOut: 0,
      imageOut: 50,
    });
  });

  it("要文字時只要 TEXT，回傳 JSON 文字", async () => {
    const { calls, fetchImpl } = capture(
      () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"biome":"x"}' }] } }] }), {
          status: 200,
        }),
    );
    const r = await geminiPainter("k", fetchImpl).paint({ ...imageReq, kind: "PARAMS", output: "text" });
    expect(JSON.parse(String(calls[0]!.init!.body)).generationConfig).toEqual({ responseModalities: ["TEXT"] });
    expect(r.output === "text" && r.text).toBe('{"biome":"x"}');
  });

  it("★ 被擋時帶著 usage 丟出 SAFETY —— 失敗的那一次照樣記帳", async () => {
    const { fetchImpl } = capture(
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [] }, finishReason: "IMAGE_SAFETY" }],
            usageMetadata: { promptTokenCount: 900 },
          }),
          { status: 200 },
        ),
    );
    const err = await geminiPainter("k", fetchImpl).paint(imageReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PainterError);
    expect((err as PainterError).code).toBe("SAFETY");
    expect((err as PainterError).usage?.textIn).toBe(900);
    expect((err as PainterError).retryable).toBe(false);
  });

  it("HTTP 錯誤分類；429 可重試", async () => {
    const { fetchImpl } = capture(() => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }));
    const err = (await geminiPainter("k", fetchImpl).paint(imageReq).catch((e: unknown) => e)) as PainterError;
    expect(err.code).toBe("QUOTA");
    expect(err.retryable).toBe(true);
  });
});

describe("OpenAI", () => {
  it("★ 交錯的工作攤平成 [Image N]，圖依序附上", () => {
    const { prompt, images } = flattenForOpenAI({
      ...imageReq,
      parts: [
        { kind: "text", text: "a" },
        { kind: "image", image: { mime: "image/png", data: new Uint8Array(1) } },
        { kind: "text", text: "b" },
        { kind: "image", image: { mime: "image/jpeg", data: new Uint8Array(2) } },
      ],
    });
    expect(prompt).toBe("a\n\n[Image 1]\n\nb\n\n[Image 2]");
    expect(images).toHaveLength(2);
    expect(openaiSize("16:9")).toBe("1536x1024");
    expect(openaiSize("4:5")).toBe("1024x1536");
  });

  it("multipart 帶著參考圖送出；usage 拆成文字與影像輸入", async () => {
    const { calls, fetchImpl } = capture(
      () =>
        new Response(
          JSON.stringify({
            data: [{ b64_json: PNG_1x1.toString("base64") }],
            usage: { input_tokens: 1500, output_tokens: 1700, input_tokens_details: { text_tokens: 400, image_tokens: 1100 } },
          }),
          { status: 200 },
        ),
    );
    const r = await openaiPainter("sk-test", fetchImpl).paint(imageReq);
    const form = calls[0]!.init!.body as FormData;
    expect(form.get("model")).toBe(MODEL_PROFILES.openai.model);
    expect(form.getAll("image[]")).toHaveLength(1);
    expect(r.usage).toEqual({ textIn: 400, imageIn: 1100, textOut: 0, imageOut: 1700 });
  });

  it("不寫文字", async () => {
    const err = await openaiPainter("k", capture(() => new Response("{}")).fetchImpl)
      .paint({ ...imageReq, output: "text" })
      .catch((e: unknown) => e);
    expect((err as PainterError).code).toBe("BAD_REQUEST");
  });
});

describe("Claude（勘查員：只寫地圖參數）", () => {
  function stubClient(message: Partial<Anthropic.Beta.BetaMessage>) {
    const seen: unknown[] = [];
    const client = {
      beta: {
        messages: {
          stream: (params: unknown) => {
            seen.push(params);
            return {
              finalMessage: async () => ({
                model: "claude-opus-5-5",
                stop_reason: "end_turn",
                stop_details: null,
                usage: { input_tokens: 1500, output_tokens: 9000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                content: [],
                ...message,
              }),
            };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, seen };
  }
  const paramsReq = { ...imageReq, kind: "PARAMS" as const, output: "text" as const };

  it("★ 回傳文字；fallback 與努力程度照設定送出", async () => {
    const { client, seen } = stubClient({ content: [{ type: "text", text: '{"biome":"x"}', citations: null }] as never });
    const r = await anthropicPainter("k", client).paint(paramsReq);
    expect(r.output).toBe("text");
    if (r.output !== "text") return;
    expect(r.text).toBe('{"biome":"x"}');
    const params = seen[0] as Record<string, unknown>;
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.fallbacks).toBe("default");
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params.output_config).toEqual({ effort: "medium" });
    expect(r.usage.textOut).toBe(9000);
    expect(r.usage.textIn + r.usage.imageIn).toBe(1500);
  });

  it("★ 不出圖：畫面必須擬真，Claude 不畫任何一張", async () => {
    const { client, seen } = stubClient({});
    const err = (await anthropicPainter("k", client).paint(imageReq).catch((e: unknown) => e)) as PainterError;
    expect(err.code).toBe("BAD_REQUEST");
    expect(seen).toHaveLength(0);
  });

  it("婉拒時丟出 SAFETY 並帶著 usage", async () => {
    const { client } = stubClient({ stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: null } as never });
    const err = (await anthropicPainter("k", client).paint(paramsReq).catch((e: unknown) => e)) as PainterError;
    expect(err.code).toBe("SAFETY");
    expect(err.usage?.textOut).toBe(9000);
  });
});

describe("影像正規化", () => {
  it("正規化：任何輸入都裁成目標比例的 WebP，並產生縮圖", async () => {
    const png = await rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 30"><rect width="10" height="30"/></svg>', "1:1");
    const out = await normalizeImage(png, "16:9");
    const meta = await sharp(Buffer.from(out.webp)).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([1536, 864]);
    expect((await sharp(Buffer.from(out.thumb)).metadata()).width).toBe(384);
  });
});

describe("Google Maps 參考來源", () => {
  it("metadata：OK → 全景；ZERO_RESULTS → null；REQUEST_DENIED → AUTH", async () => {
    const ok = capture(() => new Response(JSON.stringify({ status: "OK", pano_id: "P", location: { lat: 25.03, lng: 121.56 }, date: "2024-05" })));
    expect(await googleMapsSource("k", ok.fetchImpl).nearestPano({ lat: 1, lng: 2 }, 50)).toEqual({
      panoId: "P",
      location: { lat: 25.03, lng: 121.56 },
      date: "2024-05",
    });
    expect(ok.calls[0]!.url).toContain("source=outdoor");
    const none = capture(() => new Response(JSON.stringify({ status: "ZERO_RESULTS" })));
    expect(await googleMapsSource("k", none.fetchImpl).nearestPano({ lat: 1, lng: 2 }, 50)).toBeNull();
    const denied = capture(() => new Response(JSON.stringify({ status: "REQUEST_DENIED", error_message: "bad key=AIzaXXXXXXXXXXXXXXXXXXXXXXXX" })));
    const err = (await googleMapsSource("k", denied.fetchImpl).nearestPano({ lat: 1, lng: 2 }, 50).catch((e: unknown) => e)) as PainterError;
    expect(err.code).toBe("AUTH");
    expect(err.message).not.toContain("AIzaXXXX");
  });

  it("街景要求 404 而不是灰圖；版型是衛星影像（擬真的航照需要航照當參考）", async () => {
    const img = capture(() => new Response(PNG_1x1, { headers: { "content-type": "image/png" } }));
    const src = googleMapsSource("k", img.fetchImpl);
    await src.streetView({ panoId: "P", location: { lat: 0, lng: 0 }, heading: 10, pitch: 0, fov: 90, date: null });
    await src.layout({ center: { lat: 25, lng: 121 }, zoom: 16, width: 466, height: 514 });
    expect(img.calls[0]!.url).toContain("return_error_code=true");
    expect(img.calls[0]!.url).toContain("size=640x360");
    expect(img.calls[1]!.url).toContain("maptype=satellite");
    expect(img.calls[1]!.url).not.toContain("style=");
    expect(img.calls[1]!.url).toContain("size=466x514");
  });

  it("★ 全景 ID 取不到影像（404）→ 改用同一個座標取最近的戶外街景；其他錯誤照丟", async () => {
    const v = { panoId: "CAoSLEFGMVFpcE", location: { lat: 25.031, lng: 121.562 }, heading: 90, pitch: 0, fov: 90, date: null };
    let n = 0;
    const fallback = capture(() => (n++ === 0 ? new Response("", { status: 404 }) : new Response(PNG_1x1, { headers: { "content-type": "image/png" } })));
    const img = await googleMapsSource("k", fallback.fetchImpl).streetView(v);
    expect(img.mime).toBe("image/png");
    expect(fallback.calls[0]!.url).toContain("pano=CAoSLEFGMVFpcE");
    expect(fallback.calls[1]!.url).toContain("location=25.031%2C121.562");
    expect(fallback.calls[1]!.url).toContain("source=outdoor");
    expect(fallback.calls[1]!.url).toContain("heading=90");
    expect(fallback.calls[1]!.url).toContain("return_error_code=true");

    const gone = capture(() => new Response("", { status: 404 }));
    const err = (await googleMapsSource("k", gone.fetchImpl).streetView(v).catch((e: unknown) => e)) as PainterError;
    expect(gone.calls).toHaveLength(2);
    expect(err.message).toContain("改用座標");

    const denied = capture(() => new Response("", { status: 403 }));
    const e2 = (await googleMapsSource("k", denied.fetchImpl).streetView(v).catch((e: unknown) => e)) as PainterError;
    expect(e2.code).toBe("AUTH");
    expect(denied.calls).toHaveLength(1);
  });

  it("錯誤訊息不會洩漏金鑰", () => {
    expect(redact("https://x?key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWX&y=1 sk-abcdefghijklmnop")).toBe("https://x?key=***&y=1 sk-***");
  });
});

describe("示範模式與註冊表", () => {
  it("★ 示範畫師照表上的先驗回報 usage —— 帳與估計照真的跑", async () => {
    const r = await fakePainter("openai").paint({ ...imageReq, kind: "TILE", aspect: "1:1" });
    expect(r.usage).toEqual(MODEL_PROFILES.openai.typical.TILE);
    expect(r.output).toBe("image");
  });

  it("示範參數依標記數產生，而且解析得回來", async () => {
    const r = await fakePainter("google").paint({
      kind: "PARAMS",
      output: "text",
      aspect: "1:1",
      parts: [{ kind: "text", text: "0: lat 1\n1: lat 2\n2: lat 3" }],
    });
    if (r.output !== "text") throw new Error("expected text");
    const { params, repaired } = parseMapParams(r.text, 3);
    expect(repaired).toBe(false);
    expect(params.markers).toHaveLength(3);
  });

  it("示範街景來源回塊內的全景", async () => {
    const src = fakeReferenceSource();
    let found = 0;
    for (let i = 0; i < 9; i++) if (await src.nearestPano({ lat: 25.031 + i * 0.001, lng: 121.561 }, 50)) found++;
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThan(9);
  });

  it("★ 沒設金鑰的那一家不啟用；示範模式三家都在", () => {
    expect(enabledProviders({ GEMINI_API_KEY: "x" })).toEqual(["google"]);
    expect(enabledProviders({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" })).toEqual(["openai", "anthropic"]);
    expect(enabledProviders({})).toEqual([]);
    expect(enabledProviders({ FAKE_PROVIDERS: "1" })).toEqual(["google", "openai", "anthropic"]);
    expect(usingFakeProviders({ FAKE_PROVIDERS: "1" })).toBe(true);
    expect(() => painterFor("openai", {})).toThrow(/OPENAI_API_KEY/);
  });
});
