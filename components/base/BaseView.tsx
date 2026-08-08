"use client";

/**
 * 據點畫面：2×2 核心、建造佇列、資源條。
 * 對應 docs/02-base-territory.md §1 與 docs/09-art-ux.md §5.1。
 *
 * ★ 這個元件**不做任何規則判斷**。能不能蓋、要花多少、要多久，
 *   全部由 `/lib/game` 的純函式算好之後當 props 傳進來。
 *   客戶端的數字只供顯示，任何提交都在 Server Action 裡重新驗證。
 */

import { useState, useTransition } from "react";

import { CitadelScene } from "./CitadelScene";
import { slotLabel } from "@/lib/game/sprite";
import { CORE_BUILDING, CORE_BUILDINGS, type CoreBuilding } from "@/lib/game/balance";
import type { CoreSlot } from "@/lib/game/build";
import type { Amounts } from "@/lib/game/settle";
import { useServerClock } from "@/components/use-server-clock";
import { ArmyPanel, type ArmyPanelProps } from "@/components/base/ArmyPanel";

export interface CoreSlotView {
  readonly slot: "A" | CoreSlot;
  readonly building: CoreBuilding | "CITADEL" | null;
  readonly level: number;
  /** 升到下一級要多少、要多久；null = 現在不能升 */
  readonly next: {
    readonly cost: Amounts;
    readonly seconds: number;
    readonly blocked: string | null;
  } | null;
}

export interface QueueView {
  readonly label: string;
  readonly doneAt: number | null;
  /** 核心佇列在蓋哪一格。★ 沒有它，鷹架就不知道該疊在哪一塊上 */
  readonly target?: "A" | CoreSlot | null;
}

export interface BaseViewProps {
  readonly citadel: number;
  readonly resources: Amounts;
  readonly perHour: Amounts;
  readonly capacity: number;
  readonly population: { amount: number; cap: number; used: number; rate: number };
  readonly territory: { used: number; cap: number; isolated: number };
  readonly slots: readonly CoreSlotView[];
  readonly coreQueue: QueueView;
  readonly territoryQueues: readonly QueueView[];
  readonly seasonLabel: string;
  /** 伺服器 render 當下的時間。倒數以此為基準校正，不信任客戶端時鐘 */
  readonly serverTime: number;
  /** 軍隊面板。招募與駐軍，行軍與戰鬥是 M3 */
  readonly army: Omit<ArmyPanelProps, "serverTime">;
  readonly onUpgrade?: (target: "CITADEL" | CoreSlot) => Promise<{ ok: boolean; reason?: string }>;
  readonly onConstruct?: (
    slot: CoreSlot,
    building: CoreBuilding,
  ) => Promise<{ ok: boolean; reason?: string }>;
}

const RESOURCE_LABEL: Record<keyof Amounts, string> = {
  grain: "糧",
  timber: "木",
  stone: "石",
  iron: "鐵",
};

const REJECTION_TEXT: Record<string, string> = {
  CORE_QUEUE_BUSY: "核心佇列忙碌中",
  CITADEL_MAXED: "主堡已滿級",
  SLOT_EMPTY: "這一格是空的",
  SLOT_OCCUPIED: "這一格已經有建築",
  ABOVE_CITADEL: "不能超過主堡等級",
  INSUFFICIENT_RESOURCES: "資源不足",
  // ★ 這一項要跟「資源不足」分開講，否則玩家會一直等一個永遠不會到的數字
  EXCEEDS_CAPACITY: "儲存上限不夠 —— 先蓋倉庫",
  NO_FREE_QUEUE: "領土佇列都在忙",
  LEVEL_CAPPED: "已達主堡允許的等級上限",
};

function Countdown({ doneAt, now }: { doneAt: number | null; now: number }) {
  if (!doneAt) return <span className="opacity-50">閒置</span>;
  const remaining = Math.max(0, doneAt - now);
  const m = Math.floor(remaining / 60_000);
  const s = Math.floor((remaining % 60_000) / 1000);
  return (
    <span className="tabular-nums">
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

export function BaseView(props: BaseViewProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [picking, setPicking] = useState<CoreSlot | null>(null);
  const now = useServerClock(props.serverTime);

  /**
   * 哪一格正在施工。核心佇列**永遠只有一條**（`docs/05` §2），
   * 所以最多一格會有鷹架 —— 而它到期之後就要立刻拿掉，
   * 不能等下一次伺服器 render。
   */
  const busySlots = new Set<string>(
    props.coreQueue.target && props.coreQueue.doneAt && props.coreQueue.doneAt > now
      ? [props.coreQueue.target]
      : [],
  );

  const act = (fn: () => Promise<{ ok: boolean; reason?: string }>) => {
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? null : (REJECTION_TEXT[r.reason ?? ""] ?? r.reason ?? "無法執行"));
    });
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 bg-[#1a1614] p-4 text-[#e8dcc0]">
      {/* 資源、速率、人口、季節都在常駐 HUD（layout 掛的 GameHud）——
          這裡只留據點自己的事：儲存上限與領土 */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs opacity-80" data-testid="resource-bar">
        <span>儲存上限 {props.capacity.toLocaleString()}</span>
        <span data-testid="territory-count">
          領土 {props.territory.used} / {props.territory.cap}
          {props.territory.isolated > 0 ? (
            <span className="text-[#c4442f]"> · 孤立 {props.territory.isolated}</span>
          ) : null}
        </span>
      </div>

      {/* ── 據點俯視全景 ── */}
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-bold">據點</h2>
          <span className="text-[11px] opacity-60">點建築升級 · 兵力紮在牆外</span>
        </div>

        {/**
         * ★ 圖本身就是操作介面（`docs/09` §6）。
         *   點一塊地：有建築就升級，空地就選建築。
         */}
        <CitadelScene
          slots={props.slots.map((s) => ({
            slot: s.slot,
            building: s.building,
            level: s.level,
            busy: busySlots.has(s.slot),
          }))}
          garrison={props.army?.garrison ?? {}}
          now={now}
          coreCountdown={
            props.coreQueue.target && props.coreQueue.doneAt
              ? { slot: props.coreQueue.target, doneAt: props.coreQueue.doneAt }
              : null
          }
          trainChips={props.army.queues
            .filter((q): q is typeof q & { doneAt: number } => q.doneAt !== null)
            .map((q) => ({ label: q.producer ? "招募" : "民兵", doneAt: q.doneAt }))}
          disabledSlots={
            new Set(
              props.slots
                .filter(
                  (s) =>
                    pending || (s.building ? !s.next || Boolean(s.next.blocked) : false),
                )
                .map((s) => s.slot),
            )
          }
          onPlotClick={(slot) => {
            const s = props.slots.find((x) => x.slot === slot);
            if (!s) return;
            if (!s.building) {
              setPicking(slot as CoreSlot);
              return;
            }
            if (props.onUpgrade) {
              act(() => props.onUpgrade!(slot === "A" ? "CITADEL" : (slot as CoreSlot)));
            }
          }}
        />

        {/* 每一塊地的成本與阻擋原因 —— 圖上放不下數字，但玩家要看得到 */}
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {props.slots.map((s) => (
            <div
              key={s.slot}
              data-testid={`slot-${s.slot}`}
              className="rounded border border-[#4a413a] bg-[#2e2723] px-2 py-1.5"
            >
              <div className="flex items-baseline justify-between text-xs">
                <span className="font-bold">{slotLabel(s.building)}</span>
                <span className="tabular-nums opacity-70">
                  {s.building ? `Lv${s.level}` : s.slot}
                </span>
              </div>

              {s.building ? (
                <button
                  type="button"
                  disabled={pending || !s.next || Boolean(s.next.blocked)}
                  onClick={() =>
                    props.onUpgrade &&
                    act(() =>
                      props.onUpgrade!(s.slot === "A" ? "CITADEL" : (s.slot as CoreSlot)),
                    )
                  }
                  className="mt-1 w-full rounded border border-[#4a413a] px-2 py-1 text-xs disabled:opacity-40"
                >
                  {s.next?.blocked
                    ? (REJECTION_TEXT[s.next.blocked] ?? s.next.blocked)
                    : `升級 → Lv${s.level + 1}`}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setPicking(s.slot as CoreSlot)}
                  className="mt-1 w-full rounded border border-[#4a413a] px-2 py-1 text-xs"
                >
                  選擇建築
                </button>
              )}

              {s.next && !s.next.blocked ? (
                <div className="mt-1 text-[10px] tabular-nums opacity-60">
                  {(Object.keys(RESOURCE_LABEL) as (keyof Amounts)[])
                    .filter((r) => s.next!.cost[r] > 0)
                    .map((r) => `${RESOURCE_LABEL[r]}${Math.round(s.next!.cost[r])}`)
                    .join(" ")}
                  {" · "}
                  {Math.round(s.next.seconds / 60)} 分
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* ── 佇列 ── */}
      <section>
        <h2 className="mb-2 text-sm font-bold">佇列</h2>
        <div
          data-testid="core-queue"
          className="flex items-center justify-between rounded border border-[#a35a3a] bg-[#2e2723] px-3 py-2 text-sm"
        >
          <span>
            核心
            <span className="ml-2 text-[10px] opacity-60">
              主堡與 B/C/D 共用，永遠只有一條
            </span>
          </span>
          <span>
            {props.coreQueue.label} <Countdown doneAt={props.coreQueue.doneAt} now={now} />
          </span>
        </div>
        <div className="mt-2 space-y-1">
          {props.territoryQueues.map((q, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded border border-[#4a413a] bg-[#2e2723] px-3 py-1.5 text-xs"
            >
              <span>領土 {i + 1}</span>
              <span>
                {q.label} <Countdown doneAt={q.doneAt} now={now} />
              </span>
            </div>
          ))}
        </div>
      </section>

      <ArmyPanel {...props.army} serverTime={props.serverTime} />

      {message ? (
        <p data-testid="base-message" className="rounded bg-[#6e3a26] px-3 py-2 text-xs">
          {message}
        </p>
      ) : null}

      {/* ── 7 選 3 的建築選單 ── */}
      {picking ? (
        <div className="fixed inset-0 z-10 flex items-end bg-black/60" onClick={() => setPicking(null)}>
          <div
            className="max-h-[70dvh] w-full overflow-y-auto rounded-t-lg border-t border-[#4a413a] bg-[#2e2723] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-1 text-sm font-bold">{picking} 格要蓋什麼</h3>
            <p className="mb-3 text-[10px] opacity-60">
              只有 3 格，以下 7 種必須捨棄 4 種。拆除要 3 小時、只退 30%，還有冷卻。
            </p>
            <div className="space-y-2">
              {CORE_BUILDINGS.map((b) => (
                <button
                  key={b}
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    const slot = picking;
                    setPicking(null);
                    if (props.onConstruct) act(() => props.onConstruct!(slot, b));
                  }}
                  className="w-full rounded border border-[#4a413a] px-3 py-2 text-left text-xs hover:bg-[#4a413a]"
                >
                  <div className="font-bold">{CORE_BUILDING[b].label}</div>
                  <div className="opacity-70">{CORE_BUILDING[b].effect}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
