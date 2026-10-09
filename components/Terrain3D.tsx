"use client";

/**
 * 3D 地景預覽：正射底圖當顏色、DSM 高度圖當位移。
 *
 * 這就是「3D 圖資」的用法 —— 不是一個網格模型，而是兩張對齊的圖。
 * 高度只是視覺比例（黑＝最低、白＝最高），不是實際公尺數。
 */

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export function Terrain3D({ tileUrl, dsmUrl, aspect }: { tileUrl: string; dsmUrl: string; aspect: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      // 非同步回報：effect 本體裡同步 setState 會造成連鎖重繪
      queueMicrotask(() => setError("這個瀏覽器不支援 WebGL，無法顯示 3D 預覽"));
      return;
    }
    const width = el.clientWidth || 600;
    const height = el.clientHeight || 400;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(width, height);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#141311");
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100);
    camera.position.set(0, -1.1, 0.9);
    camera.up.set(0, 0, 1);

    scene.add(new THREE.HemisphereLight(0xdfe8d0, 0x2a261f, 1.1));
    const sun = new THREE.DirectionalLight(0xfff3dd, 1.4);
    sun.position.set(1, -1, 2);
    scene.add(sun);

    const loader = new THREE.TextureLoader();
    const tile = loader.load(tileUrl, undefined, undefined, () => setError("底圖載入失敗"));
    tile.colorSpace = THREE.SRGBColorSpace;
    const dsm = loader.load(dsmUrl, undefined, undefined, () => setError("高度圖載入失敗"));
    const geometry = new THREE.PlaneGeometry(1, aspect, 255, 255);
    const material = new THREE.MeshStandardMaterial({
      map: tile,
      displacementMap: dsm,
      displacementScale: 0.12,
      roughness: 0.95,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      tile.dispose();
      dsm.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [tileUrl, dsmUrl, aspect]);

  return (
    <div className="relative h-[24rem] w-full overflow-hidden rounded" ref={host}>
      {error ? <p className="text-alarm absolute inset-x-0 top-2 text-center text-sm">{error}</p> : null}
    </div>
  );
}
