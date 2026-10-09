/**
 * 漫遊的畫面：第三人稱、越肩鏡頭，在完成的區塊裡操作一個人物走動。**沒有任何相依套件**，只用 WebGL 2。
 *
 * - 地景：與 `terrain-gl.ts` 同一個網格（正射底圖當顏色、高度圖當位移），近處疊材質貼圖的細節，遠處是晨霧
 * - 人物：程式組出來的低多邊形人形（外套、背包、長褲），走路與跑步的擺動由步伐相位驅動
 * - 標記座標：一道道光柱；走近了可以查看 AI 在那裡畫的場景圖（呼叫端負責顯示，見 `onState.nearest`）
 *
 * 移動、碰撞與鏡頭的數學在 `walk.ts`（純函式、有單元測試），這裡只負責畫與接輸入。
 * 數字來自 `WalkSpec` 與 `RenderSpec`，這裡沒有自己的預設值。
 */

import type { RenderSpec } from "./format";
import { buildTerrainMesh, decode, heights, hexToRgb, lookAt, multiply, perspective, type Mat4, type Vec3 } from "./terrain-gl";
import {
  followCamera,
  groundAt,
  latLngFromPlane,
  metersPerUnit,
  nearestMarker,
  planeFromLatLng,
  spawn,
  stepWalk,
  type Bounds,
  type HeightField,
  type MarkerSpot,
  type WalkSpec,
  type WalkState,
  type WalkWorld,
} from "./walk";

export interface WalkMarker {
  readonly index: number;
  readonly lat: number;
  readonly lng: number;
  /** 街景的朝向（0 = 北、順時針，度） */
  readonly heading: number;
}

export interface WalkFrame {
  readonly lat: number;
  readonly lng: number;
  /** 人物面向（弧度，0 = 北、順時針） */
  readonly facing: number;
  /** 鏡頭方位（弧度） */
  readonly cameraYaw: number;
  readonly speedMps: number;
  readonly blocked: WalkState["blocked"];
  readonly nearest: { readonly index: number; readonly distanceM: number; readonly bearing: number } | null;
  /** 0..1：在平面上的位置（小地圖用；u 西→東、t 北→南） */
  readonly u: number;
  readonly t: number;
}

export interface WalkOptions {
  readonly tileUrl: string;
  readonly dsmUrl: string;
  /** 材質貼圖：硬的（混凝土、柏油）與長了東西的（苔、林床）各一張；沒有就只用底圖 */
  readonly detailUrls: { readonly hard: string | null; readonly green: string | null };
  /** 底圖的 高 ÷ 寬 */
  readonly aspect: number;
  readonly bounds: Bounds;
  readonly markers: readonly WalkMarker[];
  /** 從第幾個標記座標出發；沒有標記就從中央 */
  readonly startMarker: number | null;
  readonly render: RenderSpec;
  readonly spec: WalkSpec;
  readonly onReady?: () => void;
  readonly onError?: (message: string) => void;
  /** 每秒約十次 */
  readonly onFrame?: (f: WalkFrame) => void;
  /** 按下互動鍵（E） */
  readonly onInteract?: () => void;
}

export interface WalkHandle {
  /** 搖桿：forward、right 各 -1..1 */
  setStick(forward: number, right: number): void;
  setRun(run: boolean): void;
  /** 轉鏡頭（像素位移，與拖曳相同的靈敏度） */
  look(dx: number, dy: number): void;
  /** 走到某個標記座標，面向它的街景朝向 */
  goTo(markerIndex: number): void;
  /** 暫停鍵盤輸入（例如正在看場景圖） */
  setPaused(paused: boolean): void;
  dispose(): void;
}

// ─────────────────────────────────────────────────────────────
// 著色器
// ─────────────────────────────────────────────────────────────

const TERRAIN_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
uniform mat4 uMvp;
out vec3 vNormal;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vNormal = aNormal;
  vUv = aUv;
  vWorld = aPos;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const LIGHT = `
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform float uHemi;
uniform float uSunI;
uniform vec3 uFog;
uniform float uFogDensity;
uniform vec3 uEye;
uniform float uMeters;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 lit(vec3 albedo, vec3 n) {
  vec3 hemi = mix(toLinear(uGround), toLinear(uSky), n.z * 0.5 + 0.5) * uHemi;
  vec3 sun = toLinear(uSun) * max(dot(n, normalize(uSunDir)), 0.0) * uSunI;
  return albedo * (hemi + sun);
}
vec3 fogged(vec3 linear, vec3 world) {
  float d = length(world - uEye) * uMeters;
  float f = 1.0 - exp(-d * uFogDensity);
  return mix(linear, toLinear(uFog), clamp(f, 0.0, 1.0));
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in vec3 vWorld;
uniform sampler2D uMap;
uniform sampler2D uHard;
uniform sampler2D uGreen;
uniform vec3 uHardMean;
uniform vec3 uGreenMean;
uniform float uDetail;
uniform float uDetailScale;
${LIGHT}
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 base = texture(uMap, vUv).rgb;
  vec3 albedo = toLinear(base);
  if (uDetail > 0.0) {
    // 近處：底圖給大塊的顏色，材質貼圖給細節（綠的地方用長了東西的那一張）
    vec2 duv = vWorld.xy * uDetailScale;
    float greenness = clamp((base.g - max(base.r, base.b)) * 6.0 + 0.35, 0.0, 1.0);
    vec3 hard = texture(uHard, duv).rgb / max(uHardMean, vec3(0.05));
    vec3 green = texture(uGreen, duv).rgb / max(uGreenMean, vec3(0.05));
    vec3 detail = clamp(mix(hard, green, greenness), 0.35, 1.9);
    float d = length(vWorld - uEye) * uMeters;
    float near = 1.0 - smoothstep(25.0, 160.0, d);
    albedo *= mix(vec3(1.0), detail, near * uDetail);
  }
  outColor = vec4(toSrgb(fogged(lit(albedo, n), vWorld)), 1.0);
}`;

/** 人物、光柱、影子共用：mode 0 = 受光的實心、1 = 光柱（往上漸淡）、2 = 圓形影子 */
const SOLID_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vNormal;
out vec2 vUv;
out vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vNormal = normalize(mat3(uModel) * aNormal);
  vUv = aUv;
  vWorld = w.xyz;
  gl_Position = uViewProj * w;
}`;

const SOLID_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in vec3 vWorld;
uniform vec3 uColor;
uniform float uAlpha;
uniform int uMode;
${LIGHT}
out vec4 outColor;
void main() {
  if (uMode == 1) {
    float a = (1.0 - vUv.y) * (1.0 - abs(vUv.x * 2.0 - 1.0));
    outColor = vec4(uColor * a * uAlpha, a * uAlpha);
    return;
  }
  if (uMode == 2) {
    float r = length(vUv * 2.0 - 1.0);
    float a = (1.0 - smoothstep(0.35, 1.0, r)) * uAlpha;
    outColor = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  vec3 c = lit(toLinear(uColor), normalize(vNormal));
  outColor = vec4(toSrgb(fogged(c, vWorld)), 1.0);
}`;

// ─────────────────────────────────────────────────────────────
// 矩陣
// ─────────────────────────────────────────────────────────────

const identity = (): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const translate = (x: number, y: number, z: number): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const scale = (x: number, y: number, z: number): Mat4 => new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
/** 繞 z 軸（從上往下看逆時針為正） */
const rotZ = (a: number): Mat4 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
};
/** 繞 x 軸（人物的左右軸）：正 = 往前抬 */
const rotX = (a: number): Mat4 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
};
const chain = (...ms: Mat4[]): Mat4 => ms.reduce((a, b) => multiply(a, b), identity());

// ─────────────────────────────────────────────────────────────
// 幾何
// ─────────────────────────────────────────────────────────────

interface Geometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}

/** 中心在原點、邊長 1 的方塊 */
function cube(): Geometry {
  const faces: { n: Vec3; u: Vec3; v: Vec3 }[] = [
    { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
    { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
    { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  faces.forEach((f, i) => {
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      positions.push(
        f.n[0] * 0.5 + f.u[0] * a * 0.5 + f.v[0] * b * 0.5,
        f.n[1] * 0.5 + f.u[1] * a * 0.5 + f.v[1] * b * 0.5,
        f.n[2] * 0.5 + f.u[2] * a * 0.5 + f.v[2] * b * 0.5,
      );
      normals.push(...f.n);
      uvs.push((a + 1) / 2, (b + 1) / 2);
    }
    const o = i * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

/** 光柱：兩片交叉的直立面，寬 1、高 1，底在原點；uv.y 0 = 底 */
function beacon(): Geometry {
  const positions = new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1,
    0, -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1,
  ]);
  const normals = new Float32Array(24).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0));
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return { positions, normals, uvs, indices };
}

/** 影子：水平的單位方塊面（-½..½） */
function disc(): Geometry {
  return {
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// ─────────────────────────────────────────────────────────────
// 人物
// ─────────────────────────────────────────────────────────────

/** 一千年後的旅人：舊外套、背包、長褲。顏色是 sRGB */
const OUTFIT = {
  jacket: "#4b5440",
  pants: "#2f3846",
  skin: "#b98f72",
  hair: "#2a231e",
  pack: "#3e3427",
  shoes: "#1d1a17",
} as const;

/**
 * 人物各部位在「人物座標」（公尺；x 右、y 前、z 上，腳底在原點）裡的變換。
 * `phase` 是步數（一步半個週期），`amount` 0..1 是擺動的幅度（停著 = 0）。
 */
export function bodyParts(phase: number, amount: number, running: boolean): { color: keyof typeof OUTFIT; model: Mat4 }[] {
  const a = Math.PI * phase;
  const swing = Math.sin(a) * (running ? 0.85 : 0.5) * amount;
  const kneeL = Math.max(0, -Math.sin(a)) * (running ? 1.2 : 0.6) * amount;
  const kneeR = Math.max(0, Math.sin(a)) * (running ? 1.2 : 0.6) * amount;
  const bob = Math.abs(Math.sin(a)) * (running ? 0.05 : 0.025) * amount;
  const lean = running ? 0.18 * amount : 0.04 * amount;
  const hip = 0.92 + bob;
  const thigh = 0.44;
  const shin = 0.44;
  const out: { color: keyof typeof OUTFIT; model: Mat4 }[] = [];

  const leg = (side: number, angle: number, knee: number) => {
    const root = chain(translate(side * 0.1, 0, hip), rotX(angle));
    out.push({ color: "pants", model: chain(root, translate(0, 0, -thigh / 2), scale(0.15, 0.17, thigh)) });
    const lower = chain(root, translate(0, 0, -thigh), rotX(-knee));
    out.push({ color: "pants", model: chain(lower, translate(0, 0, -shin / 2), scale(0.13, 0.15, shin)) });
    out.push({ color: "shoes", model: chain(lower, translate(0, 0.05, -shin - 0.03), scale(0.12, 0.27, 0.08)) });
  };
  leg(-1, swing, kneeL);
  leg(1, -swing, kneeR);

  const torso = chain(translate(0, 0, hip), rotX(-lean));
  out.push({ color: "pants", model: chain(torso, translate(0, 0, 0.05), scale(0.34, 0.2, 0.16)) });
  out.push({ color: "jacket", model: chain(torso, translate(0, 0, 0.35), scale(0.42, 0.25, 0.5)) });
  out.push({ color: "pack", model: chain(torso, translate(0, -0.2, 0.36), scale(0.34, 0.16, 0.44)) });
  out.push({ color: "skin", model: chain(torso, translate(0, 0, 0.66), scale(0.09, 0.09, 0.08)) });
  out.push({ color: "skin", model: chain(torso, translate(0, 0.01, 0.78), scale(0.19, 0.21, 0.22)) });
  out.push({ color: "hair", model: chain(torso, translate(0, -0.015, 0.86), scale(0.2, 0.22, 0.09)) });

  const arm = (side: number, angle: number) => {
    const root = chain(torso, translate(side * 0.26, 0, 0.56), rotX(angle));
    out.push({ color: "jacket", model: chain(root, translate(0, 0, -0.15), scale(0.11, 0.12, 0.3)) });
    const fore = chain(root, translate(0, 0, -0.3), rotX(0.25 + Math.abs(angle) * 0.5));
    out.push({ color: "jacket", model: chain(fore, translate(0, 0, -0.13), scale(0.1, 0.1, 0.26)) });
    out.push({ color: "skin", model: chain(fore, translate(0, 0, -0.29), scale(0.08, 0.09, 0.09)) });
  };
  arm(-1, -swing * 0.8);
  arm(1, swing * 0.8);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 掛載
// ─────────────────────────────────────────────────────────────

/** 一張圖的平均顏色（sRGB 0..1）：材質細節要除掉它，才不會整片變暗或變亮 */
function meanColor(bitmap: ImageBitmap): Vec3 {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [0.5, 0.5, 0.5];
  ctx.drawImage(bitmap, 0, 0, 8, 8);
  const px = ctx.getImageData(0, 0, 8, 8).data;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < 64; i++) {
    r += px[i * 4]! / 255;
    g += px[i * 4 + 1]! / 255;
    b += px[i * 4 + 2]! / 255;
  }
  return [r / 64, g / 64, b / 64];
}

export function mountWalk(host: HTMLElement, opts: WalkOptions): WalkHandle {
  const { render, spec } = opts;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab;outline:none";
  canvas.tabIndex = 0;
  host.appendChild(canvas);

  let disposed = false;
  const report = (msg: string) => {
    if (!disposed) opts.onError?.(msg);
  };
  const noop: WalkHandle = {
    setStick() {},
    setRun() {},
    look() {},
    goTo() {},
    setPaused() {},
    dispose() {
      disposed = true;
      canvas.remove();
    },
  };
  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) {
    report("這個瀏覽器不支援 WebGL 2，無法漫遊");
    return noop;
  }

  const mPerUnit = metersPerUnit(opts.bounds);
  const cam = spec.camera;
  let world: WalkWorld | null = null;
  let state: WalkState | null = null;
  let markerSpots: MarkerSpot[] = [];
  let yaw = 0;
  let pitch = 0.18;
  let distanceM = cam.distanceM;
  let paused = false;

  // ── 輸入 ──
  const keys = new Set<string>();
  let stick = { forward: 0, right: 0 };
  let stickRun = false;
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (typing(e)) return;
    const k = e.key.toLowerCase();
    if (k === "e" && !e.repeat) {
      opts.onInteract?.();
      return;
    }
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift", " "].includes(k)) {
      keys.add(k);
      if (k.startsWith("arrow") || k === " ") e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
  const onBlur = () => keys.clear();
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  const look = (dx: number, dy: number) => {
    yaw += dx * 0.005;
    pitch = Math.min(cam.maxPitch, Math.max(cam.minPitch, pitch + dy * 0.004));
  };
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    canvas.style.cursor = "grabbing";
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  };
  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) look(e.clientX - prev.x, e.clientY - prev.y);
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch > 0) zoom(pinch / d);
      pinch = d;
    }
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = 0;
    if (pointers.size === 0) canvas.style.cursor = "grab";
  };
  const zoom = (factor: number) => {
    distanceM = Math.min(cam.maxDistanceM, Math.max(cam.minDistanceM, distanceM * factor));
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom(Math.exp(e.deltaY * 0.001));
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // ── GL 物件 ──
  const programs: WebGLProgram[] = [];
  const buffers: WebGLBuffer[] = [];
  const textures: WebGLTexture[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  let terrainProg: WebGLProgram | null = null;
  let solidProg: WebGLProgram | null = null;
  let terrainVao: { vao: WebGLVertexArrayObject; count: number } | null = null;
  let cubeVao: { vao: WebGLVertexArrayObject; count: number } | null = null;
  let beaconVao: { vao: WebGLVertexArrayObject; count: number } | null = null;
  let discVao: { vao: WebGLVertexArrayObject; count: number } | null = null;

  const compile = (vs: string, fs: string) => {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
    programs.push(p);
    return p;
  };
  const upload = (prog: WebGLProgram, g: Geometry) => {
    const vao = gl.createVertexArray()!;
    vaos.push(vao);
    gl.bindVertexArray(vao);
    const attrib = (name: string, data: Float32Array, size: number) => {
      const loc = gl.getAttribLocation(prog, name);
      if (loc < 0) return;
      const buf = gl.createBuffer()!;
      buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attrib("aPos", g.positions, 3);
    attrib("aNormal", g.normals, 3);
    attrib("aUv", g.uvs, 2);
    const ib = gl.createBuffer()!;
    buffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, g.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: g.indices.length };
  };
  const texture = (bitmap: ImageBitmap, repeat: boolean) => {
    const t = gl.createTexture()!;
    textures.push(t);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number));
    return t;
  };
  const setLight = (prog: WebGLProgram) => {
    const l = render.light;
    gl.useProgram(prog);
    gl.uniform3fv(gl.getUniformLocation(prog, "uSky"), hexToRgb(l.sky));
    gl.uniform3fv(gl.getUniformLocation(prog, "uGround"), hexToRgb(l.ground));
    gl.uniform3fv(gl.getUniformLocation(prog, "uSun"), hexToRgb(l.sun));
    gl.uniform3fv(gl.getUniformLocation(prog, "uSunDir"), [...l.sunDirection]);
    gl.uniform1f(gl.getUniformLocation(prog, "uHemi"), l.hemisphereIntensity);
    gl.uniform1f(gl.getUniformLocation(prog, "uSunI"), l.sunIntensity);
    gl.uniform3fv(gl.getUniformLocation(prog, "uFog"), hexToRgb(l.sky));
    gl.uniform1f(gl.getUniformLocation(prog, "uFogDensity"), spec.fogDensityPerM);
    gl.uniform1f(gl.getUniformLocation(prog, "uMeters"), mPerUnit);
  };

  // ── 載入 ──
  void (async () => {
    const optional = (url: string | null) => (url ? decode(url).catch(() => null) : Promise.resolve(null));
    let tile: ImageBitmap;
    let dsm: ImageBitmap;
    let hard: ImageBitmap | null;
    let green: ImageBitmap | null;
    try {
      [tile, dsm, hard, green] = await Promise.all([decode(opts.tileUrl), decode(opts.dsmUrl), optional(opts.detailUrls.hard), optional(opts.detailUrls.green)]);
    } catch {
      report("底圖或高度圖載入失敗");
      return;
    }
    if (disposed) return;
    try {
      terrainProg = compile(TERRAIN_VS, TERRAIN_FS);
      solidProg = compile(SOLID_VS, SOLID_FS);
      const mesh = buildTerrainMesh(heights(dsm), opts.aspect, render.terrain.segments, render.terrain.displacementScale);
      terrainVao = upload(terrainProg, mesh);
      cubeVao = upload(solidProg, cube());
      beaconVao = upload(solidProg, beacon());
      discVao = upload(solidProg, disc());

      // ★ 腳下的高度用網格本身（同一組頂點），人物才會貼著畫出來的地面，不會浮起或陷進去
      const n = render.terrain.segments + 1;
      const fieldData = new Float32Array(n * n);
      for (let i = 0; i < n * n; i++) fieldData[i] = mesh.positions[i * 3 + 2]! / render.terrain.displacementScale;
      const field: HeightField = { data: fieldData, width: n, height: n };
      world = { field, aspect: opts.aspect, displacement: render.terrain.displacementScale, metersPerUnit: mPerUnit, spec };

      markerSpots = opts.markers.map((mk) => ({ index: mk.index, ...planeFromLatLng(opts.bounds, opts.aspect, mk.lat, mk.lng) }));
      const start = opts.markers.find((mk) => mk.index === opts.startMarker) ?? null;
      if (start) {
        const p = planeFromLatLng(opts.bounds, opts.aspect, start.lat, start.lng);
        const h = (start.heading * Math.PI) / 180;
        state = spawn(world, p.x, p.y, h);
        yaw = h;
      } else {
        state = spawn(world, 0, 0, 0);
      }

      gl.activeTexture(gl.TEXTURE0);
      texture(tile, false);
      const hardTex = hard ?? green;
      const greenTex = green ?? hard;
      const detail = hardTex !== null && greenTex !== null;
      gl.useProgram(terrainProg);
      gl.uniform1i(gl.getUniformLocation(terrainProg, "uMap"), 0);
      if (hardTex && greenTex) {
        gl.activeTexture(gl.TEXTURE1);
        texture(hardTex, true);
        gl.activeTexture(gl.TEXTURE2);
        texture(greenTex, true);
        gl.useProgram(terrainProg);
        gl.uniform1i(gl.getUniformLocation(terrainProg, "uHard"), 1);
        gl.uniform1i(gl.getUniformLocation(terrainProg, "uGreen"), 2);
        gl.uniform3fv(gl.getUniformLocation(terrainProg, "uHardMean"), meanColor(hardTex));
        gl.uniform3fv(gl.getUniformLocation(terrainProg, "uGreenMean"), meanColor(greenTex));
      }
      gl.uniform1f(gl.getUniformLocation(terrainProg, "uDetail"), detail ? 0.85 : 0);
      gl.uniform1f(gl.getUniformLocation(terrainProg, "uDetailScale"), mPerUnit / spec.detailTileM);
      setLight(terrainProg);
      setLight(solidProg);
      gl.enable(gl.DEPTH_TEST);
      opts.onReady?.();
    } catch (e) {
      console.error("[walk]", e);
      report("3D 初始化失敗");
    } finally {
      tile.close();
      dsm.close();
      hard?.close();
      green?.close();
    }
  })();

  // ── 迴圈 ──
  const fog = hexToRgb(render.light.sky);
  const colors = Object.fromEntries(Object.entries(OUTFIT).map(([k, v]) => [k, hexToRgb(v)])) as Record<keyof typeof OUTFIT, Vec3>;
  const beaconColor = hexToRgb("#bae6fd");
  let last = performance.now();
  let lastReport = 0;
  let raf = 0;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    // 模擬以固定的小步長推進：速度不受畫面更新率影響（慢的裝置走得一樣快，只是畫面跳）
    let pending = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!world || !state || !terrainProg || !solidProg || !terrainVao || !cubeVao || !beaconVao || !discVao) return;

    // 輸入 → 移動
    const k = (name: string) => (keys.has(name) ? 1 : 0);
    let forward = k("w") + k("arrowup") - k("s") - k("arrowdown") + stick.forward;
    let right = k("d") + k("arrowright") - k("a") - k("arrowleft") + stick.right;
    if (paused) {
      forward = 0;
      right = 0;
    }
    forward = Math.max(-1, Math.min(1, forward));
    right = Math.max(-1, Math.min(1, right));
    const input = { forward, right, run: keys.has("shift") || stickRun, cameraYaw: yaw };
    while (pending > 1e-6) {
      const h = Math.min(1 / 60, pending);
      state = stepWalk(world, state, input, h);
      pending -= h;
    }

    // 直式螢幕（手機）視野窄：鏡頭拉遠、少偏一點，人物才不會塞滿整個畫面
    const portrait = canvas.height > canvas.width;
    const pose = followCamera(world, state, yaw, pitch, distanceM * (portrait ? 1.7 : 1), cam.shoulderM * (portrait ? 0.3 : 1));
    const eye = [...pose.eye] as Vec3;
    const proj = perspective(cam.fovDeg, canvas.width / canvas.height, cam.nearM / mPerUnit, cam.farM / mPerUnit);
    const viewProj = multiply(proj, lookAt(eye, [...pose.target] as Vec3, [0, 0, 1]));

    // 地景
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.useProgram(terrainProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(terrainProg, "uMvp"), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(terrainProg, "uEye"), eye);
    gl.bindVertexArray(terrainVao.vao);
    gl.drawElements(gl.TRIANGLES, terrainVao.count, gl.UNSIGNED_INT, 0);

    // 人物
    gl.useProgram(solidProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(solidProg, "uViewProj"), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(solidProg, "uEye"), eye);
    const uModel = gl.getUniformLocation(solidProg, "uModel");
    const uColor = gl.getUniformLocation(solidProg, "uColor");
    const uAlpha = gl.getUniformLocation(solidProg, "uAlpha");
    const uMode = gl.getUniformLocation(solidProg, "uMode");
    const s = state;
    const inv = 1 / mPerUnit;
    const placed = chain(translate(s.x, s.y, s.z), scale(inv, inv, inv), rotZ(-s.facing));
    const running = s.speed > (spec.walkSpeedMps + spec.runSpeedMps) / 2;
    const amount = Math.min(1, s.speed / spec.walkSpeedMps);
    gl.uniform1i(uMode, 0);
    gl.bindVertexArray(cubeVao.vao);
    for (const p of bodyParts(s.phase, amount, running)) {
      gl.uniformMatrix4fv(uModel, false, multiply(placed, p.model));
      gl.uniform3fv(uColor, colors[p.color]);
      gl.drawElements(gl.TRIANGLES, cubeVao.count, gl.UNSIGNED_INT, 0);
    }

    // 半透明：影子、光柱（不寫深度）
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(uMode, 2);
    gl.uniform1f(uAlpha, 0.45);
    gl.bindVertexArray(discVao.vao);
    gl.uniformMatrix4fv(uModel, false, chain(translate(s.x, s.y, s.z + 0.03 * inv), scale(0.9 * inv, 0.9 * inv, 1)));
    gl.drawElements(gl.TRIANGLES, discVao.count, gl.UNSIGNED_INT, 0);

    const near = nearestMarker(world, s, markerSpots);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.uniform1i(uMode, 1);
    gl.uniform3fv(uColor, beaconColor);
    gl.bindVertexArray(beaconVao.vao);
    for (const mk of markerSpots) {
      const close = near?.index === mk.index && near.distanceM <= spec.markerRadiusM;
      // 站在光柱裡的時候讓它淡掉，不要整個畫面都是光
      const fromEye = Math.hypot(mk.x - eye[0], mk.y - eye[1]) * mPerUnit;
      const fade = Math.min(1, Math.max(0, (fromEye - 3) / 12));
      if (fade <= 0) continue;
      gl.uniform1f(uAlpha, (close ? 0.75 : 0.35) * fade);
      const width = (close ? 0.9 : 0.6) * inv;
      gl.uniformMatrix4fv(uModel, false, chain(translate(mk.x, mk.y, groundAt(world, mk.x, mk.y)), rotZ(yaw), scale(width, width, spec.beaconHeightM * inv)));
      gl.drawElements(gl.TRIANGLES, beaconVao.count, gl.UNSIGNED_INT, 0);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);

    if (now - lastReport > 100) {
      lastReport = now;
      const ll = latLngFromPlane(opts.bounds, opts.aspect, s.x, s.y);
      opts.onFrame?.({
        lat: ll.lat,
        lng: ll.lng,
        facing: s.facing,
        cameraYaw: yaw,
        speedMps: s.speed,
        blocked: s.blocked,
        nearest: near,
        u: s.x + 0.5,
        t: 0.5 - s.y / opts.aspect,
      });
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    setStick(f, r) {
      stick = { forward: f, right: r };
    },
    setRun(r) {
      stickRun = r;
    },
    look,
    goTo(markerIndex) {
      const mk = opts.markers.find((x) => x.index === markerIndex);
      if (!mk || !world) return;
      const p = planeFromLatLng(opts.bounds, opts.aspect, mk.lat, mk.lng);
      const h = (mk.heading * Math.PI) / 180;
      state = spawn(world, p.x, p.y, h);
      yaw = h;
    },
    setPaused(p) {
      paused = p;
      if (p) keys.clear();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      for (const b of buffers) gl.deleteBuffer(b);
      for (const t of textures) gl.deleteTexture(t);
      for (const v of vaos) gl.deleteVertexArray(v);
      for (const p of programs) gl.deleteProgram(p);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
