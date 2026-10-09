/**
 * Anthropic：Claude 畫**向量插畫**。
 *
 * ★ Claude 不輸出點陣影像。它看得懂參考照（視覺輸入），然後寫出一份 SVG ——
 *   伺服器淨化、點陣化成 PNG（`image.ts`）。成品是插畫風格，
 *   和 Gemini、GPT Image 的寫實影像明顯不同。這一點寫在投票選項上
 *   （`pricing.ts` 的 `medium: "vector"`），捐款人投它就是選了這種畫風。
 *
 * 模型：Claude Opus 5.5。思考恆開（這個模型不能關），努力程度設 `medium`
 * —— 畫一張插畫不是需要最深推理的工作，而 token 就是捐款人的錢。
 *
 * ★ 開啟伺服器端 fallback（`fallbacks: "default"`）：安全分類器偶爾會誤擋
 *   一張「廢墟」的請求；有 fallback 時由另一個模型接手，而不是整步失敗。
 *   帳記在**實際服務的模型**身上（`response.model`）。
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { MODEL_PROFILES, type TokenUsage } from "@/lib/world/pricing";

import { aspectSize, extractSvg, imageDimensions, rasterizeSvg } from "./image";
import { PainterError, toBase64, redact, type PaintRequest, type PaintResult, type Painter } from "./painter";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const SUPPORTED: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const SYSTEM_TEXT = `You are the surveyor for a shared world map. Follow the output format you are given exactly.`;

const SYSTEM_SVG = `You are an illustrator for a shared world map. You draw by writing SVG.
Respond with exactly one complete, self-contained <svg> document and nothing else — no Markdown fences, no explanation.
Rules for the SVG:
- Use the exact viewBox you are given. Fill the entire canvas edge to edge.
- Build texture and depth with layered shapes, gradients and SVG filters (feTurbulence, feDisplacementMap, feGaussianBlur) rather than flat colours.
- No <text>, no <image>, no <script>, no <foreignObject>, no external references of any kind.
- Keep the file under about 60 KB.`;

/** Claude 的影像 token 約等於 寬×高/750（官方文件的估算式） */
function imageTokens(dim: { width: number; height: number }): number {
  return Math.ceil((dim.width * dim.height) / 750);
}

export function anthropicPainter(apiKey: string, client?: Anthropic): Painter {
  const model = MODEL_PROFILES.anthropic.model;
  const anthropic = client ?? new Anthropic({ apiKey });
  return {
    provider: "anthropic",
    model,
    async paint(req: PaintRequest, signal?: AbortSignal): Promise<PaintResult> {
      const { width, height } = aspectSize(req.aspect);
      let estimatedImageTokens = 0;
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      for (const p of req.parts) {
        if (p.kind === "text") {
          content.push({ type: "text", text: p.text });
          continue;
        }
        if (!SUPPORTED.includes(p.image.mime)) {
          throw new PainterError("BAD_REQUEST", `Claude 不接受 ${p.image.mime} 的參考圖`);
        }
        estimatedImageTokens += imageTokens(await imageDimensions(p.image));
        content.push({
          type: "image",
          source: { type: "base64", media_type: p.image.mime as MediaType, data: toBase64(p.image.data) },
        });
      }
      if (req.output === "image") {
        content.push({
          type: "text",
          text: `Draw it now as one SVG with viewBox="0 0 ${width} ${height}" (aspect ${req.aspect}).`,
        });
      }

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await anthropic.beta.messages
          .stream(
            {
              model,
              max_tokens: 64000,
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
              thinking: { type: "adaptive" },
              output_config: { effort: "medium" },
              system: req.output === "image" ? SYSTEM_SVG : SYSTEM_TEXT,
              messages: [{ role: "user", content }],
            },
            { signal },
          )
          .finalMessage();
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
          throw new PainterError("AUTH", `Claude 金鑰被拒（HTTP ${e.status}）`);
        }
        if (e instanceof Anthropic.RateLimitError) {
          throw new PainterError("QUOTA", "Claude 限流中");
        }
        if (e instanceof Anthropic.BadRequestError) {
          throw new PainterError("BAD_REQUEST", `Claude 拒絕了請求：${redact(e.message)}`);
        }
        if (e instanceof Anthropic.APIError) {
          throw new PainterError("UPSTREAM", `Claude HTTP ${e.status ?? "?"}：${redact(e.message)}`);
        }
        if (e instanceof Anthropic.APIConnectionError) {
          throw new PainterError("UPSTREAM", "連不上 Claude");
        }
        throw e;
      }

      const input =
        message.usage.input_tokens +
        (message.usage.cache_creation_input_tokens ?? 0) +
        (message.usage.cache_read_input_tokens ?? 0);
      const imageIn = Math.min(input, estimatedImageTokens);
      const usage: TokenUsage = {
        textIn: input - imageIn,
        imageIn,
        textOut: message.usage.output_tokens,
        imageOut: 0,
      };

      if (message.stop_reason === "refusal") {
        const category = message.stop_details?.category ?? "unknown";
        throw new PainterError("SAFETY", `Claude 婉拒了這一張（${category}）`, usage, message.model);
      }
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (req.output === "text") {
        if (!text.trim()) throw new PainterError("NO_IMAGE", "Claude 沒有回傳文字", usage, message.model);
        return { output: "text", text, usage, model: message.model };
      }
      const svg = extractSvg(text);
      if (!svg) {
        const why = message.stop_reason === "max_tokens" ? "（輸出被截斷）" : "";
        throw new PainterError("NO_IMAGE", `Claude 沒有回傳完整的 SVG${why}`, usage, message.model);
      }
      let image;
      try {
        image = await rasterizeSvg(svg, req.aspect);
      } catch {
        throw new PainterError("NO_IMAGE", "Claude 的 SVG 無法點陣化", usage, message.model);
      }
      return { output: "image", image, usage, model: message.model, note: null };
    },
  };
}
