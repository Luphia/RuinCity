/**
 * 地球的經緯度網格。純函式，無 I/O。
 *
 * ## ★ 一塊 = 0.01° × 0.01°
 *
 * 全球切成 18,000 列 × 36,000 欄，每一塊以**西南角**命名
 * （`25.03_121.56` = 北緯 25.03°–25.04°、東經 121.56°–121.57°）。
 *
 * 為什麼是經緯度而不是公尺：公尺網格要選一個投影，而任何投影都只在
 * 一個區域內是方的 —— 換到別的半球就歪了。經緯度網格在全球都是
 * **同一套規則**，任何人看到一個座標都算得出它屬於哪一塊，不必知道投影。
 *
 * 代價是每一塊的實際大小隨緯度變化：在臺北約 1.01 km（東西）× 1.11 km（南北），
 * 在赤道約 1.11 × 1.11，到北緯 60° 只剩 0.56 × 1.11。
 * 這是刻意接受的 —— 「一塊」是**命名與投票的單位**，不是測量的單位。
 *
 * ## ★ 整數索引，不用浮點比大小
 *
 * `25.03 * 100` 在 IEEE 754 底下是 `2502.9999999999995`。
 * 直接 `Math.floor` 的話，剛好落在格線上的點會被分到隔壁那一塊 ——
 * 而「西南角剛好在格線上」正是每一塊自己的名字。
 * 所以所有比較都在**整數的列/欄**上做，浮點只在進出這個模組時出現一次。
 */

/** 每一度切幾塊。0.01° → 100 */
export const BLOCKS_PER_DEGREE = 100;
export const BLOCK_DEG = 1 / BLOCKS_PER_DEGREE;
export const ROWS = 180 * BLOCKS_PER_DEGREE;
export const COLS = 360 * BLOCKS_PER_DEGREE;

/** 地球平均半徑（公尺），只拿來估距離與面積，不拿來定位 */
const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  readonly lat: number;
  readonly lng: number;
}

export interface BlockId {
  /** 0 = 南緯 90°，往北遞增 */
  readonly row: number;
  /** 0 = 西經 180°，往東遞增 */
  readonly col: number;
}

export interface BlockBounds {
  readonly south: number;
  readonly north: number;
  readonly west: number;
  readonly east: number;
}

/**
 * 臺北 101。世界的原點：預設視角、第一個被建設的地方、距離排序的基準。
 * 座標取塔基中心。
 */
export const TAIPEI_101: LatLng = { lat: 25.033964, lng: 121.564468 };

/** 浮點落在格線上時的容忍值（遠小於 1 公分） */
const EPS = 1e-9;

function wrapCol(col: number): number {
  return ((col % COLS) + COLS) % COLS;
}

/** 這個座標屬於哪一塊 */
export function blockOf(p: LatLng): BlockId {
  const lat = Math.max(-90, Math.min(90, p.lat));
  // 北極點本身歸給最北那一列，而不是一個不存在的第 18000 列
  const row = Math.min(ROWS - 1, Math.floor((lat + 90) * BLOCKS_PER_DEGREE + EPS));
  const col = wrapCol(Math.floor((p.lng + 180) * BLOCKS_PER_DEGREE + EPS));
  return { row, col };
}

export function isValidBlock(b: BlockId): boolean {
  return (
    Number.isInteger(b.row) &&
    Number.isInteger(b.col) &&
    b.row >= 0 &&
    b.row < ROWS &&
    b.col >= 0 &&
    b.col < COLS
  );
}

export function blockBounds(b: BlockId): BlockBounds {
  const south = b.row / BLOCKS_PER_DEGREE - 90;
  const west = b.col / BLOCKS_PER_DEGREE - 180;
  return { south, north: south + BLOCK_DEG, west, east: west + BLOCK_DEG };
}

export function blockCenter(b: BlockId): LatLng {
  const { south, west } = blockBounds(b);
  return { lat: south + BLOCK_DEG / 2, lng: west + BLOCK_DEG / 2 };
}

/**
 * 網址與資料庫用的名字：西南角，兩位小數。
 *
 * ★ 不用 `row-col`：玩家會在網址列、聊天、截圖裡看到這個字串，
 *   `25.03_121.56` 一眼就知道在哪裡，`11503-30156` 誰也看不懂。
 */
export function blockKey(b: BlockId): string {
  const { south, west } = blockBounds(b);
  return `${south.toFixed(2)}_${west.toFixed(2)}`;
}

const KEY_RE = /^(-?\d{1,2}\.\d{2})_(-?\d{1,3}\.\d{2})$/;

/** `blockKey` 的反函式。格式不對或超出地球就回 null */
export function parseBlockKey(key: string): BlockId | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const row = Math.round((Number(m[1]) + 90) * BLOCKS_PER_DEGREE);
  const col = Math.round((Number(m[2]) + 180) * BLOCKS_PER_DEGREE);
  const b = { row, col };
  if (!isValidBlock(b)) return null;
  // 只接受**正規**寫法：`25.03_121.56` 可以，`25.030_121.56` 已經被正規式擋掉，
  // 但 `-0.00_…` 這種與 `0.00_…` 同一塊的寫法也要擋 —— 一塊只能有一個名字
  return blockKey(b) === key ? b : null;
}

export function sameBlock(a: BlockId, b: BlockId): boolean {
  return a.row === b.row && a.col === b.col;
}

function hemi(v: number, pos: string, neg: string): string {
  return `${v < 0 ? neg : pos}${Math.abs(v).toFixed(2)}°`;
}

/** 短標籤：`N25.03° E121.56°`（西南角） */
export function blockShortLabel(b: BlockId): string {
  const { south, west } = blockBounds(b);
  return `${hemi(south, "N", "S")} ${hemi(west, "E", "W")}`;
}

/** 長標籤：`北緯 25.03°–25.04° · 東經 121.56°–121.57°` */
export function blockLabel(b: BlockId): string {
  const { south, north, west, east } = blockBounds(b);
  const lat = (v: number) => `${Math.abs(v).toFixed(2)}°`;
  const ns = south >= 0 ? "北緯" : north <= 0 ? "南緯" : "緯度";
  const ew = west >= 0 ? "東經" : east <= 0 ? "西經" : "經度";
  return `${ns} ${lat(south)}–${lat(north)} · ${ew} ${lat(west)}–${lat(east)}`;
}

export const ORIGIN_BLOCK: BlockId = blockOf(TAIPEI_101);

export function isOrigin(b: BlockId): boolean {
  return sameBlock(b, ORIGIN_BLOCK);
}

/** 大圓距離（公尺） */
export function haversineM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 從 `from` 看向 `to` 的方位角（0 = 正北，順時針，0..360） */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const rad = Math.PI / 180;
  const φ1 = from.lat * rad;
  const φ2 = to.lat * rad;
  const Δλ = (to.lng - from.lng) * rad;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360;
}

/** 這一塊實際多大（公尺）。東西向取中線的寬度 */
export function blockSizeM(b: BlockId): { width: number; height: number } {
  const c = blockCenter(b);
  const rad = Math.PI / 180;
  return {
    width: EARTH_RADIUS_M * BLOCK_DEG * rad * Math.cos(c.lat * rad),
    height: EARTH_RADIUS_M * BLOCK_DEG * rad,
  };
}

/** 從臺北 101 到這一塊中心的距離（公尺） */
export function distanceFromOriginM(b: BlockId): number {
  return haversineM(TAIPEI_101, blockCenter(b));
}

/**
 * 一個經緯度範圍裡有哪些塊。地圖畫格線與查詢狀態用。
 *
 * ★ 一定要有上限。使用者把地圖縮到整個亞洲時，範圍裡有幾千萬塊 ——
 *   這個函式不能因為一次縮放就配置幾千萬個物件。超過上限回 null，
 *   呼叫端就知道「太遠了，不要畫格子」。
 */
export function blocksInBounds(bounds: BlockBounds, limit: number): BlockId[] | null {
  const sw = blockOf({ lat: bounds.south, lng: bounds.west });
  const ne = blockOf({ lat: bounds.north, lng: bounds.east });
  const rows = ne.row - sw.row + 1;
  // 跨換日線時東邊的欄號比西邊小
  const cols = ne.col >= sw.col ? ne.col - sw.col + 1 : COLS - sw.col + ne.col + 1;
  if (rows <= 0 || cols <= 0 || rows * cols > limit) return null;
  const out: BlockId[] = [];
  for (let r = sw.row; r <= ne.row; r++) {
    for (let k = 0; k < cols; k++) out.push({ row: r, col: wrapCol(sw.col + k) });
  }
  return out;
}

/** 勘查探針每邊幾個點。10×10 = 100 次 metadata 查詢（免費），對應最多 100 個標記座標 */
export const SURVEY_GRID = 10;

/**
 * 勘查用的探針：塊內 n×n 個點，均勻落在每個小格的中心。
 * 每一個點會問一次 Street View 的 metadata，找最近的全景。
 */
export function surveyProbes(b: BlockId, n = SURVEY_GRID): LatLng[] {
  const { south, west } = blockBounds(b);
  const out: LatLng[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      out.push({ lat: south + (BLOCK_DEG * (y + 0.5)) / n, lng: west + (BLOCK_DEG * (x + 0.5)) / n });
    }
  }
  return out;
}

/** 每個探針的搜尋半徑：剛好蓋住自己那一小格的對角線一半 */
export function surveyRadiusM(b: BlockId, n = SURVEY_GRID): number {
  const { width, height } = blockSizeM(b);
  return Math.ceil(Math.hypot(width / n, height / n) / 2);
}

/**
 * 地圖靜態圖（Web Mercator）要用多少 zoom、多大尺寸，才能**剛好**框住這一塊。
 *
 * 經緯度方塊在 Mercator 上是**直的長方形**：南北跨度要乘上 sec(φ)。
 * 在臺北，0.01° × 0.01° 在 zoom 16 是 466 × 514 像素。
 * 取不超過 640（Static API 的上限）的最大 zoom，細節最多。
 */
export function mercatorFrame(b: BlockId): {
  center: LatLng;
  zoom: number;
  width: number;
  height: number;
} {
  const { south, north } = blockBounds(b);
  const mercY = (lat: number) => {
    const φ = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    return Math.log(Math.tan(Math.PI / 4 + φ / 2)) / (2 * Math.PI);
  };
  const spanX = BLOCK_DEG / 360;
  const spanY = mercY(north) - mercY(south);
  for (let zoom = 18; zoom >= 1; zoom--) {
    const worldPx = 256 * 2 ** zoom;
    const width = Math.round(spanX * worldPx);
    const height = Math.round(spanY * worldPx);
    if (width <= 640 && height <= 640) {
      return { center: blockCenter(b), zoom, width: Math.max(1, width), height: Math.max(1, height) };
    }
  }
  return { center: blockCenter(b), zoom: 1, width: 1, height: 1 };
}
