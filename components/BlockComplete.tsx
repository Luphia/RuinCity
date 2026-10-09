"use client";

/**
 * 完成的區塊：終於可以進入了。
 *
 * 正射底圖上標出每一個標記座標，點一個就看那裡的場景圖；
 * 3D 預覽、材質貼圖、勘查筆記、由誰畫了多少，以及決算後的預算書。
 */

import Link from "next/link";
import { useState } from "react";

import { markerPosition } from "@/lib/scene/format";
import type { BlockPageData } from "@/lib/server/block-page";

import { ArchivePanel } from "./ArchivePanel";
import { StatusBadge } from "./BlockLive";
import { BudgetSheet } from "./BudgetSheet";
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

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">{v.shortLabel}</h1>
          <StatusBadge status={v.status} label={v.statusLabel} />
          {v.isOrigin ? <span className="text-moss text-xs">原點 · 臺北 101</span> : null}
        </div>
        <p className="text-ash text-sm">
          {v.label} · 人類離開一千年後 · 共用 {v.meters.tokensSpent} token、花費 {v.meters.moneySpent.twd}
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2 text-sm">
            <button type="button" onClick={() => setView("map")} className={view === "map" ? "text-moss font-bold" : "text-ash"}>
              地圖
            </button>
            {hasDsm && tile ? (
              <button type="button" onClick={() => setView("3d")} className={view === "3d" ? "text-moss font-bold" : "text-ash"}>
                3D
              </button>
            ) : null}
          </div>
          {view === "3d" && tile ? (
            <Terrain3D tileUrl={art("TILE", 0)} dsmUrl={art("DSM", 0)} aspect={tile.height / tile.width} render={data.render} />
          ) : tile ? (
            <div className="relative w-full" style={{ aspectRatio: `${tile.width} / ${tile.height}` }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 區塊圖從自己的 API 出，不經 next/image 的最佳化管線 */}
              <img data-testid="tile-image" src={art("TILE", 0)} alt={`${v.shortLabel} 的正射地圖`} className="h-full w-full rounded object-cover" />
              {done.markers.map((m) => (
                <button
                  key={m.index}
                  type="button"
                  title={m.caption ?? `標記 ${m.index + 1}`}
                  onClick={() => setScene(m.index)}
                  className={`absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border ${scene === m.index ? "bg-rust border-parchment" : "bg-ink/70 border-rust"}`}
                  style={pos(m.lat, m.lng)}
                />
              ))}
            </div>
          ) : (
            <p className="text-ash">沒有底圖。</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {current && scenes.some((s) => s.kindIndex === current.index) ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={art("SCENE", current.index)} alt={current.caption ?? ""} className="w-full rounded" />
              <p className="text-sm">
                標記 #{current.index + 1} · 朝向 {Math.round(current.heading)}°
              </p>
              {current.caption ? <p className="text-ash text-sm">{current.caption}</p> : null}
            </>
          ) : (
            <p className="text-ash text-sm">這一塊沒有街景可取，只有俯視的地圖、3D 與材質。</p>
          )}
          {done.fieldNote ? (
            <blockquote className="border-moss text-parchment mt-2 border-l-2 pl-3 text-sm leading-relaxed">{done.fieldNote}</blockquote>
          ) : null}
          <p className="text-ash-deep text-xs">
            繪製：{done.credits.map((c) => `${c.provider} ${c.steps} 步`).join("、") || "—"}
          </p>
        </div>
      </section>

      {scenes.length > 1 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">場景圖 · {scenes.length} 張</h2>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-8">
            {scenes.map((s) => (
              <button key={s.kindIndex} type="button" onClick={() => setScene(s.kindIndex)} className={scene === s.kindIndex ? "ring-rust rounded ring-2" : ""}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={art("SCENE", s.kindIndex, "thumb")} alt={s.label ?? ""} loading="lazy" className="w-full rounded" />
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {textures.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-lg font-bold">材質貼圖</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {textures.map((t) => (
              <figure key={t.kindIndex} className="flex flex-col gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={art("TEXTURE", t.kindIndex, "thumb")} alt={t.label ?? ""} loading="lazy" className="w-full rounded" />
                <figcaption className="text-ash text-xs">{t.label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      <ArchivePanel archive={data.archive} />

      <BudgetSheet budget={v.budget} total={v.meters.moneyNeeded.twd} />
      {v.surplus && v.surplus.micros > 0 ? (
        <p className="text-ash text-sm">結餘 {v.surplus.twd}：保留在這一塊的帳上，作為日後整修或延長保存之用。</p>
      ) : null}

      <p className="text-ash-deep text-xs">
        <Link href="/" className="underline">
          ← 回到世界地圖
        </Link>
      </p>
    </main>
  );
}
