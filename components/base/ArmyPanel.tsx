"use client";

/**
 * 招募與駐軍。對應 docs/02-base-territory.md §1.2。
 *
 * ★ 一座生產建築 = 一條招募佇列。想同時爆步兵與騎兵，
 *   就要在只有三格的核心裡同時放兵營與獸廄 ——
 *   而那兩格本來可以是倉庫與城牆。
 *
 * 行軍與戰鬥是 M3；這裡招出來的兵留在本營。
 */

import { useState, useTransition } from "react";

import { UNIT, type Unit } from "@/lib/game/balance";
import { maxAffordable } from "@/lib/game/train";
import type { Amounts } from "@/lib/game/settle";
import type { ActionResult } from "@/app/actions/base";
import { useServerClock } from "@/components/use-server-clock";

const REJECTION_TEXT: Record<string, string> = {
  UNKNOWN_UNIT: "沒有這種兵",
  NO_PRODUCER: "缺少生產建築",
  PRODUCER_LEVEL: "生產建築等級不夠",
  QUEUE_BUSY: "這條招募佇列忙碌中",
  NON_POSITIVE: "數量要大於零",
  INSUFFICIENT_RESOURCES: "資源不足",
  INSUFFICIENT_POPULATION: "人口不足",
  EXCEEDS_CAPACITY: "一次下這麼多，倉庫存不下所需的資源",
};

export interface TrainQueueView {
  /** null = 民兵佇列 */
  readonly producer: string | null;
  readonly label: string;
  readonly doneAt: number | null;
}

export interface ArmyPanelProps {
  readonly garrison: Readonly<Partial<Record<Unit, number>>>;
  readonly unlocked: readonly Unit[];
  readonly resources: Amounts;
  readonly capacity: number;
  readonly freePopulation: number;
  readonly queues: readonly TrainQueueView[];
  readonly serverTime: number;
  readonly onTrain: (unit: string, count: number) => Promise<ActionResult>;
}

export function ArmyPanel(props: ArmyPanelProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [picked, setPicked] = useState<Unit | null>(null);
  const [count, setCount] = useState("10");
  const now = useServerClock(props.serverTime);

  const total = Object.values(props.garrison).reduce((s, n) => s + (n ?? 0), 0);

  const act = (unit: Unit, n: number) => {
    startTransition(async () => {
      const r = await props.onTrain(unit, n);
      setMessage(r.ok ? null : (REJECTION_TEXT[r.reason ?? ""] ?? r.reason ?? "無法執行"));
    });
  };

  return (
    <section data-testid="army-panel">
      <h2 className="mb-2 text-sm font-bold">
        軍隊
        <span className="ml-2 text-xs font-normal tabular-nums opacity-60">
          駐軍 {total.toLocaleString()}
        </span>
      </h2>

      {/* ── 駐軍 ── */}
      {total > 0 ? (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 rounded border border-[#4a413a] bg-[#2e2723] p-2 text-xs">
          {(Object.entries(props.garrison) as [Unit, number][])
            .filter(([, n]) => n > 0)
            .map(([unit, n]) => (
              <span key={unit} className="tabular-nums">
                {UNIT[unit].label} {n.toLocaleString()}
              </span>
            ))}
        </div>
      ) : (
        <p className="mb-2 rounded border border-[#4a413a] bg-[#2e2723] p-2 text-xs opacity-60">
          本營沒有駐軍。
        </p>
      )}

      {/* ── 招募佇列 ── */}
      <div className="mb-2 space-y-1">
        {props.queues.map((q) => (
          <div
            key={q.producer ?? "MILITIA"}
            className="flex items-center justify-between rounded border border-[#4a413a] bg-[#2e2723] px-3 py-1.5 text-xs"
          >
            <span>{q.label}</span>
            <span className="tabular-nums">
              {q.doneAt && q.doneAt > now ? formatRemaining(q.doneAt - now) : "閒置"}
            </span>
          </div>
        ))}
      </div>

      {/* ── 招募 ── */}
      <div className="flex flex-wrap gap-1">
        {props.unlocked.map((u) => (
          <button
            key={u}
            type="button"
            disabled={pending}
            onClick={() => setPicked(picked === u ? null : u)}
            className={`rounded border px-2 py-1 text-[11px] ${
              picked === u ? "border-[#a35a3a] bg-[#4a413a]" : "border-[#4a413a]"
            }`}
          >
            {UNIT[u].label}
          </button>
        ))}
      </div>

      {picked ? (
        <div className="mt-2 rounded border border-[#4a413a] bg-[#2e2723] p-2 text-xs">
          <div className="mb-1 tabular-nums opacity-70">
            {UNIT[picked].label} · 每人{" "}
            {(["grain", "timber", "stone", "iron"] as const)
              .filter((r) => UNIT[picked].cost[r] > 0)
              .map((r) => `${SHORT[r]}${UNIT[picked].cost[r]}`)
              .join(" ")}{" "}
            · 人口 {UNIT[picked].population}
          </div>
          <div className="flex gap-1">
            <input
              value={count}
              onChange={(e) => setCount(e.target.value)}
              inputMode="numeric"
              className="w-20 rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 text-right tabular-nums"
            />
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                setCount(
                  String(
                    maxAffordable(
                      picked,
                      props.resources,
                      props.capacity,
                      props.freePopulation,
                    ),
                  ),
                )
              }
              className="rounded border border-[#4a413a] px-2 py-1 disabled:opacity-40"
            >
              最大
            </button>
            <button
              type="button"
              disabled={pending}
              data-testid="train-submit"
              onClick={() => act(picked, Number(count) || 0)}
              className="flex-1 rounded border border-[#a35a3a] px-2 py-1 disabled:opacity-40"
            >
              招募
            </button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p data-testid="army-message" className="mt-2 rounded bg-[#6e3a26] px-3 py-2 text-xs">
          {message}
        </p>
      ) : null}
    </section>
  );
}

const SHORT: Record<string, string> = { grain: "糧", timber: "木", stone: "石", iron: "鐵" };

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
