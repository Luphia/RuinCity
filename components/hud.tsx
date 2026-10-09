/**
 * 毛玻璃 HUD 的共用元件：卡片樣式、按鈕、欄位與細線圖示。
 * 開場畫面、世界地圖、區塊頁與其餘頁面全部用這一套，看起來才是同一套儀表。
 *
 * 顏色語彙：天藍 = 主要動作與原點、琥珀 = 施工中（需要捐款）、翠綠 = 已完成（可以進入）、玫瑰 = 錯誤與暫停。
 */

import type { ReactNode } from "react";

export const glass =
  "rounded-2xl border border-white/15 bg-white/[0.07] shadow-[0_8px_32px_rgba(0,0,0,0.28)] backdrop-blur-md";
/**
 * 地圖上用的深色玻璃：底圖可能是亮的（OpenFreeMap），7% 白的玻璃配白字會看不清，
 * 所以這一款先壓一層深色再模糊。
 */
export const glassDark =
  "rounded-2xl border border-white/15 bg-slate-950/60 shadow-[0_8px_32px_rgba(0,0,0,0.35)] backdrop-blur-md";
export const label = "text-[11px] uppercase tracking-[0.22em] text-white/60";

/** 主要動作：與「進入城市」同一顆天藍漸層膠囊 */
export const cta =
  "inline-flex items-center justify-center gap-2 rounded-full border border-white/40 bg-gradient-to-r from-sky-300/90 to-sky-100/90 px-5 py-2.5 font-semibold tracking-wide text-slate-900 shadow-[0_0_24px_rgba(186,230,253,0.35)] transition hover:from-white hover:to-white disabled:cursor-not-allowed disabled:opacity-50";
/** 次要動作：透明膠囊 */
export const ghost =
  "inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-white/[0.04] px-4 py-2 text-white/85 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50";
/** 輸入欄位 */
export const field =
  "rounded-xl border border-white/15 bg-slate-950/40 px-3 py-2 text-white outline-none placeholder:text-white/35 focus:border-sky-200/60";
/** 文字連結 */
export const link = "text-sky-200 underline-offset-4 hover:underline";
/** 錯誤訊息 */
export const alarm = "rounded-xl border border-rose-300/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200";

/** 卡片標題列：細線圖示 + 小標 + 右側說明 */
export function CardTitle({ icon, children, aside }: { icon?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className={`${label} flex items-center gap-2`}>
        {icon}
        {children}
      </h2>
      {aside ? <span className="text-xs text-white/50">{aside}</span> : null}
    </div>
  );
}

/** 進度條：0–1；tone 決定顏色 */
export function Meter({ value, tone = "sky", label: aria }: { value: number; tone?: "sky" | "amber" | "emerald"; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 1000) / 10));
  const fill = { sky: "from-sky-300 to-sky-100", amber: "from-amber-400 to-amber-200", emerald: "from-emerald-400 to-emerald-200" }[tone];
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={aria}>
      <div className={`h-full rounded-full bg-gradient-to-r ${fill}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 細線圖示（24×24，currentColor）
// ─────────────────────────────────────────────────────────────

export function Icon({ children, className = "h-5 w-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {children}
    </svg>
  );
}
export const IconMountain = () => (
  <Icon>
    <path d="M3 19 9.5 8l4 6.5L16 11l5 8Z" />
    <path d="m8 10.5 1.5 1.5 1.5-1.2" />
  </Icon>
);
export const IconCheckGrid = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M3.5 12h17M12 3.5v17" />
    <path d="m14 16 1.6 1.6L19 14" />
  </Icon>
);
export const IconCrane = () => (
  <Icon>
    <path d="M6 21V4h1.5L20 7.5M6 7.5h14M17 7.5V12" />
    <rect x="15.5" y="12" width="3" height="2.5" />
    <path d="M3.5 21h6" />
  </Icon>
);
export const IconCoin = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M14.6 9.2c-.5-.8-1.5-1.2-2.6-1.2-1.6 0-2.7.8-2.7 1.9 0 2.6 5.6 1.3 5.6 4 0 1.1-1.2 2-2.9 2-1.2 0-2.3-.5-2.8-1.3M12 6.5V8m0 8v1.5" />
  </Icon>
);
export const IconArchive = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="4.5" rx="1" />
    <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4" />
  </Icon>
);
export const IconMist = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M7 14a4 4 0 0 1 .5-8 5 5 0 0 1 9.6 1.5A3.3 3.3 0 0 1 17 14Z" />
    <path d="M4 17.5h11M7 20.5h12" />
  </Icon>
);
export const IconLeaf = () => (
  <Icon className="h-4 w-4">
    <path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z" />
    <path d="M5 19 13 11" />
  </Icon>
);
export const IconDrop = () => (
  <Icon className="h-4 w-4">
    <path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z" />
  </Icon>
);
export const IconNoPeople = () => (
  <Icon className="h-4 w-4">
    <circle cx="12" cy="7.5" r="3" />
    <path d="M6 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5M4 4l16 16" />
  </Icon>
);
export const IconPin = () => (
  <Icon className="h-4 w-4">
    <path d="M12 21s6.5-6.1 6.5-11.2A6.5 6.5 0 0 0 5.5 9.8C5.5 14.9 12 21 12 21Z" />
    <circle cx="12" cy="9.8" r="2.3" />
  </Icon>
);
export const IconArrowRight = ({ className = "h-5 w-5" }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 12h15M14 6.5 19.5 12 14 17.5" />
  </Icon>
);

export const IconSearch = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);
export const IconCrosshair = ({ className = "h-5 w-5" }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
  </Icon>
);
export const IconClose = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);
export const IconLock = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2" />
  </Icon>
);
export const IconChip = ({ className = "h-5 w-5" }: { className?: string }) => (
  <Icon className={className}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
    <path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21" />
  </Icon>
);
export const IconBallot = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 13.5h16v6.5H4z" />
    <path d="m8.5 9.5 2.5 2.5 5-5.5" />
    <path d="M7 13.5V4h10v9.5" />
  </Icon>
);
export const IconHeart = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <path d="M12 20s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.6-7.5 10-7.5 10Z" />
  </Icon>
);
export const IconLedger = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <rect x="5" y="3.5" width="14" height="17" rx="1.5" />
    <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
  </Icon>
);
export const IconLog = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);
export const IconLayers = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <path d="m12 4 8.5 4.5L12 13 3.5 8.5Z" />
    <path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
  </Icon>
);
export const IconImage = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17.5 5-4.5 3.5 3 3-2.5 4.5 4" />
  </Icon>
);
export const IconArrowLeft = ({ className = "h-4 w-4" }: { className?: string }) => (
  <Icon className={className}>
    <path d="M20 12H5M10 6.5 4.5 12l5.5 5.5" />
  </Icon>
);
