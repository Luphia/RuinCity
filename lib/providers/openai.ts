/**
 * OpenAI：GPT Image（`/v1/images/edits`，multipart）。
 *
 * 這個端點吃**一段提示詞 + 一串參考圖**，不能像 Gemini 那樣文字與圖交錯。
 * 所以把交錯的工作攤平：每一張圖在文字裡換成 `[Image N]`，
 * 圖依同樣的順序附上 —— 「下一張是北邊的鄰塊」就變成「[Image 3] 是北邊的鄰塊」。
 *
 * 比例只有三種尺寸可選，取最接近的；施工引擎之後會把輸出正規化。
 */

import { MODEL_PROFILES, type TokenUsage } from "@/lib/world/pricing";
import type { Aspect } from "@/lib/world/prompts";

import {
  PainterError,
  codeForStatus,
  fromBase64,
  redact,
  type FetchLike,
  type PaintRequest,
  type PaintResult,
  type Painter,
} from "./painter";

const ENDPOINT = "https://api.openai.com/v1/images/edits";

export function openaiSize(aspect: Aspect): "1024x1024" | "1536x1024" | "1024x1536" {
  switch (aspect) {
    case "1:1":
      return "1024x1024";
    case "16:9":
    case "5:4":
    case "4:3":
      return "1536x1024";
    case "4:5":
    case "3:4":
      return "1024x1536";
  }
}

/** 交錯的工作 → 一段提示詞 + 依序的圖 */
export function flattenForOpenAI(req: PaintRequest): { prompt: string; images: PaintRequest["parts"] } {
  const lines: string[] = [];
  const images: PaintRequest["parts"][number][] = [];
  for (const p of req.parts) {
    if (p.kind === "text") lines.push(p.text);
    else {
      images.push(p);
      lines.push(`[Image ${images.length}]`);
    }
  }
  return { prompt: lines.join("\n\n"), images };
}

interface OpenAIImageResponse {
  data?: { b64_json?: string; revised_prompt?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number };
  };
  error?: { message?: string; code?: string; type?: string };
}

export function openaiUsage(u: OpenAIImageResponse["usage"]): TokenUsage {
  const input = u?.input_tokens ?? 0;
  const imageIn = u?.input_tokens_details?.image_tokens;
  return {
    textIn: u?.input_tokens_details?.text_tokens ?? (imageIn === undefined ? input : Math.max(0, input - imageIn)),
    imageIn: imageIn ?? 0,
    textOut: 0,
    imageOut: u?.output_tokens ?? 0,
  };
}

export function openaiPainter(apiKey: string, fetchImpl: FetchLike = fetch): Painter {
  const model = MODEL_PROFILES.openai.model;
  return {
    provider: "openai",
    model,
    async paint(req: PaintRequest, signal?: AbortSignal): Promise<PaintResult> {
      if (req.output !== "image") {
        // 施工引擎會先用 `pickFor` 排除 —— 走到這裡是程式錯誤，不是使用者的錯
        throw new PainterError("BAD_REQUEST", "GPT Image 不輸出文字");
      }
      const { prompt, images } = flattenForOpenAI(req);
      const form = new FormData();
      form.set("model", model);
      form.set("prompt", prompt);
      form.set("size", openaiSize(req.aspect));
      form.set("quality", "medium");
      form.set("n", "1");
      images.forEach((p, i) => {
        if (p.kind !== "image") return;
        const ext = p.image.mime.split("/")[1] ?? "png";
        form.append("image[]", new Blob([Buffer.from(p.image.data)], { type: p.image.mime }), `ref-${i + 1}.${ext}`);
      });

      const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal,
      });
      const json = (await res.json().catch(() => ({}))) as OpenAIImageResponse;
      const usage = openaiUsage(json.usage);
      if (!res.ok) {
        const msg = redact(json.error?.message ?? "");
        const code = json.error?.code === "moderation_blocked" ? "SAFETY" : codeForStatus(res.status);
        throw new PainterError(code, `OpenAI HTTP ${res.status}：${msg}`, json.usage ? usage : null, model);
      }
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) throw new PainterError("NO_IMAGE", "OpenAI 沒有回傳影像", usage, model);
      return { output: "image", image: { mime: "image/png", data: fromBase64(b64) }, usage, model, note: null };
    },
  };
}
