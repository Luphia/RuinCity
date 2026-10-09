import { describe, expect, it } from "vitest";

import {
  WALK_V1,
  angleDelta,
  compassLabel,
  followCamera,
  groundAt,
  latLngFromPlane,
  metersPerUnit,
  nearestMarker,
  planeFromLatLng,
  spawn,
  stepWalk,
  type HeightField,
  type WalkInput,
  type WalkState,
  type WalkWorld,
} from "./walk";

const bounds = { south: 25.03, north: 25.04, west: 121.56, east: 121.57 };
const m = metersPerUnit(bounds);

/** 平地，中間一根 0.2 單位寬、很高的柱子（一棟樓） */
function world(opts: { tower?: boolean; ramp?: number } = {}): WalkWorld {
  const n = 101;
  const data = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (opts.tower && Math.abs(i - 50) <= 10 && Math.abs(j - 50) <= 10) v = 1;
      if (opts.ramp !== undefined) v = (i / (n - 1)) * opts.ramp;
      data[j * n + i] = v;
    }
  }
  const field: HeightField = { data, width: n, height: n };
  return { field, aspect: 1, displacement: 0.12, metersPerUnit: m, spec: WALK_V1 };
}

function run(w: WalkWorld, s: WalkState, input: Partial<WalkInput>, seconds: number, dt = 1 / 60): WalkState {
  const full: WalkInput = { forward: 0, right: 0, run: false, cameraYaw: 0, ...input };
  for (let t = 0; t < seconds; t += dt) s = stepWalk(w, s, full, dt);
  return s;
}

describe("漫遊：座標", () => {
  it("一個平面單位約等於這一塊的東西寬（臺北約 1 公里）", () => {
    expect(m).toBeGreaterThan(1000);
    expect(m).toBeLessThan(1015);
  });

  it("經緯度 ↔ 平面座標：西南角、東北角、來回換算一致", () => {
    expect(planeFromLatLng(bounds, 1.1, 25.03, 121.56)).toEqual({ x: -0.5, y: -0.55 });
    const ne = planeFromLatLng(bounds, 1.1, 25.04, 121.57);
    expect(ne.x).toBeCloseTo(0.5);
    expect(ne.y).toBeCloseTo(0.55);
    const p = planeFromLatLng(bounds, 1.1, 25.0341, 121.5645);
    const back = latLngFromPlane(bounds, 1.1, p.x, p.y);
    expect(back.lat).toBeCloseTo(25.0341, 9);
    expect(back.lng).toBeCloseTo(121.5645, 9);
  });

  it("地面高度：與地景網格同一個取樣（北在上）", () => {
    const w = world({ ramp: 1 });
    expect(groundAt(w, -0.5, 0)).toBeCloseTo(0);
    expect(groundAt(w, 0.5, 0)).toBeCloseTo(0.12);
    expect(groundAt(w, 0, 0)).toBeCloseTo(0.06);
  });

  it("方位：0 = 北、順時針；最短的轉向", () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(-0.2);
    expect(compassLabel(0)).toBe("北");
    expect(compassLabel(Math.PI / 2)).toBe("東");
    expect(compassLabel(-Math.PI / 4)).toBe("西北");
  });
});

describe("漫遊：移動", () => {
  it("★ 往前走一秒多：朝鏡頭的方向、約走路的速度（含起步加速）", () => {
    const w = world();
    const s = run(w, spawn(w, 0, -0.3, 0), { forward: 1 }, 2);
    const walked = (s.y + 0.3) * m;
    expect(walked).toBeGreaterThan(WALK_V1.walkSpeedMps * 2 * 0.85);
    expect(walked).toBeLessThan(WALK_V1.walkSpeedMps * 2 + 0.01);
    expect(Math.abs(s.x)).toBeLessThan(1e-9);
    expect(s.phase).toBeGreaterThan(1);
  });

  it("跑步比走路快；方向以鏡頭為準，人物轉身朝向移動方向", () => {
    const w = world();
    const walk = run(w, spawn(w, 0, 0, 0), { forward: 1 }, 2);
    const sprint = run(w, spawn(w, 0, 0, 0), { forward: 1, run: true }, 2);
    expect(sprint.y).toBeGreaterThan(walk.y * 2);
    // 鏡頭朝東，往前 = 往東
    const east = run(w, spawn(w, 0, 0, 0), { forward: 1, cameraYaw: Math.PI / 2 }, 1);
    expect(east.x).toBeGreaterThan(0);
    expect(Math.abs(east.y)).toBeLessThan(1e-9);
    expect(east.facing).toBeCloseTo(Math.PI / 2);
  });

  it("★ 樓房是牆：走不進去；斜著撞上會沿牆滑", () => {
    const w = world({ tower: true });
    // 柱子在 x,y ∈ [-0.1, 0.1]；從南邊直直往北走
    const s = run(w, spawn(w, 0, -0.2, 0), { forward: 1, run: true }, 40);
    expect(s.y).toBeLessThan(-0.09);
    expect(s.blocked).toBe("WALL");
    expect(s.z).toBeCloseTo(0);
    // 往東北走：撞牆後沿著南牆往東滑
    const slide = run(w, spawn(w, -0.05, -0.2, 0), { forward: 1, run: true, cameraYaw: Math.PI / 4 }, 40);
    expect(slide.x).toBeGreaterThan(0.1);
  });

  it("緩坡走得上去；停手之後會減速停下", () => {
    const w = world({ ramp: 0.2 }); // 東西 1 公里升 24 公尺
    const s = run(w, spawn(w, -0.3, 0, Math.PI / 2), { forward: 1, cameraYaw: Math.PI / 2 }, 5);
    expect(s.x).toBeGreaterThan(-0.3 + 7 / m);
    expect(s.z).toBeGreaterThan(groundAt(w, -0.3, 0));
    const stopped = run(w, s, {}, 2);
    expect(stopped.speed).toBe(0);
  });

  it("走到區塊邊界就停（相鄰的塊不在這個場景裡）", () => {
    const w = world();
    const s = run(w, spawn(w, 0, 0.49, 0), { forward: 1, run: true }, 3);
    expect(s.blocked).toBe("EDGE");
    expect(s.y).toBeLessThanOrEqual(0.5 - WALK_V1.edgeMarginM / m + 1e-9);
  });
});

describe("漫遊：鏡頭與標記", () => {
  it("★ 越肩鏡頭在人物後上方、偏右；不會鑽進地形", () => {
    const w = world();
    const s = spawn(w, 0, 0, 0);
    const cam = followCamera(w, s, 0, 0.2, 3.4);
    expect(cam.eye[1]).toBeLessThan(s.y); // 在後面（南）
    expect(cam.target[0]).toBeGreaterThan(s.x); // 看向右肩
    expect(cam.eye[2]).toBeGreaterThan(cam.target[2]); // 往下看
    // 往上仰（pitch < 0）時鏡頭會壓到地面以下 → 推回地面上方
    const low = followCamera(w, s, 0, WALK_V1.camera.minPitch, 14);
    expect(low.eye[2]).toBeGreaterThanOrEqual(groundAt(w, low.eye[0], low.eye[1]) + WALK_V1.camera.groundClearanceM / m - 1e-12);
  });

  it("最近的標記座標：距離是公尺、方位 0 = 北", () => {
    const w = world();
    const near = nearestMarker(w, { x: 0, y: 0 }, [
      { index: 3, x: 0, y: 10 / m },
      { index: 7, x: 0.2, y: 0 },
    ]);
    expect(near!.index).toBe(3);
    expect(near!.distanceM).toBeCloseTo(10);
    expect(near!.bearing).toBeCloseTo(0);
    expect(nearestMarker(w, { x: 0, y: 0 }, [])).toBeNull();
  });
});
