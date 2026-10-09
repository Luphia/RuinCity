/**
 * 各家模型的價格與 token 估計。純資料 + 純函式，無 I/O。
 *
 * ## ★ 這張表是**捐款人看到的數字**的來源
 *
 * 「已花費」來自每一次 API 回應的 usage（真的帳）；
 * 「預計」來自這張表的先驗 —— 以及**這個模型過去實際用掉多少**（`plan.ts` 的 `observed`）。
 * 世界蓋得愈多，估計就愈接近真實。
 *
 * ## ★ 價格會變，所以只寫在這裡
 *
 * 以下費率為 **2026-10-09 查核**（第三方價格追蹤彙整，官方頁面在開發環境連不到）。
 * 上線前請對照各家官方價目表更新並 bump `PRICING_VERSION` ——
 * 每一筆花費都記下當時的版本，改價不會改寫過去的帳。
 *
 * 金額一律用**微美元**（1 USD = 1,000,000）的整數。
 */

export const PRICING_VERSION = "2026-10-09";

export type ProviderId = "google" | "openai" | "anthropic";

/**
 * 一塊地圖的施工步驟（順序與理由見 `plan.ts`）。
 *
 * | 步驟 | 產出 | 用到的能力 |
 * | --- | --- | --- |
 * | SURVEY | 最多 100 個標記座標（Street View 全景） | 無（metadata 免費） |
 * | PARAMS | 地圖參數（JSON：地貌、水位、植被、材質清單、每個標記的說明） | 文字 + 看圖 |
 * | SCENE | 一張標記座標的場景圖（照片級） | 影像 |
 * | TILE | 正射地圖底圖（照片級航照） | 影像 |
 * | DSM | 3D 圖資：數值地表高度圖（灰階） | 影像 |
 * | TEXTURE | 一張可平鋪的材質貼圖（照片掃描級） | 影像 |
 */
export type StepKind = "SURVEY" | "PARAMS" | "SCENE" | "TILE" | "DSM" | "TEXTURE";

export type PaidStepKind = Exclude<StepKind, "SURVEY">;

export const PAID_STEP_KINDS: readonly PaidStepKind[] = ["PARAMS", "SCENE", "TILE", "DSM", "TEXTURE"];

export interface TokenUsage {
  readonly textIn: number;
  readonly imageIn: number;
  readonly textOut: number;
  readonly imageOut: number;
}

export const ZERO_USAGE: TokenUsage = { textIn: 0, imageIn: 0, textOut: 0, imageOut: 0 };

/** 每百萬 token 的美元價 */
export interface Rates {
  readonly textIn: number;
  readonly imageIn: number;
  readonly textOut: number;
  readonly imageOut: number;
}

export interface ModelProfile {
  readonly provider: ProviderId;
  /** 投票時顯示的「哪一家」 */
  readonly company: string;
  readonly model: string;
  readonly displayName: string;
  readonly rates: Rates;
  /**
   * 開局先驗：每種步驟典型會用掉多少 token。**沒列的步驟就是做不了**（`supports`）。
   *
   * ★ 畫面必須擬真：只有能畫出照片級影像的模型列影像步驟。
   *   Claude 不輸出點陣圖（只能寫 SVG 向量插畫），所以它只負責文字的「地圖參數」，
   *   不參與繪製、也不在投票選項裡。
   */
  readonly typical: Readonly<Partial<Record<PaidStepKind, TokenUsage>>>;
}

export const MODEL_PROFILES: Readonly<Record<ProviderId, ModelProfile>> = {
  google: {
    provider: "google",
    company: "Google",
    model: "gemini-3.1-flash-image-preview",
    displayName: "Gemini 3.1 Flash Image",
    // 輸出影像 1K = 1,120 token（Google Cloud 文件）× $60/M ≈ $0.067／張
    rates: { textIn: 0.5, imageIn: 0.5, textOut: 3, imageOut: 60 },
    typical: {
      PARAMS: { textIn: 2500, imageIn: 5600, textOut: 4500, imageOut: 0 },
      SCENE: { textIn: 1300, imageIn: 1120, textOut: 80, imageOut: 1120 },
      TILE: { textIn: 1700, imageIn: 4480, textOut: 120, imageOut: 1120 },
      DSM: { textIn: 1000, imageIn: 2240, textOut: 60, imageOut: 1120 },
      TEXTURE: { textIn: 1000, imageIn: 2240, textOut: 60, imageOut: 1120 },
    },
  },
  openai: {
    provider: "openai",
    company: "OpenAI",
    model: "gpt-image-2",
    displayName: "GPT Image 2",
    // gpt-image-2 每張的輸出 token 沒有官方對照表 —— 先驗刻意抓寬
    rates: { textIn: 5, imageIn: 8, textOut: 0, imageOut: 30 },
    typical: {
      SCENE: { textIn: 1300, imageIn: 1100, textOut: 0, imageOut: 1800 },
      TILE: { textIn: 1700, imageIn: 4400, textOut: 0, imageOut: 1800 },
      DSM: { textIn: 1000, imageIn: 2200, textOut: 0, imageOut: 1800 },
      TEXTURE: { textIn: 1000, imageIn: 2200, textOut: 0, imageOut: 1800 },
    },
  },
  anthropic: {
    provider: "anthropic",
    company: "Anthropic",
    model: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    // 只寫地圖參數（看圖 → JSON）；輸出 token 含思考
    rates: { textIn: 4, imageIn: 4, textOut: 20, imageOut: 0 },
    typical: {
      PARAMS: { textIn: 2800, imageIn: 2700, textOut: 7000, imageOut: 0 },
    },
  },
};

/** 所有供應商（帳務、型別檢查用） */
export const PROVIDER_ORDER: readonly ProviderId[] = ["google", "openai", "anthropic"];

/**
 * **畫師**：能畫出照片級影像、可以被投票的那幾家。順序 = 平手時的順位。
 * 改順序就是改平手規則，要寫進文件。
 */
export type PainterId = "google" | "openai";
export const PAINTERS: readonly PainterId[] = ["google", "openai"];

export function isPainterId(v: unknown): v is PainterId {
  return typeof v === "string" && (PAINTERS as readonly string[]).includes(v);
}

/**
 * **勘查員**：寫「地圖參數」的文字模型，依偏好排列。不參與投票 ——
 * 投票決定的是誰來**畫**，參數是文字。第一個有啟用的那一家負責；
 * 一家都沒有就用預設參數（`params.fallbackParams`），施工不會卡住。
 */
export const SURVEYORS: readonly ProviderId[] = ["anthropic", "google"];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_ORDER as readonly string[]).includes(v);
}

/** 這一家做得了這一種步驟嗎 */
export function supports(provider: ProviderId, kind: StepKind): boolean {
  if (kind === "SURVEY") return true;
  return MODEL_PROFILES[provider].typical[kind] !== undefined;
}

/**
 * 參考影像的費用（Google Maps Platform，每次請求）。
 *
 * 它們不是 token，但它們是**捐款花掉的錢**。Street View 的 metadata 查詢免費，
 * 所以勘查本身不花錢；每一張場景圖要抓一張街景、底圖與 3D 圖資各抓一張地圖靜態圖。
 */
export const REFERENCE_FEE_MICROS = {
  streetViewImage: 7_000, // $7 / 1,000
  staticMap: 2_000, // $2 / 1,000
} as const;

/** 每一種步驟要付多少參考影像費 */
export function referenceFeeMicros(kind: StepKind): number {
  switch (kind) {
    case "SCENE":
      return REFERENCE_FEE_MICROS.streetViewImage;
    case "TILE":
    case "DSM":
      return REFERENCE_FEE_MICROS.staticMap;
    case "PARAMS":
      // 版型一張 + 四張代表性街景
      return REFERENCE_FEE_MICROS.staticMap + 4 * REFERENCE_FEE_MICROS.streetViewImage;
    default:
      return 0;
  }
}

export function totalTokens(u: TokenUsage): number {
  return u.textIn + u.imageIn + u.textOut + u.imageOut;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    textIn: a.textIn + b.textIn,
    imageIn: a.imageIn + b.imageIn,
    textOut: a.textOut + b.textOut,
    imageOut: a.imageOut + b.imageOut,
  };
}

/**
 * token → 微美元。每百萬 token $r = 每 token r 微美元，所以就是 Σ tokens × rate。
 */
export function usageCostMicros(rates: Rates, u: TokenUsage): number {
  return Math.round(
    u.textIn * rates.textIn +
      u.imageIn * rates.imageIn +
      u.textOut * rates.textOut +
      u.imageOut * rates.imageOut,
  );
}

/** 依模型名稱找價目（API 回報的實際服務模型可能和請求的不同，例如 fallback） */
export function profileForModel(model: string): ModelProfile | null {
  for (const id of PROVIDER_ORDER) {
    const p = MODEL_PROFILES[id];
    if (p.model === model || model.startsWith(`${p.model}-`)) return p;
  }
  return null;
}
