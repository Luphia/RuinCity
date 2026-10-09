/**
 * 開場畫面的 HUD：疊在背景上的毛玻璃卡片。
 *
 * 版面語彙取自「機窗外的景色 + 半透明儀表」：細框、半透明、大數字、細線圖示、
 * 一條路線（這裡是象山 → 臺北 101）、一個進度、一條時間軸。
 * **每一個數字都是真的**：座標與距離由 `grid.ts` 算、世界進度由資料庫來 —— 不放裝飾用的假數據。
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { TAIPEI_101, blockBounds, blockKey, blockOf, haversineM, type LatLng } from "@/lib/world/grid";
import { XIANGSHAN_VIEWPOINT, splashViewpoint } from "@/lib/world/prompts";

export interface SplashHudData {
  readonly stats: {
    readonly completed: number;
    readonly underway: number;
    readonly raised: string;
    readonly donors: number;
    readonly archived: number;
  } | null;
  readonly origin: {
    readonly statusLabel: string;
    readonly complete: boolean;
    readonly progress: number;
    readonly received: string;
    readonly needed: string;
  } | null;
}

const glass =
  "rounded-2xl border border-white/15 bg-white/[0.07] shadow-[0_8px_32px_rgba(0,0,0,0.28)] backdrop-blur-md";
const label = "text-[11px] uppercase tracking-[0.22em] text-white/60";

// ─────────────────────────────────────────────────────────────
// 細線圖示（24×24，currentColor）
// ─────────────────────────────────────────────────────────────

function Icon({ children, className = "h-5 w-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {children}
    </svg>
  );
}
const IconMountain = () => (
  <Icon>
    <path d="M3 19 9.5 8l4 6.5L16 11l5 8Z" />
    <path d="m8 10.5 1.5 1.5 1.5-1.2" />
  </Icon>
);
const IconCheckGrid = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M3.5 12h17M12 3.5v17" />
    <path d="m14 16 1.6 1.6L19 14" />
  </Icon>
);
const IconCrane = () => (
  <Icon>
    <path d="M6 21V4h1.5L20 7.5M6 7.5h14M17 7.5V12" />
    <rect x="15.5" y="12" width="3" height="2.5" />
    <path d="M3.5 21h6" />
  </Icon>
);
const IconCoin = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M14.6 9.2c-.5-.8-1.5-1.2-2.6-1.2-1.6 0-2.7.8-2.7 1.9 0 2.6 5.6 1.3 5.6 4 0 1.1-1.2 2-2.9 2-1.2 0-2.3-.5-2.8-1.3M12 6.5V8m0 8v1.5" />
  </Icon>
);
const IconArchive = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="4.5" rx="1" />
    <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5M10 12.5h4" />
  </Icon>
);
const IconMist = ({ className }: { className?: string }) => (
  <Icon className={className}>
    <path d="M7 14a4 4 0 0 1 .5-8 5 5 0 0 1 9.6 1.5A3.3 3.3 0 0 1 17 14Z" />
    <path d="M4 17.5h11M7 20.5h12" />
  </Icon>
);
const IconLeaf = () => (
  <Icon className="h-4 w-4">
    <path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z" />
    <path d="M5 19 13 11" />
  </Icon>
);
const IconDrop = () => (
  <Icon className="h-4 w-4">
    <path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z" />
  </Icon>
);
const IconNoPeople = () => (
  <Icon className="h-4 w-4">
    <circle cx="12" cy="7.5" r="3" />
    <path d="M6 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5M4 4l16 16" />
  </Icon>
);
const IconPin = () => (
  <Icon className="h-4 w-4">
    <path d="M12 21s6.5-6.1 6.5-11.2A6.5 6.5 0 0 0 5.5 9.8C5.5 14.9 12 21 12 21Z" />
    <circle cx="12" cy="9.8" r="2.3" />
  </Icon>
);
const IconArrowRight = ({ className = "h-5 w-5" }: { className?: string }) => (
  <Icon className={className}>
    <path d="M4 12h15M14 6.5 19.5 12 14 17.5" />
  </Icon>
);

// ─────────────────────────────────────────────────────────────
// 卡片
// ─────────────────────────────────────────────────────────────

const fmtCoord = (p: LatLng) => `N${p.lat.toFixed(4)}° E${p.lng.toFixed(4)}°`;

function JourneyCard({ distanceKm, heading }: { distanceKm: string; heading: number }) {
  return (
    <section className={`${glass} p-5`} aria-labelledby="splash-title">
      <div className={`${label} flex items-center gap-2`}>
        <IconMountain />
        <h1 id="splash-title" className="text-[11px] font-normal">
          RuinCity · 千年之後
        </h1>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <div className="text-3xl font-semibold tracking-wide text-white sm:text-4xl">象山</div>
          <div className="text-sm text-white/70">Elephant Mountain</div>
        </div>
        <div className="mb-3 flex flex-1 items-center gap-1 text-sky-200/90" aria-hidden>
          <span className="h-px flex-1 bg-gradient-to-r from-transparent to-sky-200/70" />
          <IconArrowRight />
          <span className="h-px flex-1 bg-gradient-to-r from-sky-200/70 to-transparent" />
        </div>
        <div className="text-right">
          <div className="text-3xl font-semibold tracking-wide text-white sm:text-4xl">101</div>
          <div className="text-sm text-white/70">臺北 101</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-3 border-t border-white/15 pt-3 text-sm">
        <div>
          <div className="text-xs text-white/60">海拔</div>
          <div className="text-white">183 m</div>
        </div>
        <div className="border-l border-white/15 pl-3">
          <div className="text-xs text-white/60">距離</div>
          <div className="text-white">{distanceKm} km</div>
        </div>
        <div className="border-l border-white/15 pl-3">
          <div className="text-xs text-white/60">方位</div>
          <div className="text-white">西北 {heading}°</div>
        </div>
      </div>
    </section>
  );
}

function StatTile({ icon, title, value }: { icon: ReactNode; title: string; value: string }) {
  return (
    <div className={`${glass} flex items-center gap-3 px-3.5 py-3`}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/20 text-sky-100">{icon}</span>
      <div className="min-w-0">
        <div className="text-xs text-white/60">{title}</div>
        <div className="truncate text-base text-white">{value}</div>
      </div>
    </div>
  );
}

/**
 * 路線圖：象山 → 101，底下是真的 0.01° 網格（4 × 3 塊），101 所在那一塊標出來。
 * 不是地圖圖磚 —— 只有網格、兩個點與一條虛線，全部由座標算出。
 */
function RouteMap({ originLabel }: { originLabel: string }) {
  const W = 0.04;
  const H = 0.03;
  const west = 121.55;
  const north = 25.05;
  const vw = 363;
  const vh = 300;
  const px = (p: LatLng) => ({ x: ((p.lng - west) / W) * vw, y: ((north - p.lat) / H) * vh });
  const a = px(XIANGSHAN_VIEWPOINT);
  const b = px(TAIPEI_101);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const o = blockOf(TAIPEI_101);
  const ob = blockBounds(o);
  const { x: ox, y: oy } = px({ lat: ob.north, lng: ob.west });
  return (
    <section className={`${glass} overflow-hidden p-3`}>
      <svg viewBox={`0 0 ${vw} ${vh}`} className="block h-auto w-full" role="img" aria-label="從象山到臺北 101 的路線，疊在 0.01° 網格上">
        <defs>
          <radialGradient id="hud-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#bae6fd" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#bae6fd" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width={vw} height={vh} fill="rgba(8,14,24,0.35)" />
        {[1, 2, 3].map((i) => (
          <line key={`v${i}`} x1={(vw / 4) * i} y1={0} x2={(vw / 4) * i} y2={vh} stroke="rgba(255,255,255,0.12)" />
        ))}
        {[1, 2].map((i) => (
          <line key={`h${i}`} x1={0} y1={(vh / 3) * i} x2={vw} y2={(vh / 3) * i} stroke="rgba(255,255,255,0.12)" />
        ))}
        <rect x={ox} y={oy} width={vw / 4} height={vh / 3} fill="rgba(186,230,253,0.08)" stroke="rgba(186,230,253,0.55)" strokeDasharray="3 3" />
        <text x={ox + 6} y={oy + 14} fill="rgba(255,255,255,0.65)" fontSize="10" letterSpacing="1">
          {blockKey(o)} · {originLabel}
        </text>
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#bae6fd" strokeWidth="1.6" strokeDasharray="5 5" />
        <g transform={`translate(${mid.x} ${mid.y}) rotate(${angle})`}>
          <path d="M-7 -6 5 0-7 6-3.5 0Z" fill="#e0f2fe" />
        </g>
        {/* 路線往右下走：101 的標籤放左上、象山的放右邊，都不壓到虛線 */}
        {[
          { p: a, name: "象山", sub: "183 m", dx: 10, anchor: "start" as const },
          { p: b, name: "臺北 101", sub: "508 m", dx: -10, anchor: "end" as const },
        ].map(({ p, name, sub, dx, anchor }) => (
          <g key={name}>
            <circle cx={p.x} cy={p.y} r="16" fill="url(#hud-glow)" />
            <circle cx={p.x} cy={p.y} r="4.5" fill="#fbbf24" stroke="#fff7e6" strokeWidth="1.5" />
            <text x={p.x + dx} y={p.y - 4} fill="#fff" fontSize="13" fontWeight="600" textAnchor={anchor}>
              {name}
            </text>
            <text x={p.x + dx} y={p.y + 10} fill="rgba(255,255,255,0.65)" fontSize="10" textAnchor={anchor}>
              {sub}
            </text>
          </g>
        ))}
        <text x={vw - 8} y={vh - 8} fill="rgba(255,255,255,0.45)" fontSize="9" textAnchor="end">
          0.01° × 0.01° 網格
        </text>
      </svg>
    </section>
  );
}

/** 這裡現在的樣子 —— 世界正典（`bible.ts`），不是氣象資料 */
function ConditionsCard() {
  return (
    <section className={`${glass} flex items-center gap-4 p-5`}>
      <IconMist className="h-12 w-12 shrink-0 text-sky-100" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white/70">臺北 · 一千年後</div>
        <div className="text-3xl font-semibold text-white">晨霧</div>
        <div className="text-sm text-sky-100/80">陰天，霧貼著谷底</div>
      </div>
      <ul className="space-y-2 border-l border-white/15 pl-4 text-sm text-white/85">
        <li className="flex items-center gap-2">
          <IconLeaf /> 森林覆城
        </li>
        <li className="flex items-center gap-2">
          <IconDrop /> 低地成澤
        </li>
        <li className="flex items-center gap-2">
          <IconNoPeople /> 無人
        </li>
      </ul>
    </section>
  );
}

function NextStopCard({ origin }: { origin: SplashHudData["origin"] }) {
  const key = blockKey(blockOf(TAIPEI_101));
  const pct = origin ? Math.round(origin.progress * 1000) / 10 : 0;
  return (
    <section className={`${glass} p-5`}>
      <div className={`${label} flex items-center gap-2`}>
        <IconPin /> 下一站
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">臺北 101</div>
      <div className="text-sm text-white/70">
        {origin
          ? origin.complete
            ? "這一塊已經完成，可以進入"
            : `${origin.statusLabel} · 已募得 ${origin.received}／需要 ${origin.needed}`
          : "城市的第一塊，從這裡開始"}
      </div>
      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/15" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="臺北 101 這一塊的募款進度">
        <div className="h-full rounded-full bg-gradient-to-r from-sky-300 to-sky-100" style={{ width: `${origin?.complete ? 100 : pct}%` }} />
      </div>
      <Link href={`/b/${key}`} className="mt-3 inline-flex items-center gap-1 text-sm text-sky-100 underline-offset-4 hover:underline">
        看這一塊 <IconArrowRight className="h-4 w-4" />
      </Link>
    </section>
  );
}

/** 時間軸：象山 ——（進入城市）—— 臺北 101 */
function Timeline() {
  return (
    <section className={`${glass} px-5 py-4`}>
      <div className="flex items-center gap-3">
        <span className="h-4 w-4 shrink-0 rounded-full border-2 border-white/80 bg-white/20" aria-hidden />
        <span className="h-px flex-1 bg-white/35" aria-hidden />
        <Link
          href="/world"
          data-testid="enter-city"
          className="inline-flex shrink-0 items-center gap-2 rounded-full border border-white/40 bg-gradient-to-r from-sky-300/90 to-sky-100/90 px-6 py-3 text-base font-semibold tracking-wide text-slate-900 shadow-[0_0_24px_rgba(186,230,253,0.45)] transition hover:from-white hover:to-white"
        >
          進入城市 <IconArrowRight className="h-5 w-5" />
        </Link>
        <span className="h-px flex-1 bg-white/35" aria-hidden />
        <span className="h-4 w-4 shrink-0 rounded-full border-2 border-white/80 bg-white/20" aria-hidden />
      </div>
      <div className="mt-2 flex justify-between text-xs text-white/70">
        <div>
          <div className="text-sm text-white">象山</div>
          {fmtCoord(XIANGSHAN_VIEWPOINT)}
        </div>
        <div className="text-right">
          <div className="text-sm text-white">臺北 101</div>
          {fmtCoord(TAIPEI_101)}
        </div>
      </div>
    </section>
  );
}

export function SplashHud({ data }: { data: SplashHudData }) {
  const v = splashViewpoint();
  const distanceKm = (haversineM(XIANGSHAN_VIEWPOINT, TAIPEI_101) / 1000).toFixed(1);
  const s = data.stats;
  const n = (x: number | undefined) => (x === undefined ? "—" : x.toLocaleString("en-US"));
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-4 pb-36 pt-5 sm:pt-8 md:pb-8">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <JourneyCard distanceKm={distanceKm} heading={v.heading} />
          <div className="grid grid-cols-2 gap-3">
            <StatTile icon={<IconCheckGrid />} title="已完成" value={`${n(s?.completed)} 塊`} />
            <StatTile icon={<IconCrane />} title="建設中" value={`${n(s?.underway)} 塊`} />
            <StatTile icon={<IconCoin />} title={`已募得 · ${n(s?.donors)} 人`} value={s?.raised ?? "—"} />
            <StatTile icon={<IconArchive />} title="永久保存" value={`${n(s?.archived)} 包`} />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <RouteMap originLabel={data.origin?.statusLabel ?? "尚無捐款"} />
          <ConditionsCard />
        </div>
      </div>
      {/* 中間留白：讓背景（象山望出去的那一片）透出來 */}
      <div className="min-h-8 flex-1" aria-hidden />
      <div className="grid gap-4 md:grid-cols-[5fr_7fr]">
        <NextStopCard origin={data.origin} />
        {/* 手機上整頁很長：時間軸（含「進入城市」）固定在畫面底部，隨時按得到；寬螢幕回到版面裡 */}
        <div className="fixed inset-x-3 bottom-3 z-20 flex flex-col justify-end md:static">
          <Timeline />
        </div>
      </div>
    </div>
  );
}
