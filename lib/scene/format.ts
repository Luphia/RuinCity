/**
 * 場景包（scene bundle）的格式：一塊完成的地圖，**離開這個網站也能重建**。
 * 純函式，無 I/O —— 瀏覽器（獨立檢視器）與伺服器（打包）共用。
 *
 * ## 一個場景包裡有什麼
 *
 * ```
 * <根 CID>/
 *   index.html          獨立檢視器（不連任何 CDN）
 *   viewer.js           檢視器本體 —— 和網站上的 3D 用的是同一份渲染程式
 *   scene.json          這份清單（每個檔案的 SHA-256、座標、參數、渲染規格、出處）
 *   README.txt          怎麼打開、怎麼驗證
 *   map/tile.webp       正射底圖
 *   map/dsm.webp        高度圖
 *   scenes/000.webp …   標記座標場景圖
 *   textures/0.webp …   材質貼圖
 * ```
 *
 * ## ★「一模一樣」靠的是三件事
 *
 * 1. **重建用的是成品，不是重畫。** AI 繪製不可重現（同一個提示詞兩次畫出兩張圖），
 *    所以包裡放的是當初畫出來的那些位元組，原封不動 —— 網站出的也是同一批位元組。
 * 2. **渲染規格寫在清單裡**（`render`），檢視器只照清單畫，不讀自己的預設值。
 *    之後網站改了預設，舊的包仍然照它當年的規格畫。
 * 3. **檢視器跟著包走。** 每一個包都帶著發布當下的 `viewer.js`；
 *    IPFS 依內容去重，一萬個包裡同一版檢視器只佔一份空間。
 *
 * 清單用**正規化 JSON**（鍵排序、固定縮排、結尾換行）：同樣的資料永遠是同樣的位元組，
 * 於是同樣的場景永遠是同一個 CID。
 */

export const SCENE_FORMAT = "ruincity.scene/1";

export type Vec3 = readonly [number, number, number];

/** 渲染規格。檢視器只照這份畫，不讀自己的預設值 */
export interface RenderSpec {
  readonly version: number;
  readonly background: string;
  readonly terrain: {
    /** 網格每邊的段數（頂點 = (段數+1)²） */
    readonly segments: number;
    /** 平面寬 1；高度圖白色 = 這麼高（與寬同單位）。只是視覺比例，不是公尺 */
    readonly displacementScale: number;
  };
  readonly camera: {
    readonly fovDeg: number;
    readonly near: number;
    readonly far: number;
    /** 北 = +y、上 = +z */
    readonly position: Vec3;
    readonly target: Vec3;
    readonly minDistance: number;
    readonly maxDistance: number;
  };
  readonly light: {
    readonly sky: string;
    readonly ground: string;
    readonly hemisphereIntensity: number;
    readonly sun: string;
    readonly sunIntensity: number;
    readonly sunDirection: Vec3;
  };
}

/** 第一版渲染規格。改任何一個數字都要開新版本，不能改這一份 —— 已發布的包引用它 */
export const RENDER_V1: RenderSpec = {
  version: 1,
  background: "#141311",
  terrain: { segments: 255, displacementScale: 0.12 },
  camera: {
    fovDeg: 45,
    near: 0.01,
    far: 100,
    position: [0, -1.1, 0.9],
    target: [0, 0, 0],
    minDistance: 0.2,
    maxDistance: 5,
  },
  light: {
    sky: "#dfe8d0",
    ground: "#2a261f",
    hemisphereIntensity: 0.55,
    sun: "#fff3dd",
    sunIntensity: 0.75,
    sunDirection: [1, -1, 2],
  },
};

/**
 * 場景包的授權：**CC0 1.0**（放棄著作權，等同公眾領域）。
 *
 * 「任何人都能重建」要成立，不只是技術上拿得到，還要法律上被允許複製、散布、改作 ——
 * 所以授權寫在清單裡，跟著每一份副本走。範圍是整個資料夾：圖、地圖參數、文字與檢視器。
 *
 * ★ CC0 只能放棄**平台自己擁有的**權利。參考影像（Google 街景、衛星圖）的權利不屬於平台，
 *   這裡也沒有放進包裡；它們與成品之間的關係是設計文件 §7 #1 的待決事項。
 */
export const SCENE_LICENSE = {
  id: "CC0-1.0",
  name: "CC0 1.0 Universal (Public Domain Dedication)",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
  statement:
    "To the extent possible under law, the RuinCity project has waived all copyright and related or neighboring rights to this scene bundle (images, map parameters, texts and viewer). This work is published from: Taiwan.",
} as const;

export interface SceneLicense {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly statement: string;
}

export interface SceneFileEntry {
  readonly sha256: string;
  readonly bytes: number;
  readonly mime: string;
}

export interface SceneImage {
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface SceneManifest {
  readonly format: typeof SCENE_FORMAT;
  readonly title: string;
  /** 授權（`SCENE_LICENSE`）。早於授權欄位的開發用包沒有它，所以讀的時候當作可能缺少 */
  readonly license?: SceneLicense;
  readonly world: {
    readonly name: string;
    readonly grid: string;
    readonly origin: { readonly name: string; readonly lat: number; readonly lng: number };
  };
  readonly block: {
    readonly key: string;
    readonly row: number;
    readonly col: number;
    readonly bounds: { readonly south: number; readonly north: number; readonly west: number; readonly east: number };
    readonly sizeM: { readonly width: number; readonly height: number };
  };
  readonly completedAt: string;
  /** 正射底圖：Web Mercator（EPSG:3857）上剛好框住這一塊 */
  readonly map: (SceneImage & { readonly projection: "EPSG:3857" }) | null;
  /** 高度圖：與底圖逐像素對齊；黑 = 最低、白 = 最高（相對值） */
  readonly terrain: (SceneImage & { readonly encoding: "grayscale-relative" }) | null;
  readonly scenes: readonly (SceneImage & {
    readonly index: number;
    readonly lat: number;
    readonly lng: number;
    readonly heading: number;
    readonly pitch: number;
    readonly fov: number;
    readonly caption: string | null;
    /** 構圖參考的街景拍攝年月（參考影像本身不在包裡） */
    readonly referenceDate: string | null;
  })[];
  readonly textures: readonly (SceneImage & { readonly index: number; readonly material: string | null })[];
  readonly fieldNote: string | null;
  /** 勘查員寫的地圖參數（原樣） */
  readonly params: unknown;
  readonly render: RenderSpec;
  readonly credits: readonly { readonly company: string; readonly model: string; readonly steps: number }[];
  readonly provenance: {
    readonly bibleVersions: readonly string[];
    readonly pricingVersions: readonly string[];
    readonly steps: readonly {
      readonly seq: number;
      readonly kind: string;
      readonly index: number;
      readonly provider: string | null;
      readonly model: string | null;
      readonly tokens: number;
      readonly costMicroUsd: number;
    }[];
  };
  /** 除了 scene.json 自己以外的每一個檔案 */
  readonly files: Readonly<Record<string, SceneFileEntry>>;
}

export const MANIFEST_PATH = "scene.json";
export const VIEWER_HTML_PATH = "index.html";
export const VIEWER_JS_PATH = "viewer.js";
export const README_PATH = "README.txt";

function ext(mime: string): string {
  return mime === "image/webp" ? "webp" : mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "bin";
}

/** 每一種產出在包裡的路徑。改了會讓同樣的場景得到不同的 CID —— 別改 */
export function artifactPath(kind: string, index: number, mime: string): string {
  switch (kind) {
    case "TILE":
      return `map/tile.${ext(mime)}`;
    case "DSM":
      return `map/dsm.${ext(mime)}`;
    case "SCENE":
      return `scenes/${String(index).padStart(3, "0")}.${ext(mime)}`;
    case "TEXTURE":
      return `textures/${index}.${ext(mime)}`;
    default:
      throw new Error(`未知的產出種類：${kind}`);
  }
}

/**
 * 正規化 JSON：物件的鍵依 UTF-16 排序、兩格縮排、結尾一個換行。
 * `undefined` 一律不允許（`JSON.stringify` 會默默丟掉它，兩邊就可能不一樣）。
 */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown, path: string): unknown => {
    if (v === undefined) throw new Error(`正規化 JSON 不允許 undefined：${path}`);
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`正規化 JSON 不允許 ${v}：${path}`);
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x, i) => norm(x, `${path}[${i}]`));
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) out[k] = norm((v as Record<string, unknown>)[k], `${path}.${k}`);
    return out;
  };
  return `${JSON.stringify(norm(value, "$"), null, 2)}\n`;
}

/** 最基本的形狀檢查：檢視器與驗證工具在讀清單前先問這一句 */
export function isSceneManifest(v: unknown): v is SceneManifest {
  if (!v || typeof v !== "object") return false;
  const m = v as Partial<SceneManifest>;
  return (
    m.format === SCENE_FORMAT &&
    typeof m.title === "string" &&
    !!m.block &&
    !!m.render &&
    !!m.files &&
    typeof m.files === "object" &&
    Array.isArray(m.scenes) &&
    Array.isArray(m.textures)
  );
}

/** 清單裡被引用的檔案都要在 `files` 裡（打包與驗證都會檢查） */
export function referencedFiles(m: SceneManifest): string[] {
  const out: string[] = [];
  if (m.map) out.push(m.map.file);
  if (m.terrain) out.push(m.terrain.file);
  for (const s of m.scenes) out.push(s.file);
  for (const t of m.textures) out.push(t.file);
  return out;
}

/** 底圖上一個經緯度落在哪裡（百分比；北在上）。網站與獨立檢視器共用 */
export function markerPosition(
  bounds: SceneManifest["block"]["bounds"],
  lat: number,
  lng: number,
): { left: number; top: number } {
  return {
    left: ((lng - bounds.west) / (bounds.east - bounds.west)) * 100,
    top: ((bounds.north - lat) / (bounds.north - bounds.south)) * 100,
  };
}

export function readmeText(m: Pick<SceneManifest, "title" | "block">): string {
  return `RuinCity · One Thousand Years After — ${m.title} (block ${m.block.key})
================================================================

This folder is a complete, self-contained scene: every image exactly as it was
drawn, plus the viewer that displays it. Nothing here needs the original website.

LICENSE
  ${SCENE_LICENSE.name} — ${SCENE_LICENSE.url}
  ${SCENE_LICENSE.statement}
  You may copy, modify, distribute and use it, even commercially, without asking.

GET IT
  It is kept by Boltchain SwarmStorage (paid, audited replicas). From any Boltchain node's
  gateway, the deal index CAR contains every block of this folder:
    curl -o scene.car "http://<boltchain-gateway>/ipfs/<deal index CID>?format=car"
  or over Bitswap with Kubo/Helia connected to a Boltchain node, or from any IPFS node
  that holds it: ipfs get <this folder's CID>

OPEN IT
  Unpack and serve the folder over HTTP:
    pnpm scene:verify scene.car --extract ./scene   (in the RuinCity repository), or
    ipfs dag import scene.car && ipfs get <CID>
  then: python3 -m http.server   and open http://localhost:8000/
  Through an IPFS HTTP gateway that has the blocks: https://<gateway>/ipfs/<CID>/
  (Browsers block WebGL textures from file:// pages, so the 3D view needs HTTP.)

VERIFY IT
  scene.json lists the SHA-256 of every other file. The viewer checks them when
  it loads and says so on screen. The folder's CID is reproducible with stock Kubo:
    ipfs add -r --only-hash --cid-version=1 --raw-leaves --chunker=size-1048576 <folder>

WHAT IS IN IT
  scene.json      coordinates, map parameters, render settings, credits, provenance
  map/tile.*      orthophoto of the block (Web Mercator, north up)
  map/dsm.*       height map aligned pixel-for-pixel with the tile
  scenes/*        ground-level photographs at the marked coordinates
  textures/*      seamless material textures
  index.html, viewer.js   the viewer (no network access, no external libraries)

Street View and satellite reference images used while drawing are NOT included.
`;
}
