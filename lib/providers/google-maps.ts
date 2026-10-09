/**
 * 參考影像來源：Google Street View Static API 與 Maps Static API。
 * 金鑰是**平台的**（`GOOGLE_MAPS_API_KEY`），不是捐款人的。
 *
 * ## ★ 條款風險（務必先讀 `docs/00-design.md` §7）
 *
 * Google Maps Platform 服務條款有一條「不得以 Google Maps 內容建立內容」
 * （No creating content from Google Maps Content），Street View 明列在內。
 * 把街景交給 AI 轉繪成「一千年後」的圖，很可能正落在這一條上。
 * 這支模組照需求實作了，但**上線之前需要法務確認**；
 * `ReferenceSource` 介面就是為了能換成授權較寬的來源
 * （例如 Mapillary 的 CC BY-SA 街景、OpenStreetMap 的 ODbL 圖資）。
 *
 * 為了把風險壓到最低，這裡做了兩件事：
 *   - **不存** Street View 與地圖的原始影像，只在繪製當下抓、用完即丟。
 *     資料庫裡只有全景 ID（Google 明文允許無限期保存 pano ID）。
 *   - metadata 查詢免費且不回傳影像，勘查只用它。
 *
 * ★ 版型參考改用**衛星影像**之後（為了擬真），衛星圖也落在同一條款裡，
 *   而且衛星影像另有第三方供應商的著作權。風險沒有變小，只是多了一種影像。
 */

import type { LatLng } from "@/lib/world/grid";
import type { PanoCandidate } from "@/lib/world/survey";
import type { Viewpoint } from "@/lib/world/prompts";

import { PainterError, codeForStatus, redact, type FetchLike, type ImageBytes } from "./painter";

export interface ReferenceSource {
  /** 離 `near` 最近的戶外全景；沒有就回 null */
  nearestPano(near: LatLng, radiusM: number): Promise<PanoCandidate | null>;
  /** 一張街景（16:9） */
  streetView(v: Viewpoint): Promise<ImageBytes>;
  /** 一塊今天的衛星影像（剛好框住那一塊，見 `grid.mercatorFrame`） */
  layout(frame: { center: LatLng; zoom: number; width: number; height: number }): Promise<ImageBytes>;
}

const BASE = "https://maps.googleapis.com/maps/api";

/** 街景尺寸：Static API 上限 640，取 16:9 */
export const STREET_VIEW_SIZE = { width: 640, height: 360 } as const;

export function googleMapsSource(apiKey: string, fetchImpl: FetchLike = fetch): ReferenceSource {
  const getImage = async (url: URL, what: string): Promise<ImageBytes> => {
    url.searchParams.set("key", apiKey);
    const res = await fetchImpl(url);
    if (!res.ok) {
      const body = redact(await res.text().catch(() => ""));
      throw new PainterError(codeForStatus(res.status), `${what} 失敗（HTTP ${res.status}）：${body}`);
    }
    const mime = res.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
    if (!mime.startsWith("image/")) {
      throw new PainterError("UPSTREAM", `${what} 回傳的不是影像（${mime}）`);
    }
    return { mime, data: new Uint8Array(await res.arrayBuffer()) };
  };

  return {
    async nearestPano(near, radiusM) {
      const url = new URL(`${BASE}/streetview/metadata`);
      url.searchParams.set("location", `${near.lat},${near.lng}`);
      url.searchParams.set("radius", String(Math.round(radiusM)));
      url.searchParams.set("source", "outdoor");
      url.searchParams.set("key", apiKey);
      const res = await fetchImpl(url);
      if (!res.ok) {
        throw new PainterError(codeForStatus(res.status), `Street View metadata 失敗（HTTP ${res.status}）`);
      }
      const json = (await res.json()) as {
        status?: string;
        pano_id?: string;
        location?: { lat?: number; lng?: number };
        date?: string;
        error_message?: string;
      };
      if (json.status === "ZERO_RESULTS" || json.status === "NOT_FOUND") return null;
      if (json.status !== "OK") {
        const code = json.status === "REQUEST_DENIED" ? "AUTH" : json.status === "OVER_QUERY_LIMIT" ? "QUOTA" : "UPSTREAM";
        throw new PainterError(code, `Street View metadata：${json.status} ${redact(json.error_message ?? "")}`);
      }
      if (!json.pano_id || typeof json.location?.lat !== "number" || typeof json.location?.lng !== "number") {
        return null;
      }
      return {
        panoId: json.pano_id,
        location: { lat: json.location.lat, lng: json.location.lng },
        date: json.date ?? null,
      };
    },

    streetView(v) {
      const url = new URL(`${BASE}/streetview`);
      url.searchParams.set("pano", v.panoId);
      url.searchParams.set("size", `${STREET_VIEW_SIZE.width}x${STREET_VIEW_SIZE.height}`);
      url.searchParams.set("heading", String(Math.round(v.heading)));
      url.searchParams.set("pitch", String(Math.round(v.pitch)));
      url.searchParams.set("fov", String(Math.round(v.fov)));
      // 沒有影像時回 404，而不是一張「抱歉，沒有影像」的灰圖被當成參考照
      url.searchParams.set("return_error_code", "true");
      return getImage(url, "Street View 影像");
    },

    layout(frame) {
      const url = new URL(`${BASE}/staticmap`);
      url.searchParams.set("center", `${frame.center.lat},${frame.center.lng}`);
      url.searchParams.set("zoom", String(frame.zoom));
      url.searchParams.set("size", `${frame.width}x${frame.height}`);
      url.searchParams.set("scale", "2");
      // ★ 衛星影像，不是道路圖：要畫擬真的航照，參考也得是航照 ——
      //   給它一張配色過的道路圖，模型會連那套配色與線條一起「轉繪」出來。
      url.searchParams.set("maptype", "satellite");
      return getImage(url, "衛星靜態圖");
    },
  };
}
