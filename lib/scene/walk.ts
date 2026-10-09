/**
 * 漫遊：在完成的區塊裡操作一個人物走動（第三人稱、越肩鏡頭）。這裡是**純數學**：
 * 座標換算、地面高度、移動與碰撞、鏡頭跟隨。沒有 DOM、沒有 WebGL —— 單元測試涵蓋。
 * 畫面在 `walk-gl.ts`。
 *
 * ## 座標
 *
 * 與 `terrain-gl.ts` 的地景網格相同：平面寬 1（西→東 x ∈ [-½, ½]），高 = 底圖的 高÷寬（南→北 y），
 * 上 = +z，高度圖白色 = `displacementScale`。一個平面單位 = 這一塊的東西寬（公尺，`metersPerUnit`）。
 * 人物的速度、身高、鏡頭距離都用公尺寫在 `WALK_V1`，換算成平面單位才進場景。
 *
 * ## 方位
 *
 * 角度一律「0 = 北、順時針為正」（與街景的 heading 相同）—— 標記座標的朝向可以直接拿來用。
 */

export interface WalkSpec {
  readonly version: number;
  /** 人物身高（公尺） */
  readonly bodyHeightM: number;
  readonly walkSpeedMps: number;
  readonly runSpeedMps: number;
  /** 加速度（公尺／秒²）：起步與停下不是瞬間的 */
  readonly accelMps2: number;
  /** 轉身速度（弧度／秒） */
  readonly turnRadPerS: number;
  /** 一步的步幅（公尺）：走路動畫的週期 */
  readonly strideM: number;
  /** 一次能跨上的高度（公尺）：台階、瓦礫 */
  readonly maxStepM: number;
  /** 能走上的坡度（高 ÷ 水平距離）。更陡的就是牆 */
  readonly maxSlope: number;
  /** 坡度往前看多遠（公尺） */
  readonly probeM: number;
  /** 離區塊邊界多近就停（公尺）：相鄰的塊不在這個場景裡 */
  readonly edgeMarginM: number;
  readonly camera: {
    readonly fovDeg: number;
    /** 鏡頭在人物後方多遠（公尺） */
    readonly distanceM: number;
    readonly minDistanceM: number;
    readonly maxDistanceM: number;
    /** 看向的點離腳底多高（公尺）：越肩鏡頭看的是肩膀高度 */
    readonly lookHeightM: number;
    /** 越肩：往右偏多少（公尺） */
    readonly shoulderM: number;
    /** 俯仰角範圍（弧度，正 = 往下看） */
    readonly minPitch: number;
    readonly maxPitch: number;
    /** 鏡頭至少離地面多高（公尺）：不鑽進地形 */
    readonly groundClearanceM: number;
    readonly nearM: number;
    readonly farM: number;
  };
  /** 霧（每公尺的密度）：晨霧的正典，也遮住遠處太粗的地形 */
  readonly fogDensityPerM: number;
  /** 材質貼圖平鋪一次的邊長（公尺） */
  readonly detailTileM: number;
  /** 走到標記座標多近，可以查看那裡的場景圖（公尺） */
  readonly markerRadiusM: number;
  /** 標記光柱的高度（公尺） */
  readonly beaconHeightM: number;
}

/** 第一版漫遊規格。數字要改就開 WALK_V2 —— 與 RENDER_V1 同一個規矩 */
export const WALK_V1: WalkSpec = {
  version: 1,
  bodyHeightM: 1.75,
  walkSpeedMps: 1.7,
  runSpeedMps: 5.5,
  accelMps2: 9,
  turnRadPerS: 9,
  strideM: 1.5,
  maxStepM: 0.45,
  maxSlope: 1.1,
  probeM: 1,
  edgeMarginM: 2,
  camera: {
    fovDeg: 55,
    distanceM: 3.4,
    minDistanceM: 1.8,
    maxDistanceM: 14,
    lookHeightM: 1.55,
    shoulderM: 0.55,
    minPitch: -0.35,
    maxPitch: 1.1,
    groundClearanceM: 0.35,
    nearM: 0.08,
    farM: 2_500,
  },
  fogDensityPerM: 0.0028,
  detailTileM: 3,
  markerRadiusM: 12,
  beaconHeightM: 18,
};

const M_PER_DEG_LAT = 111_320;

export interface Bounds {
  readonly south: number;
  readonly north: number;
  readonly west: number;
  readonly east: number;
}

/** 一個平面單位是幾公尺（這一塊在中緯度的東西寬） */
export function metersPerUnit(b: Bounds): number {
  const lat = ((b.north + b.south) / 2) * (Math.PI / 180);
  return (b.east - b.west) * M_PER_DEG_LAT * Math.cos(lat);
}

/** 經緯度 → 平面座標（與地景網格相同；aspect = 底圖的 高÷寬） */
export function planeFromLatLng(b: Bounds, aspect: number, lat: number, lng: number): { x: number; y: number } {
  return {
    x: (lng - b.west) / (b.east - b.west) - 0.5,
    y: ((lat - b.south) / (b.north - b.south) - 0.5) * aspect,
  };
}

export function latLngFromPlane(b: Bounds, aspect: number, x: number, y: number): { lat: number; lng: number } {
  return {
    lat: b.south + (y / aspect + 0.5) * (b.north - b.south),
    lng: b.west + (x + 0.5) * (b.east - b.west),
  };
}

export interface HeightField {
  /** 0..1，第一列是北邊 */
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

/** 雙線性取樣；u、t 為 0..1，t = 0 是最上面一列（北）。與地景網格同一個算式 */
export function sampleHeight(h: HeightField, u: number, t: number): number {
  const x = Math.min(h.width - 1, Math.max(0, u * (h.width - 1)));
  const y = Math.min(h.height - 1, Math.max(0, t * (h.height - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(h.width - 1, x0 + 1);
  const y1 = Math.min(h.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => h.data[yy * h.width + xx]!;
  return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy;
}

export interface WalkWorld {
  readonly field: HeightField;
  readonly aspect: number;
  /** 高度圖白色 = 幾個平面單位（`RenderSpec.terrain.displacementScale`） */
  readonly displacement: number;
  readonly metersPerUnit: number;
  readonly spec: WalkSpec;
}

/** 地面高度（平面單位） */
export function groundAt(w: WalkWorld, x: number, y: number): number {
  return sampleHeight(w.field, x + 0.5, 0.5 - y / w.aspect) * w.displacement;
}

/** 方位角（0 = 北、順時針）→ 平面上的單位向量 */
export function dirOf(heading: number): { x: number; y: number } {
  return { x: Math.sin(heading), y: Math.cos(heading) };
}

/** 兩個角度之間最短的差（-π..π） */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export interface WalkState {
  /** 腳底的位置（平面單位） */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 人物面向（0 = 北、順時針） */
  readonly facing: number;
  /** 目前速度（公尺／秒） */
  readonly speed: number;
  /** 走路動畫的相位（步數，小數） */
  readonly phase: number;
  /** 這一格是不是被擋住了（牆、太陡、邊界） */
  readonly blocked: "WALL" | "EDGE" | null;
}

export interface WalkInput {
  /** -1..1：往前（鏡頭看的方向）／往後 */
  readonly forward: number;
  /** -1..1：往右／往左 */
  readonly right: number;
  readonly run: boolean;
  /** 鏡頭的水平方位：移動以鏡頭為準（第三人稱的操作方式） */
  readonly cameraYaw: number;
}

export function spawn(w: WalkWorld, x: number, y: number, facing: number): WalkState {
  return { x, y, z: groundAt(w, x, y), facing, speed: 0, phase: 0, blocked: null };
}

/**
 * 從 (x0, y0) 走到 (x1, y1) 可不可以：邊界、牆（太高的台階或太陡的坡）。
 *
 * ★ 坡度看的是前方固定一段（`probeM`），不是這一格的步長：一格只有幾公分時，
 *   「一格能跨多高」會被重複累加 —— 被擋下、速度歸零、再以極小的步子一點一點爬上牆。
 */
function passable(w: WalkWorld, x0: number, y0: number, x1: number, y1: number): "WALL" | "EDGE" | null {
  const m = w.metersPerUnit;
  const margin = w.spec.edgeMarginM / m;
  const halfH = w.aspect / 2;
  if (x1 < -0.5 + margin || x1 > 0.5 - margin || y1 < -halfH + margin || y1 > halfH - margin) return "EDGE";
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len === 0) return null;
  const probe = Math.max(len, w.spec.probeM / m);
  const px = x0 + ((x1 - x0) / len) * probe;
  const py = y0 + ((y1 - y0) / len) * probe;
  const here = groundAt(w, x0, y0);
  // 前方最高的那一點（終點或探測點）
  const riseM = (Math.max(groundAt(w, x1, y1), groundAt(w, px, py)) - here) * m;
  // 往下走永遠可以（跳下瓦礫）；往上要嘛是一個台階、要嘛坡度夠緩
  if (riseM > w.spec.maxStepM + w.spec.maxSlope * probe * m) return "WALL";
  return null;
}

/**
 * 走一格。移動方向以鏡頭為準；人物轉身朝向移動方向（不是瞬間轉過去）。
 * 被擋住時沿著牆滑（只取 x 或只取 y 的分量）—— 撞到斜的牆不會整個卡住。
 */
export function stepWalk(w: WalkWorld, s: WalkState, input: WalkInput, dt: number): WalkState {
  const spec = w.spec;
  const f = dirOf(input.cameraYaw);
  const r = dirOf(input.cameraYaw + Math.PI / 2);
  let mx = f.x * input.forward + r.x * input.right;
  let my = f.y * input.forward + r.y * input.right;
  const mag = Math.min(1, Math.hypot(mx, my));
  const moving = mag > 0.05;
  if (moving) {
    const l = Math.hypot(mx, my);
    mx /= l;
    my /= l;
  }

  const target = moving ? (input.run ? spec.runSpeedMps : spec.walkSpeedMps) * mag : 0;
  const dv = spec.accelMps2 * dt;
  const speed = s.speed < target ? Math.min(target, s.speed + dv) : Math.max(target, s.speed - dv * 1.5);

  let facing = s.facing;
  if (moving) {
    const want = Math.atan2(mx, my);
    const d = angleDelta(facing, want);
    const turn = spec.turnRadPerS * dt;
    facing = Math.abs(d) <= turn ? want : facing + Math.sign(d) * turn;
  }
  // 停下來時沿著最後的面向滑行到停
  const dir = moving ? { x: mx, y: my } : dirOf(facing);
  const du = (speed * dt) / w.metersPerUnit;
  if (du <= 0) return { ...s, speed, facing, blocked: null };

  const tries: [number, number][] = [
    [s.x + dir.x * du, s.y + dir.y * du],
    [s.x + dir.x * du, s.y],
    [s.x, s.y + dir.y * du],
  ];
  let blocked: WalkState["blocked"] = null;
  for (const [i, [nx, ny]] of tries.entries()) {
    // 沿牆滑的時候，分量太小就不算（免得貼著牆抖動）
    if (i > 0 && Math.hypot(nx - s.x, ny - s.y) < du * 0.2) continue;
    const why = passable(w, s.x, s.y, nx, ny);
    if (why === null) {
      const moved = Math.hypot(nx - s.x, ny - s.y) * w.metersPerUnit;
      return { x: nx, y: ny, z: groundAt(w, nx, ny), facing, speed, phase: s.phase + moved / spec.strideM, blocked: i > 0 ? blocked : null };
    }
    blocked ??= why;
  }
  return { ...s, facing, speed: 0, blocked };
}

export interface CameraPose {
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

/**
 * 越肩鏡頭：看向人物肩膀右側一點，從後方 `distanceM` 拉開。
 * pitch 正 = 往下看。鏡頭不鑽進地形：低於地面 + 間隙就往上推。
 */
export function followCamera(
  w: WalkWorld,
  s: WalkState,
  yaw: number,
  pitch: number,
  distanceM: number,
  shoulderM: number = w.spec.camera.shoulderM,
): CameraPose {
  const m = w.metersPerUnit;
  const c = w.spec.camera;
  const right = dirOf(yaw + Math.PI / 2);
  const fwd = dirOf(yaw);
  const tx = s.x + (right.x * shoulderM) / m;
  const ty = s.y + (right.y * shoulderM) / m;
  const tz = s.z + c.lookHeightM / m;
  const d = distanceM / m;
  const ex = tx - fwd.x * d * Math.cos(pitch);
  const ey = ty - fwd.y * d * Math.cos(pitch);
  let ez = tz + d * Math.sin(pitch);
  const floor = groundAt(w, ex, ey) + c.groundClearanceM / m;
  if (ez < floor) ez = floor;
  return { eye: [ex, ey, ez], target: [tx, ty, tz] };
}

export interface MarkerSpot {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

/** 最近的標記座標與距離（公尺）、相對於人物的方位 */
export function nearestMarker(
  w: WalkWorld,
  s: Pick<WalkState, "x" | "y">,
  markers: readonly MarkerSpot[],
): { index: number; distanceM: number; bearing: number } | null {
  let best: { index: number; distanceM: number; bearing: number } | null = null;
  for (const mk of markers) {
    const dx = mk.x - s.x;
    const dy = mk.y - s.y;
    const dist = Math.hypot(dx, dy) * w.metersPerUnit;
    if (!best || dist < best.distanceM) best = { index: mk.index, distanceM: dist, bearing: Math.atan2(dx, dy) };
  }
  return best;
}

/** 方位角 → 「北」「東北」…（指南針用） */
export function compassLabel(heading: number): string {
  const names = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
  const deg = ((heading * 180) / Math.PI + 360) % 360;
  return names[Math.round(deg / 45) % 8]!;
}
