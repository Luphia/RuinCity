"use client";

/**
 * 執政官畫面：三個方針、保留下限、領主接管。
 * 對應 docs/18-steward.md §4、§6。
 *
 * ★ 保留下限的滑桿是這一頁的核心。少了它，執政官就會替領主做完
 *   所有的資源分配決策 —— 而那正是遊戲的樂趣所在（`03` §7）。
 */

import { useState, useTransition } from "react";

import { FACILITIES, FACILITY, UNIT, type Facility } from "@/lib/game/balance";
import type { Directives } from "@/lib/game/steward";
import type { StewardBoard, StewardResult } from "@/app/actions/steward";
import type { Amounts } from "@/lib/game/settle";
import { useServerClock } from "@/components/use-server-clock";
import { avatarSvg, STEWARD_NAME_MAX } from "@/lib/game/avatar";

const RESOURCE_LABEL: Record<keyof Amounts, string> = {
  grain: "糧",
  timber: "木",
  stone: "石",
  iron: "鐵",
};
const RESOURCE_KEYS = Object.keys(RESOURCE_LABEL) as (keyof Amounts)[];

const PREFERENCE_LABEL = {
  NEAREST: "就近",
  TOWARD_RUIN: "朝遺跡",
  TOWARD_WILD: "朝荒野",
} as const;

export interface StewardViewProps {
  readonly board: StewardBoard;
  readonly onSave: (directives: Directives) => Promise<StewardResult>;
  readonly onPause: (hours: number) => Promise<StewardResult>;
  readonly onResume: () => Promise<StewardResult>;
  readonly onRecall: (eventId: number) => Promise<StewardResult>;
  /** 純外觀、免費（`docs/18` §9、§10） */
  readonly onRename: (name: string) => Promise<StewardResult>;
}

export function StewardView(props: StewardViewProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [d, setD] = useState<Directives>(props.board.directives);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(props.board.name);
  const now = useServerClock(props.board.serverTime);

  const act = (fn: () => Promise<StewardResult>) => {
    startTransition(async () => {
      const r = await fn();
      setMessage(r.ok ? "已更新" : (r.reason ?? "無法執行"));
    });
  };

  const enabled =
    (d.expansion.enabled ? 1 : 0) + (d.development.enabled ? 1 : 0) + (d.levy.enabled ? 1 : 0);
  const over = Math.max(0, enabled - props.board.slots);
  const paused = props.board.pausedUntil !== null && props.board.pausedUntil > now;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 bg-[#1a1614] p-4 text-[#e8dcc0]">
      <header className="flex items-center gap-3">
        <Avatar seed={props.board.avatarSeed} />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <div className="flex gap-1">
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                maxLength={STEWARD_NAME_MAX * 2}
                data-testid="steward-name-input"
                className="w-full rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 text-sm"
              />
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  act(async () => {
                    const r = await props.onRename(draftName);
                    if (r.ok) setRenaming(false);
                    return r;
                  })
                }
                className="rounded border border-[#a35a3a] px-2 py-1 text-xs disabled:opacity-40"
              >
                改名
              </button>
            </div>
          ) : (
            <h1 className="text-lg font-bold">
              執政官 · {props.board.name}
              <button
                type="button"
                onClick={() => {
                  setDraftName(props.board.name);
                  setRenaming(true);
                }}
                className="ml-2 rounded border border-[#4a413a] px-2 py-0.5 align-middle text-[10px] font-normal opacity-70"
              >
                改名
              </button>
            </h1>
          )}
          <p className="text-[11px] opacity-60">
            執行你的政策，不替你做決策。核心佇列與軍事永遠手動。
          </p>
        </div>
      </header>

      {props.board.fullProxy ? (
        <p className="rounded border border-[#a35a3a] bg-[#2e2723] px-3 py-2 text-xs">
          ⚑ 全權代理中 —— 你已連續 48 小時未登入。
          <span className="opacity-70">
            {" "}
            全權期間仍不會主動攻擊、退盟或交易，也不提供任何防禦加成。
          </span>
        </p>
      ) : null}

      {paused ? (
        <div className="flex items-center justify-between rounded border border-[#a35a3a] bg-[#2e2723] px-3 py-2 text-xs">
          <span data-testid="steward-paused">
            已暫停 · 剩 {formatRemaining(props.board.pausedUntil! - now)}
          </span>
          <button
            type="button"
            disabled={pending}
            onClick={() => act(props.onResume)}
            className="rounded border border-[#4a413a] px-3 py-1 disabled:opacity-40"
          >
            立刻恢復
          </button>
        </div>
      ) : null}

      <p className="text-xs opacity-70" data-testid="directive-slots">
        主堡 Lv{props.board.citadelLevel} · 可同時啟用 {props.board.slots} 個方針
        {over > 0 ? (
          <span className="text-[#c4442f]"> · 有 {over} 個超額，不會生效</span>
        ) : null}
      </p>

      {/* ── 拓荒 ── */}
      <Section
        title="拓荒 Expansion"
        note="領土佇列閒置時，派出拓荒隊佔領相鄰的中立格"
        enabled={d.expansion.enabled}
        onToggle={(v) => setD({ ...d, expansion: { ...d.expansion, enabled: v } })}
      >
        <div className="flex gap-1">
          {(["NEAREST", "TOWARD_RUIN", "TOWARD_WILD"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setD({ ...d, expansion: { ...d.expansion, preference: p } })}
              className={`flex-1 rounded border px-2 py-1 text-[11px] ${
                d.expansion.preference === p
                  ? "border-[#a35a3a] bg-[#4a413a]"
                  : "border-[#4a413a]"
              }`}
            >
              {PREFERENCE_LABEL[p]}
            </button>
          ))}
        </div>
        <Reserve
          value={d.expansion.reserve}
          max={props.board.capacity}
          onChange={(reserve) => setD({ ...d, expansion: { ...d.expansion, reserve } })}
        />
      </Section>

      {/* ── 建設 ── */}
      <Section
        title="建設 Development"
        note="領土佇列閒置時，依優先序新建或升級設施"
        enabled={d.development.enabled}
        onToggle={(v) => setD({ ...d, development: { ...d.development, enabled: v } })}
      >
        <Priority
          value={d.development.priority}
          onChange={(priority) => setD({ ...d, development: { ...d.development, priority } })}
        />
        <Reserve
          value={d.development.reserve}
          max={props.board.capacity}
          onChange={(reserve) => setD({ ...d, development: { ...d.development, reserve } })}
        />
      </Section>

      {/* ── 募兵 ── */}
      <Section
        title="募兵 Levy"
        note="招募佇列閒置時依配比招兵。一座生產建築 = 一條佇列"
        enabled={d.levy.enabled}
        onToggle={(v) => setD({ ...d, levy: { ...d.levy, enabled: v } })}
      >
        <label className="flex items-center justify-between text-[11px]">
          <span className="opacity-70">人口保留下限</span>
          <input
            type="number"
            min={0}
            value={d.levy.populationReserve}
            onChange={(e) =>
              setD({ ...d, levy: { ...d.levy, populationReserve: Number(e.target.value) || 0 } })
            }
            className="w-24 rounded border border-[#4a413a] bg-[#1a1614] px-2 py-1 text-right tabular-nums"
          />
        </label>
        <div>
          <div className="mb-1 text-[10px] opacity-60">兵種配比（點擊切換；權重相同）</div>
          <div className="flex flex-wrap gap-1">
            {props.board.unlockedUnits.map((u) => {
              const on = (d.levy.mix[u] ?? 0) > 0;
              return (
                <button
                  key={u}
                  type="button"
                  onClick={() => {
                    const mix = { ...d.levy.mix };
                    if (on) delete mix[u];
                    else mix[u] = 1;
                    setD({ ...d, levy: { ...d.levy, mix } });
                  }}
                  className={`rounded border px-2 py-1 text-[11px] ${
                    on ? "border-[#a35a3a] bg-[#4a413a]" : "border-[#4a413a] opacity-50"
                  }`}
                >
                  {UNIT[u].label}
                </button>
              );
            })}
          </div>
        </div>
        <Reserve
          value={d.levy.reserve}
          max={props.board.capacity}
          onChange={(reserve) => setD({ ...d, levy: { ...d.levy, reserve } })}
        />
      </Section>

      <button
        type="button"
        disabled={pending}
        data-testid="save-directives"
        onClick={() => act(() => props.onSave(d))}
        className="rounded border border-[#a35a3a] bg-[#2e2723] py-2 text-sm disabled:opacity-40"
      >
        套用方針
      </button>

      {/* ── 領主接管 ── */}
      <section className="rounded border border-[#4a413a] bg-[#2e2723] p-3">
        <h2 className="mb-2 text-sm font-bold">領主接管</h2>
        <p className="mb-2 text-[10px] opacity-60">
          你的任何手動操作本來就自動優先 —— 佇列一有東西，執政官就沒有回合。
          下面是更粗的粒度。
        </p>
        <div className="flex gap-1">
          {[1, 6, 12, 24].map((h) => (
            <button
              key={h}
              type="button"
              disabled={pending}
              onClick={() => act(() => props.onPause(h))}
              className="flex-1 rounded border border-[#4a413a] px-2 py-1 text-[11px] disabled:opacity-40"
            >
              暫停 {h}h
            </button>
          ))}
        </div>

        {props.board.recallable.length > 0 ? (
          <div className="mt-3 space-y-1">
            <h3 className="text-[11px] opacity-70">進行中的拓荒隊</h3>
            {props.board.recallable.map((r) => (
              <div
                key={r.eventId}
                className="flex items-center justify-between rounded border border-[#4a413a] px-2 py-1 text-[11px]"
              >
                <span className="tabular-nums">
                  ({r.x}, {r.y}) · 剩 {formatRemaining(r.doneAt - now)}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => act(() => props.onRecall(r.eventId))}
                  className="rounded border border-[#4a413a] px-2 py-0.5 disabled:opacity-40"
                >
                  召回
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {message ? (
        <p data-testid="steward-message" className="rounded bg-[#6e3a26] px-3 py-2 text-xs">
          {message}
        </p>
      ) : null}
    </main>
  );
}

function Section({
  title,
  note,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  note: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border border-[#4a413a] bg-[#2e2723] p-3">
      <label className="flex items-start justify-between gap-3">
        <span>
          <span className="text-sm font-bold">{title}</span>
          <span className="block text-[10px] opacity-60">{note}</span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-1 size-4 shrink-0"
        />
      </label>
      {enabled ? <div className="mt-3 space-y-2">{children}</div> : null}
    </section>
  );
}

/**
 * 資源保留下限。
 *
 * ★ 「木材保留 5,000 以下不動用」—— 你正在存木材升主堡 Lv18，
 *   執政官不會把它花在拓荒上。這一個設定保住了整套取捨系統。
 */
function Reserve({
  value,
  max,
  onChange,
}: {
  value: Amounts;
  max: number;
  onChange: (v: Amounts) => void;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] opacity-60">
        資源保留下限 —— 執政官只動用超過這條線的部分
      </div>
      {RESOURCE_KEYS.map((r) => (
        <label key={r} className="flex items-center gap-2 text-[11px]">
          <span className="w-4 opacity-70">{RESOURCE_LABEL[r]}</span>
          <input
            type="range"
            min={0}
            max={max}
            step={Math.max(1, Math.round(max / 100))}
            value={Math.min(value[r], max)}
            onChange={(e) => onChange({ ...value, [r]: Number(e.target.value) })}
            className="flex-1"
          />
          <span className="w-16 text-right tabular-nums opacity-70">
            {Math.round(value[r]).toLocaleString()}
          </span>
        </label>
      ))}
    </div>
  );
}

/** 設施優先序：點一下把它移到最前面，再點一下移除 */
function Priority({
  value,
  onChange,
}: {
  value: readonly Facility[];
  onChange: (v: Facility[]) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] opacity-60">
        設施優先序（點擊調整；沒列到的執政官不會蓋）
      </div>
      <div className="flex flex-wrap gap-1">
        {FACILITIES.map((f) => {
          const rank = value.indexOf(f);
          return (
            <button
              key={f}
              type="button"
              onClick={() =>
                onChange(
                  rank === 0
                    ? value.filter((x) => x !== f)
                    : [f, ...value.filter((x) => x !== f)],
                )
              }
              className={`rounded border px-2 py-1 text-[11px] ${
                rank >= 0 ? "border-[#a35a3a] bg-[#4a413a]" : "border-[#4a413a] opacity-50"
              }`}
            >
              {rank >= 0 ? `${rank + 1}. ` : ""}
              {FACILITY[f].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 32×32 像素頭像（`docs/18` §9）。
 *
 * ★ 用 `dangerouslySetInnerHTML` 是因為 `avatarSvg` 產生的是我們自己
 *   組出來的字串 —— 唯一的變數是一個數字 seed，沒有任何使用者輸入
 *   會進到那個字串裡。
 */
function Avatar({ seed }: { seed: number }) {
  const svg = avatarSvg(seed, 2);
  return (
    <div
      aria-hidden
      className="size-16 shrink-0 overflow-hidden rounded border border-[#4a413a] bg-[#2e2723]"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h} 小時 ${m} 分` : `${m} 分`;
}
