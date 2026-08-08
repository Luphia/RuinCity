"use client";

import Link from "next/link";

/**
 * 常駐 HUD：資源 + 速率 + 儲存量、季節、下一件會完成的事。
 * `docs/09` §5.1 從 M0 就規劃了這條 40px 的常駐狀態列，M5c 才補上。
 *
 * ★ 數字是**外推**的：伺服器快照 + 速率 × 經過時間（`lib/game/hud.ts`），
 *   只供顯示。每 60 秒向伺服器對一次帳；對不上的那一刻以伺服器為準。
 *
 * ★ 「下一件會完成的事」是玩家抬頭要看的那個數字 ——
 *   它回答「我什麼時候要回來」。全部閒置時不顯示，
 *   閒置本身就是執政官該接手的訊號。
 */

import { useEffect, useState } from "react";

import { loadHud, type HudState } from "@/app/actions/hud";
import { extrapolate, formatCountdown } from "@/lib/game/hud";
import type { Season } from "@/lib/game/balance";
import type { Amounts } from "@/lib/game/settle";
import { useServerClock } from "@/components/use-server-clock";

const RESOURCE_LABEL: Record<keyof Amounts, string> = {
  grain: "糧",
  timber: "木",
  stone: "石",
  iron: "鐵",
};

/** 四季的色票（docs/09 §3）：荒芽綠、焦土鏽、豐鏽金、長夜藍 */
const SEASON_COLOR: Record<Season, string> = {
  SPRING: "#6b7f4a",
  SUMMER: "#a35a3a",
  AUTUMN: "#d9a441",
  WINTER: "#4a8fa8",
};
const SEASON_ORDER: readonly Season[] = ["SPRING", "SUMMER", "AUTUMN", "WINTER"];

export function GameHud({ floating = false }: { floating?: boolean }) {
  const [hud, setHud] = useState<HudState | null>(null);
  const [syncFailed, setSyncFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const next = await loadHud();
        if (cancelled) return;
        setHud(next);
        setSyncFailed(false);
      } catch {
        // ★ 失敗要看得見（CLAUDE.md）：留著舊數字，但標出「這是舊的」
        if (!cancelled) setSyncFailed(true);
      }
    };
    void pull();
    const id = setInterval(() => void pull(), 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const now = useServerClock(hud?.serverTime ?? 0);
  if (!hud) return null;

  const elapsed = Math.max(0, now - hud.serverTime);

  return (
    <div
      data-testid="game-hud"
      className={`${
        floating
          ? // 浮在地圖上：HUD 沒有可點的東西，不能擋住底下的拖曳手勢
            "pointer-events-none absolute inset-x-0 top-0 z-20"
          : "sticky top-0 z-20"
      } border-b border-[#4a413a] bg-[#1a1614]/95 text-[#e8dcc0]`}
    >
      <div className="mx-auto max-w-md px-3 py-1.5">
        {/* ── 四種資源：值 + 速率 + 儲存量條 ── */}
        <div className="grid grid-cols-4 gap-1.5">
          {(Object.keys(RESOURCE_LABEL) as (keyof Amounts)[]).map((r) => {
            const value = extrapolate(hud.resources[r], hud.perHour[r], elapsed, hud.capacity);
            const full = value >= hud.capacity;
            const rate = Math.round(hud.perHour[r]);
            return (
              <div key={r} className="min-w-0">
                <div className="flex items-baseline gap-1 text-[13px] leading-tight">
                  <span className="opacity-60">{RESOURCE_LABEL[r]}</span>
                  <span
                    className={`truncate font-bold tabular-nums ${full ? "text-[#c4442f]" : ""}`}
                  >
                    {Math.floor(value).toLocaleString()}
                  </span>
                  <span
                    className={`text-[9px] tabular-nums ${
                      rate < 0 ? "text-[#c4442f]" : "opacity-50"
                    }`}
                  >
                    {rate >= 0 ? "+" : ""}
                    {rate}
                  </span>
                </div>
                {/* 儲存量條 —— 滿了會變紅，跟數字同一條規則 */}
                <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-[#2e2723]">
                  <div
                    className={`h-full ${full ? "bg-[#c4442f]" : "bg-[#8a6b3a]"}`}
                    style={{ width: `${Math.min(100, (value / hud.capacity) * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* ── 曆法、季節、人口、下一件完成的事 ── */}
        <div className="mt-1 flex items-center gap-2 text-[10px] leading-tight">
          <span className="flex items-center gap-[2px]" aria-label={hud.gameDate}>
            {SEASON_ORDER.map((s) => (
              <span
                key={s}
                className="h-[6px] w-[10px] rounded-[1px]"
                style={{
                  backgroundColor: SEASON_COLOR[s],
                  opacity: s === hud.season ? 1 : 0.25,
                }}
              />
            ))}
          </span>
          {/* ★ 曆法點得下去 —— 那是「賽季」這件事在遊戲內唯一的入口。
              放棄賽季的出口在 /seasons，而底部分頁列已經沒有位子了
              （`docs/13` §8） */}
          <Link href="/seasons" className="truncate opacity-70 underline-offset-2 hover:underline">
            {hud.gameDate}
          </Link>
          <span className="tabular-nums opacity-70">
            人口 {Math.floor(hud.population.used)}/{hud.population.cap}
          </span>
          {syncFailed ? <span className="text-[#c4442f]">⚠ 同步失敗</span> : null}
          {hud.next && hud.next.doneAt > now ? (
            <span className="ml-auto rounded-[3px] bg-[#2e2723] px-1.5 py-0.5 tabular-nums text-[#d9a441]">
              ⏳ {hud.next.label} {formatCountdown(hud.next.doneAt - now)}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
