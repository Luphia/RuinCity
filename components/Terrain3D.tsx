"use client";

/**
 * 3D 地景預覽：正射底圖當顏色、高度圖當位移。
 *
 * 渲染本體在 `lib/scene/terrain-gl.ts` —— 與場景包裡的獨立檢視器是**同一份程式**，
 * 而且照同一份渲染規格（已發布的區塊用它 `scene.json` 裡的 `render`）。
 * 所以這裡看到的 3D，與任何人從 Boltchain／IPFS 取回整包後看到的一樣。
 */

import { useEffect, useRef, useState } from "react";

import type { RenderSpec } from "@/lib/scene/format";
import { mountTerrain } from "@/lib/scene/terrain-gl";

export function Terrain3D({
  tileUrl,
  dsmUrl,
  aspect,
  render,
}: {
  tileUrl: string;
  dsmUrl: string;
  aspect: number;
  render: RenderSpec;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // 規格是物件：用字串當依賴，免得每次 render 的新物件讓 effect 重跑（CLAUDE.md「useEffect 依賴」）
  const renderKey = JSON.stringify(render);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const handle = mountTerrain(el, {
      tileUrl,
      dsmUrl,
      aspect,
      render: JSON.parse(renderKey) as RenderSpec,
      onError: (msg) => setError(msg),
    });
    return () => handle.dispose();
  }, [tileUrl, dsmUrl, aspect, renderKey]);

  return (
    <div className="relative h-[24rem] w-full overflow-hidden rounded" ref={host}>
      {error ? <p className="text-rose-200 absolute inset-x-0 top-2 text-center text-sm">{error}</p> : null}
    </div>
  );
}
