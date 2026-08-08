"use client";

/**
 * 進行中的交戰：倒數、名額、參戰名單。
 * 對應 `docs/04-military-combat.md` §3d。
 *
 * ★ 這一塊只**報導**，不決定任何事。誰死誰活由伺服器在 `endsAt`
 *   那一刻一次算出來（總帳命定），這裡連結果都還不知道 ——
 *   所以畫面上的動畫不會有人倒下（`losses` 是空的），
 *   兩軍就這麼一直打到結算。那正是「攻擊方全滅或防守方被攻陷」
 *   之前該有的樣子。
 *
 * ★ 倒數走 `useServerClock`：只取客戶端時鐘的**間隔**，
 *   不取它的絕對值（CLAUDE.md 第三條界線）。
 */

import { useServerClock } from "@/components/use-server-clock";

export interface LiveEngagementPanelProps {
  readonly live: {
    readonly isKeep: boolean;
    readonly endsAt: number;
    readonly serverTime: number;
    readonly slots: {
      readonly attacker: { readonly used: number; readonly cap: number };
      readonly defender: { readonly used: number; readonly cap: number };
    };
    readonly roster: readonly {
      readonly side: "ATTACKER" | "DEFENDER";
      readonly name: string;
      readonly mine: boolean;
      readonly population: number;
    }[];
  };
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function SlotPips({ used, cap, tone }: { used: number; cap: number; tone: string }) {
  return (
    <span className="inline-flex gap-0.5 align-middle">
      {Array.from({ length: cap }, (_, i) => (
        <span
          key={i}
          className="inline-block h-2 w-2 rounded-[1px]"
          style={{ background: i < used ? tone : "#3a332e" }}
        />
      ))}
    </span>
  );
}

export function LiveEngagementPanel({ live }: LiveEngagementPanelProps) {
  const now = useServerClock(live.serverTime);
  const left = live.endsAt - now;
  const attackers = live.roster.filter((r) => r.side === "ATTACKER");
  const defenders = live.roster.filter((r) => r.side === "DEFENDER");

  return (
    <section
      data-testid="live-engagement"
      className="mt-3 rounded border border-[#8a6b3a] bg-[#2e2723] p-3 text-xs"
    >
      <header className="flex items-baseline justify-between">
        <span className="font-bold text-[#d9a441]">⚔ 交戰中</span>
        <span className="tabular-nums">
          {left > 0 ? (
            <>
              結算倒數 <b>{mmss(left)}</b>
            </>
          ) : (
            "結算中…"
          )}
        </span>
      </header>

      {/* ★ 名額是這一格的容量上限：一般格子 5 對 5，主城 10 對 10。
          玩家要看得出「還擠不擠得進去」—— 那是要不要現在派兵的依據 */}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[#a35a3a]">
          攻方 {live.slots.attacker.used}/{live.slots.attacker.cap}{" "}
          <SlotPips used={live.slots.attacker.used} cap={live.slots.attacker.cap} tone="#a35a3a" />
        </span>
        <span className="opacity-60">{live.isKeep ? "主城戰場" : "野地戰場"}</span>
        <span className="text-[#4a8fa8]">
          <SlotPips used={live.slots.defender.used} cap={live.slots.defender.cap} tone="#4a8fa8" />{" "}
          {live.slots.defender.used}/{live.slots.defender.cap} 守方
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        {[
          { rows: attackers, title: "攻方", tone: "text-[#a35a3a]" },
          { rows: defenders, title: "守方", tone: "text-[#4a8fa8]" },
        ].map(({ rows, title, tone }) => (
          <div key={title}>
            <div className={`mb-1 ${tone}`}>{title}</div>
            <ul className="space-y-0.5">
              {rows.length === 0 ? <li className="opacity-50">—</li> : null}
              {rows.map((r, i) => (
                <li key={i} className={r.mine ? "text-[#e8dcc0]" : "opacity-75"}>
                  {r.mine ? "★ " : ""}
                  {r.name} · {r.population.toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-2 opacity-60">
        名額沒滿之前，任何人都能派兵加入這一場 —— 中立資源地的攻方名額對所有人開放。
        結算在倒數歸零時一次算完，戰報只有當事人看得到。
      </p>
    </section>
  );
}
