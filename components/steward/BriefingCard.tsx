"use client";

/**
 * 施政簡報：回歸時的第一個畫面（docs/18-steward.md §7）。
 *
 * ★ 這不只是背景自動化的紀錄，它是**重新進入遊戲的敘事介面**。
 *   同一份資訊，「一堆待處理事項」與「一位下屬的回報」是完全不同的體感。
 *
 * ★ `BLOCKED` 與行動同等重要：執政官**沒做什麼**，
 *   跟它做了什麼一樣需要被看見（`18` §11.4）。
 */

import { useState, useTransition } from "react";

import { FACILITY, type Facility } from "@/lib/game/balance";
import { RESOURCE_NAME } from "@/lib/game/resource-icon";
import type { Briefing } from "@/lib/server/steward";
import type { StewardResult } from "@/app/actions/steward";

const BLOCK_TEXT: Record<string, string> = {
  PAUSED: "執政官暫停中",
  NO_SLOT: "方針超過主堡允許的同時啟用數",
  QUEUE_BUSY: "佇列都在忙",
  RESERVE: "保留下限擋住了",
  AT_CAPACITY: "領土已達上限",
  NO_TARGET: "沒有可執行的目標",
  LEVEL_CAPPED: "設施已達主堡允許的等級上限",
  POPULATION_RESERVE: "人口保留下限擋住了",
  NOT_IMPLEMENTED: "兵營要等 M3",
  INSUFFICIENT_RESOURCES: "資源不足",
  INSUFFICIENT_POPULATION: "人口不足",
  NO_FREE_QUEUE: "佇列都在忙",
};

const WARNING_TEXT: Record<string, string> = {
  OVERFLOW_SOON: "即將溢出",
  POPULATION_CAPPED: "人口已達上限，成長停滯",
  TERRITORY_CAPPED: "領土已達上限，升主堡才能再拓",
};

/** ★ 名字只有一份（`lib/game/resource-icon.ts`）—— 兩份遲早分岔 */
const RESOURCE_LABEL: Record<string, string> = RESOURCE_NAME;

export interface BriefingCardProps {
  readonly briefing: Briefing;
  readonly gameDate: string;
  readonly onAcknowledge: () => Promise<StewardResult>;
}

export function BriefingCard(props: BriefingCardProps) {
  const [pending, startTransition] = useTransition();
  const [dismissed, setDismissed] = useState(false);

  const b = props.briefing;
  if (dismissed || b.entries.length === 0) return null;

  const actions = b.entries.filter((e) => e.kind === "CLAIM" || e.kind === "BUILD" || e.kind === "LEVY");
  const blocked = b.entries.filter((e) => e.kind === "BLOCKED");
  const warnings = b.entries.filter((e) => e.kind === "WARNING");

  return (
    <section
      data-testid="steward-briefing"
      className="rounded border border-[#a35a3a] bg-[#2e2723] p-3 text-xs"
    >
      <header className="border-b border-[#4a413a] pb-2">
        <div className="font-bold">執政官 · {b.stewardName}</div>
        <div className="opacity-60">
          {props.gameDate}
          {b.awayMs !== null ? ` — 您離開了 ${formatAway(b.awayMs)}` : ""}
        </div>
        {b.fullProxy ? <div className="mt-1 text-[#c4442f]">⚑ 全權代理已收回</div> : null}
      </header>

      <ul className="space-y-1 py-2">
        {actions.map((e, i) => (
          <li key={`a${i}`}>▸ {describeAction(e.payload)}</li>
        ))}
        {actions.length === 0 ? (
          <li className="opacity-60">▸ 期間沒有行動</li>
        ) : null}
      </ul>

      {warnings.length > 0 ? (
        <ul className="space-y-1 border-t border-[#4a413a] py-2 text-[#d9a441]">
          {warnings.map((e, i) => (
            <li key={`w${i}`}>⚠ 領主，{describeWarning(e.payload)}</li>
          ))}
        </ul>
      ) : null}

      {blocked.length > 0 ? (
        <ul className="space-y-1 border-t border-[#4a413a] py-2 opacity-80">
          {blocked.map((e, i) => (
            <li key={`b${i}`}>✕ {describeBlock(e.payload)}</li>
          ))}
        </ul>
      ) : null}

      <div className="flex gap-2 border-t border-[#4a413a] pt-2">
        <button
          type="button"
          disabled={pending}
          data-testid="briefing-ack"
          onClick={() =>
            startTransition(async () => {
              await props.onAcknowledge();
              setDismissed(true);
            })
          }
          className="flex-1 rounded border border-[#4a413a] py-1.5 disabled:opacity-40"
        >
          知道了
        </button>
        <a
          href="/steward"
          className="flex-1 rounded border border-[#a35a3a] py-1.5 text-center"
        >
          調整方針
        </a>
      </div>
    </section>
  );
}

function describeAction(p: Record<string, unknown>): string {
  if (p.kind === "CLAIM") return `拓荒 (${p.x}, ${p.y})`;
  if (p.kind === "BUILD") {
    const label = FACILITY[p.facility as Facility]?.label ?? String(p.facility);
    return `${label} (${p.x}, ${p.y}) ${p.toLevel === 1 ? "建成" : `升至 Lv${p.toLevel}`}`;
  }
  if (p.kind === "LEVY") return `招募 ${p.unit} ×${p.count}`;
  return "（不明的行動）";
}

function describeBlock(p: Record<string, unknown>): string {
  const reason = BLOCK_TEXT[String(p.reason)] ?? String(p.reason);
  const detail = typeof p.detail === "string" ? ` —— ${p.detail}` : "";
  if (p.kind === "CLAIM") return `拓荒 (${p.x}, ${p.y}) 失敗：${reason}`;
  if (p.kind === "BUILD") return `建設 (${p.x}, ${p.y}) 失敗：${reason}`;
  if (p.directive) return `${directiveLabel(String(p.directive))}未執行：${reason}${detail}`;
  return reason;
}

function describeWarning(p: Record<string, unknown>): string {
  const base = WARNING_TEXT[String(p.kind)] ?? String(p.kind);
  if (p.kind === "OVERFLOW_SOON") {
    const r = RESOURCE_LABEL[String(p.resource)] ?? String(p.resource);
    const h = typeof p.hours === "number" ? Math.max(0, Math.round(p.hours)) : null;
    return h === null ? `${r}${base}` : `${r}將於 ${h} 小時後溢出`;
  }
  return base;
}

function directiveLabel(d: string): string {
  return d === "EXPANSION" ? "拓荒" : d === "DEVELOPMENT" ? "建設" : "募兵";
}

function formatAway(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.floor(ms / 60_000)} 分鐘`;
  if (h < 48) return `${h} 小時`;
  return `${Math.floor(h / 24)} 天`;
}
