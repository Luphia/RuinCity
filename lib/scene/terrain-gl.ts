/**
 * 3D 地景：正射底圖當顏色、高度圖當位移。**沒有任何相依套件**，只用 WebGL。
 *
 * ★ 為什麼不用 three.js：這份程式會跟著每一個場景包上 IPFS（`viewer.js`）。
 *   包裡要能自己活下去 —— 不連 CDN、不依賴某個版本的函式庫還在不在。
 *   幾百行看得懂的 WebGL 比五百 KB 壓縮過的函式庫更適合放進「永久保存」的東西裡。
 *   網站上的 3D 也用這一份（`components/Terrain3D.tsx`），所以兩邊畫出來是同一個樣子。
 *
 * 所有數字都來自呼叫端傳入的渲染規格（`format.ts` 的 `RenderSpec`），這裡沒有預設值。
 *
 * ★ 高度圖用 `createImageBitmap(..., { colorSpaceConversion: "none" })` 解碼：
 *   瀏覽器預設會依色彩描述檔轉換色值，同一張灰階圖在不同螢幕設定下會讀到不同的高度。
 */

import type { RenderSpec } from "./format";

export interface TerrainOptions {
  readonly tileUrl: string;
  readonly dsmUrl: string;
  /** 底圖的 高 ÷ 寬 */
  readonly aspect: number;
  readonly render: RenderSpec;
  readonly onError?: (message: string) => void;
}

export interface TerrainHandle {
  dispose(): void;
}

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

const VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec2 aUv;
uniform mat4 uMvp;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
uniform sampler2D uMap;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform float uHemi;
uniform float uSunI;
out vec4 outColor;
vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toSrgb(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = toLinear(texture(uMap, vUv).rgb);
  vec3 hemi = mix(toLinear(uGround), toLinear(uSky), n.z * 0.5 + 0.5) * uHemi;
  vec3 sun = toLinear(uSun) * max(dot(n, normalize(uSunDir)), 0.0) * uSunI;
  outColor = vec4(toSrgb(albedo * (hemi + sun)), 1.0);
}`;

export function hexToRgb(hex: string): Vec3 {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function perspective(fovDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  // 欄優先（column-major）
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ]);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export async function decode(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return createImageBitmap(await res.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
    imageOrientation: "none",
  });
}

/** 高度圖 → 0..1 的灰階陣列（取 R 通道；灰階圖三個通道相同） */
export function heights(bitmap: ImageBitmap): { data: Float32Array; width: number; height: number } {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const data = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4]! / 255;
  return { data, width: bitmap.width, height: bitmap.height };
}

/** 雙線性取樣；u、t 為 0..1，t = 0 是影像最上面一列（北） */
function sample(h: { data: Float32Array; width: number; height: number }, u: number, t: number): number {
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

/**
 * 網格：x ∈ [-½, ½]（西→東）、y ∈ [-aspect/2, aspect/2]（南→北）、z = 高度 × 位移比例。
 * 法線用中央差分從高度場算出來。
 */
export function buildTerrainMesh(
  h: { data: Float32Array; width: number; height: number },
  aspect: number,
  segments: number,
  scale: number,
): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; indices: Uint32Array } {
  const n = segments + 1;
  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const z = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const t = j / segments; // 0 = 北
    for (let i = 0; i < n; i++) {
      const u = i / segments;
      const k = j * n + i;
      z[k] = sample(h, u, t) * scale;
      positions[k * 3] = u - 0.5;
      positions[k * 3 + 1] = (0.5 - t) * aspect;
      positions[k * 3 + 2] = z[k]!;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = t;
    }
  }
  const dx = 1 / segments;
  const dy = aspect / segments;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const zl = z[j * n + Math.max(0, i - 1)]!;
      const zr = z[j * n + Math.min(segments, i + 1)]!;
      const zn = z[Math.max(0, j - 1) * n + i]!; // 北邊那一列
      const zs = z[Math.min(segments, j + 1) * n + i]!;
      const gx = (zr - zl) / (dx * (Math.min(segments, i + 1) - Math.max(0, i - 1)));
      const gy = (zn - zs) / (dy * (Math.min(segments, j + 1) - Math.max(0, j - 1)));
      const nn = norm([-gx, -gy, 1]);
      normals[k * 3] = nn[0];
      normals[k * 3 + 1] = nn[1];
      normals[k * 3 + 2] = nn[2];
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let p = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // 逆時針（從 +z 往下看）
      indices.set([a, c, b, b, c, d], p);
      p += 6;
    }
  }
  return { positions, normals, uvs, indices };
}

export function mountTerrain(host: HTMLElement, opts: TerrainOptions): TerrainHandle {
  const { render } = opts;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab";
  host.appendChild(canvas);

  let disposed = false;
  const report = (msg: string) => {
    if (!disposed) opts.onError?.(msg);
  };

  const gl = canvas.getContext("webgl2", { antialias: true });
  if (!gl) {
    report("這個瀏覽器不支援 WebGL 2，無法顯示 3D");
    return {
      dispose() {
        disposed = true;
        canvas.remove();
      },
    };
  }

  // ── 相機：繞著目標轉（方位角、仰角、距離） ──
  const target = [...render.camera.target] as Vec3;
  const offset = sub([...render.camera.position] as Vec3, target);
  let distance = Math.hypot(...offset);
  let azimuth = Math.atan2(offset[0], -offset[1]); // 0 = 從南往北看
  let polar = Math.acos(offset[2] / distance); // 與 +z 的夾角
  const clampPolar = (v: number) => Math.min(Math.PI / 2 - 0.02, Math.max(0.05, v));
  polar = clampPolar(polar);

  let dirty = true;
  let raf = 0;
  let program: WebGLProgram | null = null;
  let indexCount = 0;
  const buffers: WebGLBuffer[] = [];
  let texture: WebGLTexture | null = null;
  let vao: WebGLVertexArrayObject | null = null;

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const bg = hexToRgb(render.background);
  const draw = () => {
    raf = requestAnimationFrame(draw);
    if (!dirty || disposed) return;
    dirty = false;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!program || !vao) return;
    const eye: Vec3 = [
      target[0] + distance * Math.sin(polar) * Math.sin(azimuth),
      target[1] - distance * Math.sin(polar) * Math.cos(azimuth),
      target[2] + distance * Math.cos(polar),
    ];
    const proj = perspective(render.camera.fovDeg, canvas.width / canvas.height, render.camera.near, render.camera.far);
    const mvp = multiply(proj, lookAt(eye, target, [0, 0, 1]));
    gl.useProgram(program);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, "uMvp"), false, mvp);
    gl.bindVertexArray(vao);
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
  };
  raf = requestAnimationFrame(draw);

  // ── 操作：拖曳旋轉、滾輪與雙指縮放 ──
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const onDown = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  };
  const onMove = (e: PointerEvent) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      azimuth -= (e.clientX - prev.x) * 0.006;
      polar = clampPolar(polar - (e.clientY - prev.y) * 0.006);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch > 0) zoom(pinch / d);
      pinch = d;
    }
    dirty = true;
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinch = 0;
  };
  const zoom = (factor: number) => {
    distance = Math.min(render.camera.maxDistance, Math.max(render.camera.minDistance, distance * factor));
    dirty = true;
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

  // ── 載入：兩張圖都到了才建網格 ──
  void (async () => {
    let tile: ImageBitmap;
    let dsm: ImageBitmap;
    try {
      [tile, dsm] = await Promise.all([decode(opts.tileUrl), decode(opts.dsmUrl)]);
    } catch {
      report("底圖或高度圖載入失敗");
      return;
    }
    if (disposed) return;
    try {
      const compile = (type: number, src: string) => {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
        return s;
      };
      const prog = gl.createProgram()!;
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");

      const mesh = buildTerrainMesh(heights(dsm), opts.aspect, render.terrain.segments, render.terrain.displacementScale);
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const attrib = (name: string, data: Float32Array, size: number) => {
        const buf = gl.createBuffer()!;
        buffers.push(buf);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      };
      attrib("aPos", mesh.positions, 3);
      attrib("aNormal", mesh.normals, 3);
      attrib("aUv", mesh.uvs, 2);
      const ibuf = gl.createBuffer()!;
      buffers.push(ibuf);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
      indexCount = mesh.indices.length;

      texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tile);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      gl.useProgram(prog);
      const l = render.light;
      gl.uniform1i(gl.getUniformLocation(prog, "uMap"), 0);
      gl.uniform3fv(gl.getUniformLocation(prog, "uSky"), hexToRgb(l.sky));
      gl.uniform3fv(gl.getUniformLocation(prog, "uGround"), hexToRgb(l.ground));
      gl.uniform3fv(gl.getUniformLocation(prog, "uSun"), hexToRgb(l.sun));
      gl.uniform3fv(gl.getUniformLocation(prog, "uSunDir"), [...l.sunDirection]);
      gl.uniform1f(gl.getUniformLocation(prog, "uHemi"), l.hemisphereIntensity);
      gl.uniform1f(gl.getUniformLocation(prog, "uSunI"), l.sunIntensity);
      gl.enable(gl.DEPTH_TEST);
      program = prog;
      dirty = true;
    } catch {
      report("3D 初始化失敗");
    } finally {
      tile.close();
      dsm.close();
    }
  })();

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      for (const b of buffers) gl.deleteBuffer(b);
      if (texture) gl.deleteTexture(texture);
      if (vao) gl.deleteVertexArray(vao);
      if (program) gl.deleteProgram(program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}
