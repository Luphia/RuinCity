/**
 * 毛玻璃 HUD 的共用元件：卡片樣式與細線圖示。開場畫面（`SplashHud`）與世界地圖（`WorldMap`）共用，
 * 兩邊看起來才是同一套儀表。
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
