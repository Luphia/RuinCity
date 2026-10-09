/**
 * 區塊頁的抬頭卡：哪一塊、現在的狀態、在哪裡。施工中與完成後共用。
 */

import Link from "next/link";
import type { ReactNode } from "react";

import type { BlockView } from "@/lib/server/view";

import { IconArrowLeft, IconPin, glass, label } from "./hud";

export function StatusBadge({ status, label: text }: { status: string; label: string }) {
  const tone =
    status === "COMPLETE"
      ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-200"
      : status === "BUILDING"
        ? "border-amber-300/40 bg-amber-400/15 text-amber-200"
        : status === "PAUSED"
          ? "border-rose-300/40 bg-rose-400/15 text-rose-200"
          : "border-white/20 bg-white/[0.06] text-white/75";
  return (
    <span data-testid="status" className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      {text}
    </span>
  );
}

export function BlockHeader({ view: v, subtitle, children }: { view: BlockView; subtitle: ReactNode; children?: ReactNode }) {
  return (
    <header className={`${glass} flex flex-col gap-3 p-5`}>
      <div className="flex items-center justify-between gap-3">
        <div className={`${label} flex items-center gap-2`}>
          <IconPin /> 區塊 {v.key}
        </div>
        <Link href="/world" className="inline-flex items-center gap-1 text-xs text-white/60 transition hover:text-white">
          <IconArrowLeft className="h-3.5 w-3.5" /> 世界地圖
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-3xl font-semibold tracking-wide text-white sm:text-4xl">{v.shortLabel}</h1>
        <StatusBadge status={v.status} label={v.statusLabel} />
        {v.isOrigin ? (
          <span className="rounded-full border border-sky-200/40 bg-sky-300/10 px-2.5 py-0.5 text-xs text-sky-100">原點 · 臺北 101</span>
        ) : null}
      </div>
      <p className="text-sm text-white/65">{subtitle}</p>
      {children}
    </header>
  );
}
