/**
 * 組出一塊的場景包，以及驗證一個場景包。無 DB、無網路。
 *
 * 場景包 = 「凍結的附檔」（scene.json、index.html、viewer.js、README.txt）＋ 每一張圖的原始位元組。
 * 附檔在第一次打包時產生並存進 `scene_files`，之後**只讀不寫** ——
 * 這樣即使網站之後改了清單的欄位或檢視器，已發布的包仍然重建得出同一個 CID。
 */

import { blockBounds, blockShortLabel, blockSizeM, TAIPEI_101, type BlockId } from "@/lib/world/grid";
import type { MapParams } from "@/lib/world/params";
import type { Viewpoint } from "@/lib/world/prompts";

import {
  MANIFEST_PATH,
  README_PATH,
  RENDER_V1,
  SCENE_FORMAT,
  SCENE_LICENSE,
  VIEWER_HTML_PATH,
  VIEWER_JS_PATH,
  artifactPath,
  canonicalJson,
  isSceneManifest,
  readmeText,
  referencedFiles,
  type SceneManifest,
} from "./format";

export interface BundleFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface BundleArtifact {
  readonly kind: string;
  readonly kindIndex: number;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly label: string | null;
  readonly bytes: Uint8Array;
}

export interface BundleInput {
  readonly block: BlockId;
  readonly key: string;
  readonly completedAt: Date;
  readonly viewpoints: readonly Viewpoint[];
  readonly params: MapParams | null;
  readonly artifacts: readonly BundleArtifact[];
  readonly steps: readonly {
    readonly seq: number;
    readonly kind: string;
    readonly kindIndex: number;
    readonly provider: string | null;
    readonly model: string | null;
    readonly company: string | null;
    readonly displayName: string | null;
    readonly tokens: number;
    readonly costMicros: number;
    readonly bibleVersion: string;
    readonly pricingVersion: string;
  }[];
  readonly viewer: { readonly html: string; readonly js: string };
}

const enc = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 圖 → 包裡的檔案（路徑固定，見 `format.artifactPath`） */
export function artifactFiles(artifacts: readonly BundleArtifact[]): BundleFile[] {
  return artifacts.map((a) => ({ path: artifactPath(a.kind, a.kindIndex, a.mime), bytes: a.bytes }));
}

/** 第一次打包：產生附檔（之後凍結） */
export async function buildExtras(input: BundleInput): Promise<{ extras: BundleFile[]; manifest: SceneManifest }> {
  const byKind = (k: string) => input.artifacts.filter((a) => a.kind === k).sort((a, b) => a.kindIndex - b.kindIndex);
  const tile = byKind("TILE")[0];
  const dsm = byKind("DSM")[0];
  const html = enc.encode(input.viewer.html);
  const js = enc.encode(input.viewer.js);
  const title = blockShortLabel(input.block);
  const readme = enc.encode(readmeText({ title, block: { key: input.key } as SceneManifest["block"] }));

  const files: Record<string, { sha256: string; bytes: number; mime: string }> = {};
  const add = async (path: string, bytes: Uint8Array, mime: string) => {
    files[path] = { sha256: await sha256Hex(bytes), bytes: bytes.length, mime };
  };
  for (const a of input.artifacts) await add(artifactPath(a.kind, a.kindIndex, a.mime), a.bytes, a.mime);
  await add(VIEWER_HTML_PATH, html, "text/html; charset=utf-8");
  await add(VIEWER_JS_PATH, js, "text/javascript; charset=utf-8");
  await add(README_PATH, readme, "text/plain; charset=utf-8");

  const credits = new Map<string, { company: string; model: string; steps: number }>();
  for (const s of input.steps) {
    if (!s.provider || !s.company || !s.displayName) continue;
    const c = credits.get(s.provider) ?? { company: s.company, model: s.displayName, steps: 0 };
    c.steps++;
    credits.set(s.provider, c);
  }

  const { width, height } = blockSizeM(input.block);
  const manifest: SceneManifest = {
    format: SCENE_FORMAT,
    title,
    license: SCENE_LICENSE,
    world: {
      name: "RuinCity · 千年之後",
      grid: "0.01° × 0.01° latitude/longitude blocks",
      origin: { name: "Taipei 101", lat: TAIPEI_101.lat, lng: TAIPEI_101.lng },
    },
    block: {
      key: input.key,
      row: input.block.row,
      col: input.block.col,
      bounds: blockBounds(input.block),
      sizeM: { width: Math.round(width), height: Math.round(height) },
    },
    completedAt: input.completedAt.toISOString(),
    map: tile
      ? { file: artifactPath("TILE", 0, tile.mime), width: tile.width, height: tile.height, projection: "EPSG:3857" }
      : null,
    terrain: dsm
      ? { file: artifactPath("DSM", 0, dsm.mime), width: dsm.width, height: dsm.height, encoding: "grayscale-relative" }
      : null,
    scenes: byKind("SCENE").map((a) => {
      const v = input.viewpoints[a.kindIndex];
      return {
        index: a.kindIndex,
        file: artifactPath("SCENE", a.kindIndex, a.mime),
        width: a.width,
        height: a.height,
        lat: v?.location.lat ?? 0,
        lng: v?.location.lng ?? 0,
        heading: v?.heading ?? 0,
        pitch: v?.pitch ?? 0,
        fov: v?.fov ?? 90,
        caption: input.params?.markers[a.kindIndex]?.caption ?? a.label ?? null,
        referenceDate: v?.date ?? null,
      };
    }),
    textures: byKind("TEXTURE").map((a) => ({
      index: a.kindIndex,
      file: artifactPath("TEXTURE", a.kindIndex, a.mime),
      width: a.width,
      height: a.height,
      material: a.label ?? input.params?.materials[a.kindIndex] ?? null,
    })),
    fieldNote: input.params?.fieldNote ?? null,
    params: input.params ?? null,
    render: RENDER_V1,
    credits: [...credits.values()],
    provenance: {
      bibleVersions: [...new Set(input.steps.map((s) => s.bibleVersion))].sort(),
      pricingVersions: [...new Set(input.steps.map((s) => s.pricingVersion))].sort(),
      steps: input.steps.map((s) => ({
        seq: s.seq,
        kind: s.kind,
        index: s.kindIndex,
        provider: s.provider,
        model: s.model,
        tokens: s.tokens,
        costMicroUsd: s.costMicros,
      })),
    },
    files,
  };

  return {
    manifest,
    extras: [
      { path: MANIFEST_PATH, bytes: enc.encode(canonicalJson(manifest)) },
      { path: VIEWER_HTML_PATH, bytes: html },
      { path: VIEWER_JS_PATH, bytes: js },
      { path: README_PATH, bytes: readme },
    ],
  };
}

export type BundleCheck =
  | { readonly ok: true; readonly manifest: SceneManifest; readonly files: number }
  | { readonly ok: false; readonly problems: readonly string[]; readonly manifest: SceneManifest | null };

/**
 * 驗證一個場景包：清單認得出來、清單引用的檔案都在、每個檔案的 SHA-256 對得上、
 * 沒有清單沒列的檔案。發布前伺服器先對自己跑一次 —— 付錢保存之前，先確定它重建得出來。
 */
export async function verifyBundleFiles(files: readonly BundleFile[]): Promise<BundleCheck> {
  const problems: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const raw = byPath.get(MANIFEST_PATH);
  if (!raw) return { ok: false, problems: ["缺少 scene.json"], manifest: null };
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(raw.bytes));
  } catch {
    return { ok: false, problems: ["scene.json 不是合法的 JSON"], manifest: null };
  }
  if (!isSceneManifest(manifest)) return { ok: false, problems: [`scene.json 不是 ${SCENE_FORMAT}`], manifest: null };
  if (canonicalJson(manifest) !== new TextDecoder().decode(raw.bytes)) problems.push("scene.json 不是正規化 JSON");
  for (const p of referencedFiles(manifest)) if (!manifest.files[p]) problems.push(`清單引用了 ${p}，但 files 沒有列它`);
  for (const [path, f] of Object.entries(manifest.files)) {
    const got = byPath.get(path);
    if (!got) {
      problems.push(`缺少 ${path}`);
      continue;
    }
    if (got.bytes.length !== f.bytes) problems.push(`${path} 的大小不符`);
    else if ((await sha256Hex(got.bytes)) !== f.sha256) problems.push(`${path} 的 SHA-256 不符`);
  }
  for (const f of files) if (f.path !== MANIFEST_PATH && !manifest.files[f.path]) problems.push(`多出清單沒列的檔案 ${f.path}`);
  return problems.length
    ? { ok: false, problems, manifest }
    : { ok: true, manifest, files: files.length };
}
