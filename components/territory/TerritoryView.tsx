"use client";

/**
 * 領土畫面：已有的地、可拓荒的候選格、設施建造。
 * 對應 docs/02-base-territory.md §2–3。
 *
 * ★ 一樣不做規則判斷。候選格與成本都是伺服器算好的，
 *   按下去之後 Server Action 會用同一組純函式再驗一次。
 */

import Link from "next/link";
import { useState, useTransition } from "react";

import { FACILITIES, FACILITY, type Facility } from "@/lib/game/balance";
import type { ActionResult } from "@/app/actions/base";
import type { ClaimCandidate, OwnedTileView, TerritoryBoard } from "@/lib/server/territory-board";

const REJECTION_TEXT: Record<string, string> = {
  NO_FREE_QUEUE: "領土佇列都在忙 —— 同時拓荒數等於佇列數",
  AT_CAPACITY: "領土已達主堡允許的上限",
  NOT_ADJACENT: "只能從相連的領土往外拓",
  ALREADY_OWNED: "這格已經是你的了",
  IMPASSABLE: "這是山脈，過不去",
  BLOCKED: "這格已經有主人",
  OUT_OF_BOUNDS: "超出地圖範圍",
  INSUFFICIENT_RESOURCES: "資源不足",
  INSUFFICIENT_POPULATION: "人口不足，拓荒隊派不出去",
  GUARDED_TILE: "有野生守衛 —— 到軍事頁派「征服」打下來",
  TERRAIN_UNAVAILABLE: "這一季的地形檔還沒生成",
  LEVEL_CAPPED: "設施等級不能超過主堡允許的上限",
  EXCEEDS_CAPACITY: "儲存上限不夠 —— 先蓋倉庫",
  NOT_OWNED: "這不是你的領土",
  FACILITY_MISMATCH: "一格只能有一種設施",
  MARKET_LIMIT: "集市每位玩家上限 1 座",
};

export interface TerritoryViewProps {
  readonly board: TerritoryBoard;
  readonly onClaim: (x: number, y: number) => Promise<ActionResult>;
  readonly onBuild: (x: number, y: number, facility: string) => Promise<ActionResult>;
}

export function TerritoryView(props: TerritoryViewProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [picking, setPicking] = useState<OwnedTileView | null>(null);

  const act = (fn: () => Promise<ActionResult>) => {
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? null : (REJECTION_TEXT[r.reason ?? ""] ?? r.reason ?? "無法執行"));
    });
  };

  const b = props.board;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 bg-[#1a1614] p-4 text-[#e8dcc0]">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-bold">領土</h1>
        <span className="text-xs tabular-nums opacity-70" data-testid="territory-usage">
          {b.owned.length} / {b.capacity}
        </span>
      </header>

      {!b.queuesFree ? (
        <p className="rounded border border-[#a35a3a] bg-[#2e2723] px-3 py-2 text-[11px] opacity-80">
          領土佇列都在忙。同時拓荒數等於佇列數（`1 + ⌊主堡/10⌋`），拓不動就先等一條空出來。
        </p>
      ) : null}

      {/* ── 已有的地 ── */}
      <section>
        <h2 className="mb-2 text-sm font-bold">已佔領</h2>
        {b.owned.length === 0 ? (
          <p className="rounded border border-[#4a413a] bg-[#2e2723] p-3 text-xs opacity-60">
            還沒有領土。從下面的候選格拓第一塊。
          </p>
        ) : (
          <ul className="space-y-1" data-testid="owned-tiles">
            {b.owned.map((t) => (
              <li
                key={`${t.x},${t.y}`}
                className={`flex items-center justify-between rounded border px-3 py-1.5 text-xs ${
                  t.isolated ? "border-[#c4442f] bg-[#2e2723]" : "border-[#4a413a] bg-[#2e2723]"
                }`}
              >
                <div>
                  <span className="tabular-nums opacity-70">
                    ({t.x}, {t.y})
                  </span>
                  <span className="ml-2 opacity-60">{t.terrainLabel}</span>
                  {t.isolated ? (
                    <span className="ml-2 text-[#c4442f]">孤立 · 產出減半</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setPicking(t)}
                  className="rounded border border-[#4a413a] px-2 py-0.5 disabled:opacity-40"
                >
                  {t.facility
                    ? `${FACILITY[t.facility as Facility].label} Lv${t.facilityLevel} ↑`
                    : "蓋設施"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 可拓荒 ── */}
      <section>
        <h2 className="mb-2 text-sm font-bold">可拓荒</h2>
        <p className="mb-2 text-[10px] opacity-50">
          成本、民兵、時間**三重**隨已有領土遞增 —— 無限擴張在任何一個維度上都走不通。
        </p>
        {b.candidates.length === 0 ? (
          <p className="rounded border border-[#4a413a] bg-[#2e2723] p-3 text-xs opacity-60">
            四周沒有可拓的空地。
          </p>
        ) : (
          <ul className="space-y-1" data-testid="claim-candidates">
            {b.candidates.map((c) => (
              <Candidate
                key={`${c.x},${c.y}`}
                candidate={c}
                disabled={pending || !b.queuesFree || b.owned.length >= b.capacity}
                onClaim={() => act(() => props.onClaim(c.x, c.y))}
              />
            ))}
          </ul>
        )}
      </section>

      {message ? (
        <p data-testid="territory-message" className="rounded bg-[#6e3a26] px-3 py-2 text-xs">
          {message}
        </p>
      ) : null}

      {/* ── 設施選單 ── */}
      {picking ? (
        <div
          className="fixed inset-0 z-10 flex items-end bg-black/60"
          onClick={() => setPicking(null)}
        >
          <div
            className="max-h-[70dvh] w-full overflow-y-auto rounded-t-lg border-t border-[#4a413a] bg-[#2e2723] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-sm font-bold">
              ({picking.x}, {picking.y}) · {picking.terrainLabel}
            </h3>
            <p className="mb-3 text-[10px] opacity-60">
              {picking.facility
                ? `目前是 ${FACILITY[picking.facility as Facility].label} Lv${picking.facilityLevel}，只能升級同一種。`
                : "選一種蓋上去。地形會影響產出。"}
            </p>
            <div className="space-y-2">
              {(picking.facility ? [picking.facility as Facility] : FACILITIES).map((f) => (
                <button
                  key={f}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const t = picking;
                    setPicking(null);
                    act(() => props.onBuild(t.x, t.y, f));
                  }}
                  className="w-full rounded border border-[#4a413a] px-3 py-2 text-left text-xs hover:bg-[#4a413a]"
                >
                  <div className="font-bold">
                    {FACILITY[f].label}
                    {picking.facility ? ` → Lv${picking.facilityLevel + 1}` : ""}
                  </div>
                  <div className="tabular-nums opacity-70">
                    {Object.entries(FACILITY[f].cost)
                      .map(([r, v]) => `${SHORT[r] ?? r}${v}`)
                      .join(" ")}
                    {FACILITY[f].yields ? ` · 產 ${SHORT[FACILITY[f].yields]}` : ""}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

const SHORT: Record<string, string> = {
  grain: "糧",
  timber: "木",
  stone: "石",
  iron: "鐵",
};

function Candidate({
  candidate,
  disabled,
  onClaim,
}: {
  candidate: ClaimCandidate;
  disabled: boolean;
  onClaim: () => void;
}) {
  return (
    <li className="flex items-center justify-between rounded border border-[#4a413a] bg-[#2e2723] px-3 py-1.5 text-xs">
      <div>
        <span className="tabular-nums opacity-70">
          ({candidate.x}, {candidate.y})
        </span>
        <span className="ml-2 opacity-60">{candidate.terrainLabel}</span>
        {candidate.level > 0 ? (
          <span
            className={`ml-1.5 rounded-[2px] px-1 text-[10px] tabular-nums ${
              candidate.guarded ? "bg-[#6e3a26] text-[#e8dcc0]" : "bg-[#4a413a] text-[#e8dcc0]"
            }`}
          >
            Lv{candidate.level}
          </span>
        ) : null}
        <div className="text-[10px] tabular-nums opacity-60">
          {candidate.guarded ? (
            <>有野生守衛 —— 產出 +{Math.round((candidate.level - 1) * 15)}%，要派兵征服</>
          ) : (
            <>
              糧{candidate.cost.grain} 木{candidate.cost.timber} · 民兵{candidate.militia} ·{" "}
              {Math.round(candidate.seconds / 60)} 分
            </>
          )}
        </div>
      </div>
      {candidate.guarded ? (
        <Link
          href={`/war?type=CLAIM&x=${candidate.x}&y=${candidate.y}`}
          className="rounded border border-[#8a6b3a] px-3 py-1 text-[#d9a441]"
        >
          征服
        </Link>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={onClaim}
          className="rounded border border-[#a35a3a] px-3 py-1 disabled:opacity-40"
        >
          拓荒
        </button>
      )}
    </li>
  );
}
