/**
 * 「畫師」的共同介面。每一家模型實作一個。
 *
 * 施工引擎只認得這個介面：給它一份解析好的工作（文字 + 圖片位元組 + 比例），
 * 拿回一張圖、**實際用掉的 token**、以及**實際服務的模型名稱**
 * （伺服器端 fallback 可能換了模型 —— 帳要記在真正畫的那一個身上）。
 */

import type { PaidStepKind, ProviderId, TokenUsage } from "@/lib/world/pricing";
import type { Aspect } from "@/lib/world/prompts";

export interface ImageBytes {
  readonly mime: string;
  readonly data: Uint8Array;
}

export type ResolvedPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly image: ImageBytes };

export interface PaintRequest {
  readonly kind: PaidStepKind;
  /** PARAMS 要文字（JSON），其餘要一張圖 */
  readonly output: "text" | "image";
  readonly aspect: Aspect;
  readonly parts: readonly ResolvedPart[];
}

interface ResultBase {
  readonly usage: TokenUsage;
  /** 實際服務的模型（可能與請求的不同） */
  readonly model: string;
}

export type PaintResult =
  | (ResultBase & {
      readonly output: "image";
      readonly image: ImageBytes;
      /** 模型順帶說的話（有的話），記在施工紀錄裡 */
      readonly note: string | null;
    })
  | (ResultBase & { readonly output: "text"; readonly text: string });

export interface Painter {
  readonly provider: ProviderId;
  readonly model: string;
  paint(req: PaintRequest, signal?: AbortSignal): Promise<PaintResult>;
}

/**
 * 繪製失敗的分類。
 *
 * ★ 分類決定施工引擎怎麼反應，而不是只拿來顯示：
 *   - `retryable` 的（限流、上游暫時故障）→ 這一步留著，下一輪再試
 *   - 其餘（金鑰錯、內容被擋、模型沒回圖）→ 這一步記一次失敗；
 *     連續失敗太多次就暫停這一塊，等人來看（`MAX_STEP_FAILURES`）
 *
 *   被擋或沒回圖時**有可能已經計費**（上游照樣收了輸入 token）。
 *   有 usage 就帶著，帳照記 —— 捐款人看到的「已花費」必須包含失敗的那幾次。
 */
export type PainterErrorCode = "AUTH" | "QUOTA" | "SAFETY" | "NO_IMAGE" | "BAD_REQUEST" | "UPSTREAM";

export class PainterError extends Error {
  constructor(
    readonly code: PainterErrorCode,
    message: string,
    readonly usage: TokenUsage | null = null,
    readonly model: string | null = null,
  ) {
    super(message);
    this.name = "PainterError";
  }

  get retryable(): boolean {
    return this.code === "QUOTA" || this.code === "UPSTREAM";
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** 把 HTTP 狀態碼翻成失敗分類（三家共用的部分） */
export function codeForStatus(status: number): PainterErrorCode {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "QUOTA";
  if (status >= 500) return "UPSTREAM";
  return "BAD_REQUEST";
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** 錯誤訊息裡絕不能出現金鑰 —— 上游有時會把 URL 原封不動回顯 */
export function redact(text: string): string {
  return text
    .replace(/key=[A-Za-z0-9_\-]+/g, "key=***")
    .replace(/AIza[0-9A-Za-z_\-]{20,}/g, "AIza***")
    .replace(/sk-[A-Za-z0-9_\-]{10,}/g, "sk-***")
    .slice(0, 500);
}
