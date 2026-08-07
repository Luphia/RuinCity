"use client";

/**
 * 2×2 核心裡的一格。`docs/09` §6：「2×2 核心放大顯示，四格可直接點擊升級」。
 *
 * ★ 圖是**兩幀疊在一起**，用 CSS 交替顯示。
 *   `docs/09` §2 說閒置動畫 2 幀、0.8s/幀，而用 React state 每 0.8 秒
 *   setState 一次會讓整個據點畫面重繪 —— 一個煙囪冒煙不該付那個代價。
 *   兩張 SVG 疊著、用 `steps()` 切換 opacity，動畫完全在合成層跑。
 *
 * ★ `dangerouslySetInnerHTML` 的輸入是 `slotSvg()` 自己組出來的字串，
 *   唯一的變數是列舉值與數字，沒有任何使用者輸入會進到那裡。
 */

import { slotSvg, type SlotBuilding } from "@/lib/game/sprite";

export interface CoreTileProps {
  readonly building: SlotBuilding | null;
  readonly level: number;
  /** 建造／升級中 —— 疊鷹架 */
  readonly busy: boolean;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly label: string;
  /** A / B / C / D */
  readonly slot: string;
}

export function CoreTile(props: CoreTileProps) {
  const art = { building: props.building, level: props.level, building_: props.busy };
  const f0 = slotSvg({ ...art, frame: 0 }, 4);
  const f1 = slotSvg({ ...art, frame: 1 }, 4);
  const animated = f0 !== f1;

  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      data-testid={`core-tile-${props.slot}`}
      className="group relative block aspect-square w-full overflow-hidden rounded border border-[#4a413a] bg-[#1a1614] disabled:cursor-default"
    >
      {/* ★ image-rendering: pixelated —— 整數倍放大不糊（docs/09 §2） */}
      <span
        aria-hidden
        className="absolute inset-0 [image-rendering:pixelated] [&>svg]:size-full"
        dangerouslySetInnerHTML={{ __html: f0 }}
      />
      {animated ? (
        <span
          aria-hidden
          className="ruin-frame2 absolute inset-0 [image-rendering:pixelated] [&>svg]:size-full"
          dangerouslySetInnerHTML={{ __html: f1 }}
        />
      ) : null}

      <span className="absolute left-1 top-1 rounded bg-[#1a1614]/70 px-1 font-mono text-[10px] text-[#e8dcc0]/70">
        {props.slot}
      </span>
      <span className="absolute inset-x-0 bottom-0 flex items-baseline justify-between bg-[#1a1614]/75 px-1.5 py-0.5 text-[11px] text-[#e8dcc0]">
        <span>{props.label}</span>
        <span className="tabular-nums opacity-80">
          {props.building ? `Lv${props.level}` : ""}
        </span>
      </span>

      {props.busy ? (
        <span className="absolute right-1 top-1 rounded bg-[#d9a441] px-1 text-[10px] font-bold text-[#1a1614]">
          施工
        </span>
      ) : null}
    </button>
  );
}
