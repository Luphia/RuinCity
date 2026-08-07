"use client";

/**
 * 軍事畫面：派兵、在途部隊、來襲預警、戰報。
 * 對應 docs/04-military-combat.md 與 docs/09-art-ux.md §5.1。
 */

import { useState, useTransition } from "react";

import { UNIT, type Unit } from "@/lib/game/balance";
import type { MarchResult, ReportView, WarBoard } from "@/app/actions/war";
import { useServerClock } from "@/components/use-server-clock";
import { BattleReportCard } from "@/components/war/BattleReportCard";

const TYPE_LABEL: Record<string, string> = {
  RAID: "突襲",
  ATTACK: "攻擊",
  SCOUT: "偵查",
  REINFORCE: "增援",
  GARRISON: "駐防",
  RETURN: "返程",
  CLAIM: "拓荒",
};

const TYPE_NOTE: Record<string, string> = {
  RAID: "只交戰一輪、雙方損失 ×0.6，不破壞建築、不佔領",
  ATTACK: "完整戰鬥；可破城牆，帶投石機可拆指定建築",
  SCOUT: "只能派偵查兵；不觸發對方的來襲預警",
  REINFORCE: "部隊駐紮在對方據點、計入對方防禦；糧食仍由你付",
  GARRISON: "停駐並成為新的行軍起點",
};

const REJECTION_TEXT: Record<string, string> = {
  UNKNOWN_TYPE: "沒有這種行軍類型",
  EMPTY_ARMY: "沒有選任何部隊",
  NOT_IN_GARRISON: "駐軍裡沒有這麼多兵",
  SELF_TARGET: "不能打自己",
  SCOUT_ONLY: "偵查只能派偵查兵",
  SCOUT_REQUIRES_SCOUTS: "至少要派一隻偵查兵",
  TOO_FAR: "超過 8 小時行軍上限 —— 先在中途建立前哨營",
  SAME_TILE: "目標就是出發地",
  NOT_FOUND: "找不到這支部隊",
  ALREADY_ARRIVED: "已經抵達，召不回來了",
  ALREADY_RETURNING: "這支部隊已經在回家路上",
};

const SCALE_LABEL = { SMALL: "小股", MEDIUM: "中等規模", LARGE: "大軍" } as const;

export interface WarViewProps {
  readonly board: WarBoard;
  readonly onSend: (
    type: string,
    toX: number,
    toY: number,
    army: Record<string, number>,
  ) => Promise<MarchResult>;
  readonly onRecall: (marchId: number) => Promise<MarchResult>;
}

export function WarView(props: WarViewProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [type, setType] = useState<string>("RAID");
  const [target, setTarget] = useState({ x: "", y: "" });
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [openReport, setOpenReport] = useState<number | null>(null);
  const now = useServerClock(props.board.serverTime);

  const act = (fn: () => Promise<MarchResult>) => {
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? null : (REJECTION_TEXT[r.reason ?? ""] ?? r.reason ?? "無法執行"));
    });
  };

  const units = Object.entries(props.board.garrison).filter(([, n]) => (n ?? 0) > 0) as [
    Unit,
    number,
  ][];

  const army = Object.fromEntries(
    Object.entries(picked)
      .map(([u, v]) => [u, Math.floor(Number(v) || 0)])
      .filter(([, n]) => (n as number) > 0),
  ) as Record<string, number>;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 bg-[#1a1614] p-4 text-[#e8dcc0]">
      <header>
        <h1 className="text-lg font-bold">軍事</h1>
        <p className="text-[11px] opacity-60">
          據點 ({props.board.baseX}, {props.board.baseY}) · 派出去的兵就不在家守著
        </p>
      </header>

      {/* ── 來襲預警 ── */}
      {props.board.incoming.length > 0 ? (
        <section
          data-testid="incoming-warning"
          className="rounded border border-[#c4442f] bg-[#2e2723] p-3"
        >
          <h2 className="mb-1 text-sm font-bold text-[#c4442f]">來襲警報</h2>
          <ul className="space-y-1 text-xs">
            {props.board.incoming.map((i) => (
              <li key={i.id} className="tabular-nums">
                {SCALE_LABEL[i.scale]}敵軍 · 剩 {formatRemaining(i.arrivesAt - now)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] opacity-60">
            預警是比例制的：遠方來的看得早，隔壁鄰居幾乎是瞬間的。
          </p>
        </section>
      ) : null}

      {/* ── 派兵 ── */}
      <section className="rounded border border-[#4a413a] bg-[#2e2723] p-3">
        <h2 className="mb-2 text-sm font-bold">派兵</h2>

        <div className="mb-2 flex flex-wrap gap-1">
          {props.board.types.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`rounded border px-2 py-1 text-[11px] ${
                type === t ? "border-[#a35a3a] bg-[#4a413a]" : "border-[#4a413a]"
              }`}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <p className="mb-2 text-[10px] opacity-60">{TYPE_NOTE[type]}</p>

        <div className="mb-2 flex gap-1 text-xs">
          <input
            value={target.x}
            onChange={(e) => setTarget({ ...target, x: e.target.value })}
            placeholder="X"
            inputMode="numeric"
            className="w-20 rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 tabular-nums"
          />
          <input
            value={target.y}
            onChange={(e) => setTarget({ ...target, y: e.target.value })}
            placeholder="Y"
            inputMode="numeric"
            className="w-20 rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 tabular-nums"
          />
        </div>

        {units.length === 0 ? (
          <p className="text-xs opacity-60">本營沒有駐軍。先去據點招兵。</p>
        ) : (
          <div className="space-y-1">
            {units.map(([unit, have]) => (
              <label key={unit} className="flex items-center gap-2 text-xs">
                <span className="w-16 opacity-70">{UNIT[unit].label}</span>
                <span className="w-12 text-right tabular-nums opacity-60">{have}</span>
                <input
                  value={picked[unit] ?? ""}
                  onChange={(e) => setPicked({ ...picked, [unit]: e.target.value })}
                  inputMode="numeric"
                  className="w-20 rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 text-right tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => setPicked({ ...picked, [unit]: String(have) })}
                  className="rounded border border-[#4a413a] px-2 py-1"
                >
                  全
                </button>
              </label>
            ))}
          </div>
        )}

        <button
          type="button"
          disabled={pending || units.length === 0}
          data-testid="send-march"
          onClick={() =>
            act(() => props.onSend(type, Number(target.x) || -1, Number(target.y) || -1, army))
          }
          className="mt-2 w-full rounded border border-[#a35a3a] px-2 py-1.5 text-xs disabled:opacity-40"
        >
          出發
        </button>
      </section>

      {/* ── 在途 ── */}
      <section>
        <h2 className="mb-2 text-sm font-bold">在途部隊</h2>
        {props.board.outgoing.length === 0 ? (
          <p className="rounded border border-[#4a413a] bg-[#2e2723] p-3 text-xs opacity-60">
            沒有部隊在路上。
          </p>
        ) : (
          <ul className="space-y-1" data-testid="outgoing-marches">
            {props.board.outgoing.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between rounded border border-[#4a413a] bg-[#2e2723] px-3 py-1.5 text-xs"
              >
                <div>
                  <span>{TYPE_LABEL[m.type] ?? m.type}</span>
                  <span className="ml-2 tabular-nums opacity-70">
                    → ({m.toX}, {m.toY})
                  </span>
                  <div className="text-[10px] tabular-nums opacity-60">
                    {Object.entries(m.army)
                      .map(([u, n]) => `${UNIT[u as Unit].label}${n}`)
                      .join(" ")}
                    {" · 剩 "}
                    {formatRemaining(m.arrivesAt - now)}
                  </div>
                </div>
                {m.canRecall ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => act(() => props.onRecall(m.id))}
                    className="rounded border border-[#4a413a] px-2 py-1 disabled:opacity-40"
                  >
                    召回
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 戰報 ── */}
      <section>
        <h2 className="mb-2 text-sm font-bold">戰報</h2>
        {props.board.reports.length === 0 ? (
          <p className="rounded border border-[#4a413a] bg-[#2e2723] p-3 text-xs opacity-60">
            還沒有戰報。
          </p>
        ) : (
          <ul className="space-y-1" data-testid="battle-reports">
            {props.board.reports.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenReport(openReport === r.id ? null : r.id)}
                  className="w-full rounded border border-[#4a413a] bg-[#2e2723] px-3 py-1.5 text-left text-xs"
                >
                  <span className={outcomeColour(r)}>{outcomeLabel(r)}</span>
                  <span className="ml-2 opacity-70">
                    {TYPE_LABEL[r.marchType] ?? r.marchType} ({r.atX}, {r.atY})
                  </span>
                </button>
                {openReport === r.id ? <BattleReportCard report={r} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {message ? (
        <p data-testid="war-message" className="rounded bg-[#6e3a26] px-3 py-2 text-xs">
          {message}
        </p>
      ) : null}
    </main>
  );
}

function outcomeLabel(r: ReportView): string {
  if (r.outcome === "SCOUT_SUCCESS") return "偵查成功";
  if (r.outcome === "SCOUT_FAILED") return "偵查失敗";
  const won = r.outcome === "ATTACKER_WIN" ? r.attacking : !r.attacking;
  return `${r.attacking ? "進攻" : "防守"}${won ? "勝" : "敗"}`;
}

function outcomeColour(r: ReportView): string {
  if (r.outcome.startsWith("SCOUT")) return "opacity-80";
  const won = r.outcome === "ATTACKER_WIN" ? r.attacking : !r.attacking;
  return won ? "text-[#7a9a5a]" : "text-[#c4442f]";
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
