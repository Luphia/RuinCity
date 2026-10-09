"use client";

/**
 * 完成的區塊：終於可以進入了。
 *
 * 正射底圖上標出每一個標記座標，點一個就看那裡的場景圖；
 * 3D 預覽、材質貼圖、勘查筆記、由誰畫了多少，以及決算後的預算書。
 */

import { useState } from "react";

import { markerPosition } from "@/lib/scene/format";
import type { BlockPageData } from "@/lib/server/block-page";

import { ArchivePanel } from "./ArchivePanel";
import { BlockHeader } from "./BlockHeader";
import { BudgetSheet } from "./BudgetSheet";
import { CardTitle, IconImage, IconLayers, glass } from "./hud";
import { Terrain3D } from "./Terrain3D";

export function BlockComplete({ data }: { data: BlockPageData }) {
  const v = data.view;
  const done = v.completed!;
  const art = (kind: string, i: number, size: "full" | "thumb" = "full") =>
    `/api/blocks/${v.key}/art/${kind}/${i}${size === "thumb" ? "?size=thumb" : ""}`;
  const tile = done.artifacts.find((a) => a.kind === "TILE");
  const hasDsm = done.artifacts.some((a) => a.kind === "DSM");
  const scenes = done.artifacts.filter((a) => a.kind === "SCENE");
  const textures = done.artifacts.filter((a) => a.kind === "TEXTURE");
  const [view, setView] = useState<"map" | "3d">("map");
  const [scene, setScene] = useState<number | null>(scenes.length ? 0 : null);

  // 與場景包裡的獨立檢視器用同一個算式
  const pos = (lat: number, lng: number) => {
    const p = markerPosition(v.bounds, lat, lng);
    return { left: `${p.left}%`, top: `${p.top}%` };
  };
  const current = scene === null ? null : done.markers[scene];

  const tab = (on: boolean) =>
    `rounded-full px-3 py-1 text-sm transition ${on ? "bg-white/15 text-white" : "text-white/60 hover:text-white"}`;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:py-8">
      <BlockHeader view={v} subtitle={`${v.label} · 人類離開一千年後 · 共用 ${v.meters.tokensSpent} token、花費 ${v.meters.moneySpent.twd}`} />

      <section className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <div className={`${glass} flex flex-col gap-3 p-3`}>
          <div className="flex items-center justify-between gap-2 px-2 pt-1">
            <div className="flex gap-1 rounded-full border border-white/15 bg-slate-950/40 p-1">
              <button type="button" onClick={() => setView("map")} className={tab(view === "map")} aria-pressed={view === "map"}>
                地圖
              </button>
              {hasDsm && tile ? (
                <button type="button" onClick={() => setView("3d")} className={tab(view === "3d")} aria-pressed={view === "3d"}>
                  3D
                </button>
              ) : null}
            </div>
            <span className="text-xs text-white/50">{view === "map" ? "點標記看那裡的場景" : "拖曳旋轉、滾輪縮放"}</span>
          </div>
          {view === "3d" && tile ? (
            <div className="overflow-hidden rounded-xl">
              <Terrain3D tileUrl={art("TILE", 0)} dsmUrl={art("DSM", 0)} aspect={tile.height / tile.width} render={data.render} />
            </div>
          ) : tile ? (
            <div className="relative w-full overflow-hidden rounded-xl" style={{ aspectRatio: `${tile.width} / ${tile.height}` }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 區塊圖從自己的 API 出，不經 next/image 的最佳化管線 */}
              <img data-testid="tile-image" src={art("TILE", 0)} alt={`${v.shortLabel} 的正射地圖`} className="h-full w-full object-cover" />
              {done.markers.map((m) => (
                <button
                  key={m.index}
                  type="button"
                  title={m.caption ?? `標記 ${m.index + 1}`}
                  aria-label={m.caption ?? `標記 ${m.index + 1}`}
                  onClick={() => setScene(m.index)}
                  className={`absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition ${
                    scene === m.index ? "border-white bg-sky-300 shadow-[0_0_12px_rgba(186,230,253,0.9)]" : "border-white/80 bg-amber-400/90"
                  }`}
                  style={pos(m.lat, m.lng)}
                />
              ))}
            </div>
          ) : (
            <p className="p-3 text-white/60">沒有底圖。</p>
          )}
        </div>

        <div className={`${glass} flex flex-col gap-3 p-3`}>
          {current && scenes.some((s) => s.kindIndex === current.index) ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={art("SCENE", current.index)} alt={current.caption ?? ""} className="w-full rounded-xl" />
              <div className="px-2">
                <p className="text-sm text-white">
                  標記 #{current.index + 1} · 朝向 {Math.round(current.heading)}°
                </p>
                {current.caption ? <p className="text-sm text-white/65">{current.caption}</p> : null}
              </div>
            </>
          ) : (
            <p className="p-2 text-sm text-white/65">這一塊沒有街景可取，只有俯視的地圖、3D 與材質。</p>
          )}
          {done.fieldNote ? (
            <blockquote className="mx-2 border-l-2 border-sky-200/50 pl-3 text-sm leading-relaxed text-white/85">{done.fieldNote}</blockquote>
          ) : null}
          <p className="px-2 pb-1 text-xs text-white/45">
            繪製：{done.credits.map((c) => `${c.provider} ${c.steps} 步`).join("、") || "—"}
          </p>
        </div>
      </section>

      {scenes.length > 1 ? (
        <section className={`${glass} flex flex-col gap-3 p-5`}>
          <CardTitle icon={<IconImage />}>場景圖 · {scenes.length} 張</CardTitle>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-8">
            {scenes.map((s) => (
              <button
                key={s.kindIndex}
                type="button"
                onClick={() => setScene(s.kindIndex)}
                className={`overflow-hidden rounded-lg ring-offset-2 ring-offset-slate-950 transition ${scene === s.kindIndex ? "ring-2 ring-sky-200" : "opacity-80 hover:opacity-100"}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={art("SCENE", s.kindIndex, "thumb")} alt={s.label ?? ""} loading="lazy" className="w-full" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {textures.length ? (
        <section className={`${glass} flex flex-col gap-3 p-5`}>
          <CardTitle icon={<IconLayers />}>材質貼圖</CardTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {textures.map((t) => (
              <figure key={t.kindIndex} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={art("TEXTURE", t.kindIndex, "thumb")} alt={t.label ?? ""} loading="lazy" className="w-full rounded-lg" />
                <figcaption className="text-xs text-white/60">{t.label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      <ArchivePanel archive={data.archive} />

      <BudgetSheet budget={v.budget} total={v.meters.moneyNeeded.twd} />
      {v.surplus && v.surplus.micros > 0 ? (
        <p className="px-1 text-sm text-white/60">結餘 {v.surplus.twd}：保留在這一塊的帳上，作為日後整修或延長保存之用。</p>
      ) : null}
    </main>
  );
}
