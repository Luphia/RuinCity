"use client";

/**
 * 據點的俯視全景 + 疊在上面的點擊區。
 *
 * ★ 圖是**兩幀疊在一起**，用 CSS 交替顯示（`ruin-frame2`）。
 *   每 0.8 秒 setState 一次會讓整個據點畫面重繪，而那只是旗子在飄。
 *
 * ★ 點擊區用 `PLOTS` 換算成百分比疊上去 —— 與畫圖用的是**同一份座標**。
 *   兩份座標遲早分岔，而分岔的症狀是「點了 A 卻升級了 B」。
 *
 * ★ `dangerouslySetInnerHTML` 的輸入是 `citadelSceneSvg()` 自己組出來的
 *   字串，唯一的變數是列舉值與數字，沒有任何使用者輸入會進到那裡。
 */

import {
  CAMPS,
  citadelSceneSvg,
  garrisonGroups,
  PLOTS,
  pct,
  type SceneSlot,
} from "@/lib/game/citadel";
import { slotLabel } from "@/lib/game/sprite";
import type { Unit } from "@/lib/game/balance";

export interface CitadelSceneProps {
  readonly slots: readonly SceneSlot[];
  readonly garrison: Readonly<Partial<Record<Unit, number>>>;
  readonly onPlotClick?: (slot: "A" | "B" | "C" | "D") => void;
  readonly disabledSlots?: ReadonlySet<string>;
}

export function CitadelScene(props: CitadelSceneProps) {
  const input = { slots: props.slots, garrison: props.garrison };
  const f0 = citadelSceneSvg({ ...input, frame: 0 });
  const f1 = citadelSceneSvg({ ...input, frame: 1 });
  const animated = f0 !== f1;
  const groups = garrisonGroups(props.garrison);

  return (
    <div
      data-testid="citadel-scene"
      className="relative aspect-square w-full overflow-hidden rounded border border-[#4a413a] bg-[#1a1614]"
    >
      <div className="absolute inset-0" dangerouslySetInnerHTML={{ __html: f0 }} />
      {animated ? (
        <div
          aria-hidden
          className="ruin-frame2 absolute inset-0"
          dangerouslySetInnerHTML={{ __html: f1 }}
        />
      ) : null}

      {/* ── 建築的點擊區 ───────────────────────────────── */}
      {PLOTS.map((p) => {
        const s = props.slots.find((x) => x.slot === p.slot);
        const disabled = props.disabledSlots?.has(p.slot) ?? false;
        const name = slotLabel(s?.building ?? null);
        return (
          <button
            key={p.slot}
            type="button"
            data-testid={`plot-${p.slot}`}
            disabled={disabled}
            onClick={() => props.onPlotClick?.(p.slot)}
            aria-label={`${p.slot} ${name}${s?.building ? ` Lv${s.level}` : ""}`}
            style={{ left: pct(p.x), top: pct(p.y), width: pct(p.w), height: pct(p.h) }}
            className="absolute flex items-end justify-center rounded-[2px] outline-offset-2 transition-colors hover:bg-[#d9a441]/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d9a441] disabled:hover:bg-transparent"
          >
            {/**
             * ★ 圖上**不放建築名**，只放等級。
             *   一塊地是 3×3 格 = 畫面寬的 6%，在手機上約 23 px ——
             *   「兵營 12」放不下，硬放就變成「兵…」，那比不放更糟。
             *   名字在圖下方的清單裡，而 `aria-label` 讓讀螢幕的人拿到完整資訊。
             */}
            {s?.building ? (
              <span className="pointer-events-none mb-px rounded-[2px] bg-[#1a1614]/80 px-0.5 text-[9px] leading-[1.4] font-bold text-[#e8dcc0] tabular-nums">
                {s.level}
              </span>
            ) : (
              <span className="pointer-events-none mb-px text-[10px] leading-none text-[#d9a441]">
                ＋
              </span>
            )}
          </button>
        );
      })}

      {/* ── 牆外的四支部隊 ─────────────────────────────── */}
      {groups.map((g) => {
        const box = CAMPS[g.group];
        return (
          <div
            key={g.group}
            data-testid={`camp-${g.group}`}
            style={{
              left: pct(box.x),
              // 北面的營區標籤要放在**上方** —— 放下面會壓到北牆
              top: g.group === "ARCHER" ? pct(box.y - 2) : pct(box.y + box.h),
              width: pct(box.w),
            }}
            className="pointer-events-none absolute text-center"
          >
            <span
              className={`rounded-[2px] bg-[#1a1614]/85 px-1 text-[9px] leading-[1.5] ${
                g.total > 0 ? "text-[#e8dcc0]" : "text-[#6b6862]"
              }`}
            >
              {g.label} {g.total.toLocaleString()}
            </span>
          </div>
        );
      })}
    </div>
  );
}
