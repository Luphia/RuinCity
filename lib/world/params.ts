/**
 * 地圖參數：PARAMS 步驟的產出，之後每一步都讀它。純函式，無 I/O。
 *
 * ★ 一百張場景圖可能出自三家模型 —— 參數是它們共同的「這裡長什麼樣」：
 *   水淹到哪、植被多密、牆是什麼做的。沒有它，同一塊地上的兩張圖
 *   可能一張是沼澤、一張是乾燥的森林。
 *
 * 模型回的 JSON 不可信（可能多一段 Markdown、少一個欄位、數字超出範圍），
 * 所以一律經過 `parseMapParams` 修正成合法值；完全解析不了就用 `fallbackParams`
 * —— 施工不能因為一份參數格式不對就卡死在第二步。
 */

import { z } from "zod";

import { TEXTURES_PER_BLOCK } from "./plan";

export const WATER_LEVELS = ["dry", "damp", "marshy", "partly flooded", "mostly flooded"] as const;

const paramsSchema = z.object({
  biome: z.string().min(1).max(120),
  waterLevel: z.enum(WATER_LEVELS),
  vegetationDensity: z.number().min(0).max(1),
  ruinState: z.string().min(1).max(400),
  palette: z.array(z.string().min(1).max(40)).max(8),
  landmarks: z
    .array(z.object({ name: z.string().min(1).max(60), description: z.string().min(1).max(300) }))
    .max(5),
  materials: z.array(z.string().min(1).max(80)),
  markers: z.array(z.object({ index: z.number().int().min(0), caption: z.string().min(1).max(200) })),
  fieldNote: z.string().min(1).max(800),
});

export type MapParams = z.infer<typeof paramsSchema>;

/** 參數裡材質不足八種時的補位 —— 依水位挑，讓補上去的也說得通 */
const DEFAULT_MATERIALS = [
  "moss-covered cracked concrete",
  "asphalt split by roots and grass",
  "forest floor with ferns and leaf litter",
  "rust-stained collapsed steel",
  "brick rubble overgrown with vines",
  "shallow muddy water with reeds",
  "banyan aerial roots over stone",
  "weathered ceramic tile fragments",
];

export function fallbackParams(markerCount: number): MapParams {
  return {
    biome: "humid forest reclaiming a ruined city",
    waterLevel: "damp",
    vegetationDensity: 0.75,
    ruinState: "Most buildings have collapsed into overgrown mounds; a few concrete shells still stand.",
    palette: ["deep green", "moss", "rust", "grey concrete"],
    landmarks: [],
    materials: DEFAULT_MATERIALS.slice(0, TEXTURES_PER_BLOCK),
    markers: Array.from({ length: markerCount }, (_, i) => ({ index: i, caption: "An overgrown street." })),
    fieldNote: "勘查參數未能取得，以預設值施工。",
  };
}

/** 從模型的回答裡挖出第一個 JSON 物件 */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 模型的回答 → 合法的參數。
 *
 * 修正而不是拒絕：截斷過長的字串、把數字夾回範圍、材質補足八種、
 * 每個標記座標都要有一句說明（缺的補預設）。回傳 `repaired` 讓施工紀錄記得這件事。
 */
export function parseMapParams(text: string, markerCount: number): { params: MapParams; repaired: boolean } {
  const raw = extractJson(text) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") return { params: fallbackParams(markerCount), repaired: true };

  const fb = fallbackParams(markerCount);
  const str = (v: unknown, max: number, d: string) =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : d;
  const strList = (v: unknown, max: number, itemMax: number) =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, itemMax)).slice(0, max)
      : [];

  const materials = strList(raw.materials, TEXTURES_PER_BLOCK, 80);
  for (const m of DEFAULT_MATERIALS) {
    if (materials.length >= TEXTURES_PER_BLOCK) break;
    if (!materials.includes(m)) materials.push(m);
  }

  const captions = new Map<number, string>();
  if (Array.isArray(raw.markers)) {
    for (const m of raw.markers as unknown[]) {
      if (!m || typeof m !== "object") continue;
      const { index, caption } = m as { index?: unknown; caption?: unknown };
      if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < markerCount && typeof caption === "string" && caption.trim()) {
        captions.set(index, caption.trim().slice(0, 200));
      }
    }
  }

  const landmarks = Array.isArray(raw.landmarks)
    ? (raw.landmarks as unknown[])
        .filter((l): l is { name: string; description: string } => {
          const o = l as { name?: unknown; description?: unknown };
          return !!l && typeof o.name === "string" && typeof o.description === "string" && !!o.name.trim() && !!o.description.trim();
        })
        .slice(0, 5)
        .map((l) => ({ name: l.name.trim().slice(0, 60), description: l.description.trim().slice(0, 300) }))
    : [];

  const density = typeof raw.vegetationDensity === "number" && Number.isFinite(raw.vegetationDensity)
    ? Math.max(0, Math.min(1, raw.vegetationDensity))
    : fb.vegetationDensity;

  const params: MapParams = {
    biome: str(raw.biome, 120, fb.biome),
    waterLevel: (WATER_LEVELS as readonly string[]).includes(raw.waterLevel as string)
      ? (raw.waterLevel as MapParams["waterLevel"])
      : fb.waterLevel,
    vegetationDensity: density,
    ruinState: str(raw.ruinState, 400, fb.ruinState),
    palette: strList(raw.palette, 8, 40),
    landmarks,
    materials,
    markers: Array.from({ length: markerCount }, (_, i) => ({
      index: i,
      caption: captions.get(i) ?? fb.markers[i]!.caption,
    })),
    fieldNote: str(raw.fieldNote, 800, fb.fieldNote),
  };

  const strict = paramsSchema.safeParse(raw);
  const repaired =
    !strict.success ||
    captions.size < markerCount ||
    (Array.isArray(raw.materials) ? (raw.materials as unknown[]).length : 0) < TEXTURES_PER_BLOCK;
  return { params: paramsSchema.parse(params), repaired };
}

/** 參數 → 一段給繪圖模型讀的摘要（每一步都附） */
export function paramsBrief(p: MapParams): string {
  const lines = [
    "ESTABLISHED PARAMETERS FOR THIS BLOCK (all images of this block must agree with these):",
    `- Biome: ${p.biome}`,
    `- Water level: ${p.waterLevel}`,
    `- Vegetation density: ${Math.round(p.vegetationDensity * 100)}%`,
    `- State of the ruins: ${p.ruinState}`,
  ];
  if (p.palette.length) lines.push(`- Palette: ${p.palette.join(", ")}`);
  for (const l of p.landmarks) lines.push(`- Landmark "${l.name}": ${l.description}`);
  return lines.join("\n");
}
