/**
 * Anthropic：Claude 是**勘查員**，不畫圖。
 *
 * ★ 畫面必須擬真，而 Claude 不輸出點陣影像 —— 所以它不在投票名單上（`PAINTERS`）。
 *   它做它最擅長的那一步：看今天的衛星影像與幾張街景，寫出這一塊的
 *   **地圖參數**（JSON）——水位、植被、地標、每個標記點的說明、材質清單。
 *   後面一百多張圖不論出自哪一家，都對齊這份設定。
 *
 * 模型：Claude Opus 5.5。思考恆開（這個模型不能關），努力程度設 `medium`
 * —— 這一步要讀圖與推理，但不是需要最深推理的工作，而 token 就是捐款人的錢。
 *
 * ★ 開啟伺服器端 fallback（`fallbacks: "default"`）：安全分類器偶爾會誤擋
 *   一個「廢墟」的請求；有 fallback 時由另一個模型接手，而不是整步失敗。
 *   帳記在**實際服務的模型**身上（`response.model`）。
 */

import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import { MODEL_PROFILES, type TokenUsage } from "@/lib/world/pricing";

import { imageDimensions } from "./image";
import { PainterError, toBase64, redact, type PaintRequest, type PaintResult, type Painter } from "./painter";

type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const SUPPORTED: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const SYSTEM_TEXT = `You are the surveyor for a shared world map. Follow the output format you are given exactly.`;

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
      if (req.output !== "text") {
        // 施工引擎只會把 PARAMS 交給勘查員（`vote.pickFor`）—— 走到這裡是程式錯誤
        throw new PainterError("BAD_REQUEST", "Claude 只寫地圖參數，不出圖");
      }
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
              system: SYSTEM_TEXT,
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
      if (!text.trim()) throw new PainterError("NO_IMAGE", "Claude 沒有回傳文字", usage, message.model);
      return { output: "text", text, usage, model: message.model };
    },
  };
}
