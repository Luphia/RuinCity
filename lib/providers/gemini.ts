/**
 * Google：Gemini 原生影像生成（REST `generateContent`）。
 *
 * 同一個請求裡交錯放文字與圖片（`inlineData`），要求回 TEXT + IMAGE。
 * 回應的 `usageMetadata` 依模態拆分 token（`promptTokensDetails`、
 * `candidatesTokensDetails`），拆得出來就照拆，拆不出來時：
 * 輸入全算文字、輸出全算影像 —— 兩者都是**偏高**的假設（影像輸出最貴），
 * 寧可多記也不少記捐款人的錢。
 */

import { MODEL_PROFILES, type TokenUsage } from "@/lib/world/pricing";

import {
  PainterError,
  codeForStatus,
  fromBase64,
  redact,
  toBase64,
  type FetchLike,
  type PaintRequest,
  type PaintResult,
  type Painter,
} from "./painter";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

interface ModalityCount {
  modality?: string;
  tokenCount?: number;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; inlineData?: InlineData; inline_data?: InlineData; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    promptTokensDetails?: ModalityCount[];
    candidatesTokensDetails?: ModalityCount[];
  };
  modelVersion?: string;
  error?: { message?: string; status?: string };
}

interface InlineData {
  mimeType?: string;
  mime_type?: string;
  data?: string;
}

function byModality(details: ModalityCount[] | undefined, modality: string): number | null {
  if (!details?.length) return null;
  return details
    .filter((d) => d.modality === modality)
    .reduce((s, d) => s + (d.tokenCount ?? 0), 0);
}

export function geminiUsage(meta: GeminiResponse["usageMetadata"]): TokenUsage {
  const prompt = meta?.promptTokenCount ?? 0;
  const candidates = meta?.candidatesTokenCount ?? 0;
  const thoughts = meta?.thoughtsTokenCount ?? 0;

  const imageIn = byModality(meta?.promptTokensDetails, "IMAGE");
  const imageOut = byModality(meta?.candidatesTokensDetails, "IMAGE");
  return {
    textIn: imageIn === null ? prompt : Math.max(0, prompt - imageIn),
    imageIn: imageIn ?? 0,
    // 思考 token 以文字輸出計價
    textOut: (imageOut === null ? 0 : Math.max(0, candidates - imageOut)) + thoughts,
    imageOut: imageOut ?? candidates,
  };
}

export function geminiPainter(apiKey: string, fetchImpl: FetchLike = fetch): Painter {
  const model = MODEL_PROFILES.google.model;
  return {
    provider: "google",
    model,
    async paint(req: PaintRequest, signal?: AbortSignal): Promise<PaintResult> {
      const body = {
        contents: [
          {
            role: "user",
            parts: req.parts.map((p) =>
              p.kind === "text"
                ? { text: p.text }
                : { inlineData: { mimeType: p.image.mime, data: toBase64(p.image.data) } },
            ),
          },
        ],
        generationConfig:
          req.output === "text"
            ? { responseModalities: ["TEXT"] }
            : { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: req.aspect } },
      };

      const res = await fetchImpl(`${ENDPOINT}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal,
      });
      const json = (await res.json().catch(() => ({}))) as GeminiResponse;
      if (!res.ok) {
        throw new PainterError(
          codeForStatus(res.status),
          `Gemini HTTP ${res.status}：${redact(json.error?.message ?? json.error?.status ?? "")}`,
        );
      }

      const usage = geminiUsage(json.usageMetadata);
      const served = json.modelVersion ?? model;
      if (json.promptFeedback?.blockReason) {
        throw new PainterError("SAFETY", `Gemini 拒絕了這份提示（${json.promptFeedback.blockReason}）`, usage, served);
      }
      const candidate = json.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const texts = parts
        .filter((p) => !p.thought && typeof p.text === "string")
        .map((p) => p.text!.trim())
        .filter(Boolean)
        .join("\n");
      if (req.output === "text") {
        if (!texts) {
          const reason = candidate?.finishReason ?? "UNKNOWN";
          const code = /SAFETY|PROHIBITED|BLOCK/.test(reason) ? "SAFETY" : "NO_IMAGE";
          throw new PainterError(code, `Gemini 沒有回傳文字（finishReason=${reason}）`, usage, served);
        }
        return { output: "text", text: texts, usage, model: served };
      }
      const imagePart = parts.find((p) => !p.thought && (p.inlineData?.data || p.inline_data?.data));
      if (!imagePart) {
        const reason = candidate?.finishReason ?? "UNKNOWN";
        const code = /SAFETY|PROHIBITED|BLOCK|IMAGE_SAFETY/.test(reason) ? "SAFETY" : "NO_IMAGE";
        throw new PainterError(code, `Gemini 沒有回傳影像（finishReason=${reason}）`, usage, served);
      }
      const inline = (imagePart.inlineData ?? imagePart.inline_data)!;
      return {
        output: "image",
        image: { mime: inline.mimeType ?? inline.mime_type ?? "image/png", data: fromBase64(inline.data!) },
        usage,
        model: served,
        note: texts || null,
      };
    },
  };
}
