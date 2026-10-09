/**
 * 依環境變數組出「現在有哪幾家可以投、誰來畫、參考影像從哪裡來」。
 * **伺服器專用**：金鑰只在這裡讀，從不送到瀏覽器。
 *
 * | 變數 | 作用 |
 * | --- | --- |
 * | `GEMINI_API_KEY` | 啟用 Google（Gemini 影像） |
 * | `OPENAI_API_KEY` | 啟用 OpenAI（GPT Image） |
 * | `ANTHROPIC_API_KEY` | 啟用 Anthropic（Claude 勘查員：寫地圖參數，不出圖、不投票） |
 * | `GOOGLE_MAPS_API_KEY` | Street View 與地圖靜態圖（參考影像） |
 * | `DEFAULT_PROVIDER` | 沒有人投票時由誰畫（`google` 或 `openai`，預設 google） |
 * | `FAKE_PROVIDERS=1` | 三家與參考來源全換成示範實作（不花錢） |
 *
 * 勘查員是 `SURVEYORS` 裡第一個啟用的（Claude，沒有就 Gemini）；兩家都沒有就用預設參數。
 *
 * ★ 沒設金鑰的那一家**不會出現在可贏的名單裡**，但已經投給它的票照樣顯示
 *   （`vote.ts`）。這樣平台暫時停用某一家時，捐款人看得到自己的票還在。
 */

import "server-only";

import { PROVIDER_ORDER, isPainterId, type PainterId, type ProviderId } from "@/lib/world/pricing";

import { anthropicPainter } from "./anthropic";
import { fakePainter, fakeReferenceSource } from "./fake";
import { geminiPainter } from "./gemini";
import { googleMapsSource, type ReferenceSource } from "./google-maps";
import { openaiPainter } from "./openai";
import type { Painter } from "./painter";

type Env = Record<string, string | undefined>;

export function usingFakeProviders(env: Env = process.env): boolean {
  return env.FAKE_PROVIDERS === "1";
}

const KEY_VAR: Record<ProviderId, string> = {
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export function enabledProviders(env: Env = process.env): ProviderId[] {
  if (usingFakeProviders(env)) return [...PROVIDER_ORDER];
  return PROVIDER_ORDER.filter((p) => Boolean(env[KEY_VAR[p]]));
}

export function defaultProvider(env: Env = process.env): PainterId {
  return isPainterId(env.DEFAULT_PROVIDER) ? env.DEFAULT_PROVIDER : "google";
}

export function painterFor(provider: ProviderId, env: Env = process.env): Painter {
  if (usingFakeProviders(env)) return fakePainter(provider);
  const key = env[KEY_VAR[provider]];
  if (!key) throw new Error(`${KEY_VAR[provider]} 未設定 —— ${provider} 目前停用`);
  switch (provider) {
    case "google":
      return geminiPainter(key);
    case "openai":
      return openaiPainter(key);
    case "anthropic":
      return anthropicPainter(key);
  }
}

export function referenceSource(env: Env = process.env): ReferenceSource | null {
  if (usingFakeProviders(env)) return fakeReferenceSource();
  const key = env.GOOGLE_MAPS_API_KEY;
  return key ? googleMapsSource(key) : null;
}
