"use client";

/**
 * 賽季登記與封盤預覽。對應 `docs/13` §1–§5。
 *
 * ★ 這個元件不做規則判斷 —— 能不能登記、還剩幾個名額，都由伺服器算好；
 *   按下去之後 Server Action 會**再驗一次**（`registerFor`）。
 *
 * ★ 三個選擇一次做完、送出後不可更改（`docs/13` §2）。
 *   所以送出鈕要問一次 —— 這是整個賽季裡最不可逆的一次點擊。
 */

import { useState, useTransition } from "react";

import type { RegisterResult, SeasonBoard } from "@/app/actions/season";
import { RUIN, SPAWN_BAND, SPAWN_BANDS, type RuinId, type SpawnBand } from "@/lib/game/balance";
import { useServerClock } from "@/components/use-server-clock";

const FACTIONS = [1, 2, 3] as const;

const BAND_BLURB: Record<SpawnBand, string> = {
  VANGUARD: "離自家遺跡最近，也最早撞上遺跡軍團。領土容量 +1。",
  HEARTLAND: "腹地。鄰居最多，發展與衝突都最密集。",
  FRONTIER: "離敵人最近、離自家遺跡最遠。起始資源 ×1.4 是補償，不是獎勵。",
};

const PHASE_LABEL: Record<SeasonBoard["phase"], string> = {
  REGISTRATION: "登記中",
  SEALED: "封盤中",
  RUNNING: "進行中",
  ENDING: "終戰期",
  ARCHIVED: "已封存",
};

const REJECTION_TEXT: Record<string, string> = {
  UNAUTHENTICATED: "請先登入",
  NOT_OPEN: "不在登記期內",
  QUOTA_FULL: "這一格剛好被搶完了 —— 換一個陣營或環帶",
  ALREADY_REGISTERED: "你已經登記過這一場了",
  ALREADY_IN_ANOTHER_SEASON: "你還在另一場賽季裡。同時只能參加一場",
  SQUAD_FULL: "這個小隊代碼已經有 8 個人了",
  SQUAD_MISMATCH: "小隊成員必須同陣營、同環帶",
  BAD_SQUAD_CODE: "代碼要 4–12 個英數字",
  UNKNOWN_FACTION: "沒有這個陣營",
  UNKNOWN_BAND: "沒有這個環帶",
  NOT_FOUND: "找不到這場賽季",
};

function countdown(ms: number): string {
  if (ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${d > 0 ? `${d} 天 ` : ""}${hh}:${mm}:${ss}`;
}

export interface SeasonBoardViewProps {
  readonly board: SeasonBoard;
  readonly onRegister: (input: {
    seasonId: number;
    faction: number;
    band: string;
    squadCode?: string | null;
  }) => Promise<RegisterResult>;
}

export function SeasonBoardView({ board, onRegister }: SeasonBoardViewProps) {
  const now = useServerClock(board.serverTime);
  const [faction, setFaction] = useState<RuinId>(1);
  const [band, setBand] = useState<SpawnBand>("HEARTLAND");
  const [squadCode, setSquadCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const quotaOf = (f: number, b: SpawnBand) =>
    board.quotas.find((q) => q.faction === f && q.band === b);
  const picked = quotaOf(faction, band);
  const remaining = picked ? picked.capacity - picked.taken : 0;

  const open = board.phase === "REGISTRATION";
  const blocked = board.mine !== null || board.lockedElsewhere || !board.signedIn;

  const submit = () => {
    setMessage(null);
    startTransition(async () => {
      const r = await onRegister({
        seasonId: board.seasonId,
        faction,
        band,
        squadCode: squadCode.trim() || null,
      });
      setConfirming(false);
      if (!r.ok) setMessage(REJECTION_TEXT[r.reason ?? ""] ?? (r.reason ?? "登記失敗"));
    });
  };

  return (
    <main className="mx-auto max-w-md px-4 py-6 text-[#e8dcc0]">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">賽季 #{board.seasonId}</h1>
        <span className="rounded bg-[#4a413a] px-2 py-0.5 text-xs">
          {PHASE_LABEL[board.phase]}
        </span>
      </header>

      <PhaseClock board={board} now={now} />

      {board.mine ? (
        <MyCard board={board} />
      ) : board.lockedElsewhere ? (
        <p className="mt-4 rounded border border-[#8a6b3a] bg-[#2e2723] p-3 text-sm">
          你還在另一場賽季裡。一位領主同時只能在一張地圖上 ——
          等那一場結束後就能報名下一場。
        </p>
      ) : !board.signedIn ? (
        <p className="mt-4 rounded bg-[#2e2723] p-3 text-sm opacity-80">登入後才能登記。</p>
      ) : null}

      {/* ── 名額表：熱門陣營先滿是設計的一部分 ─────────────── */}
      <section className="mt-6">
        <h2 className="text-sm font-bold opacity-70">名額（{board.humanCount} 位真人已登記）</h2>
        <table className="mt-2 w-full border-collapse text-xs">
          <thead>
            <tr className="text-left opacity-60">
              <th className="py-1">陣營</th>
              {SPAWN_BANDS.map((b) => (
                <th key={b} className="py-1 text-right">
                  {SPAWN_BAND[b].label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FACTIONS.map((f) => (
              <tr key={f} className="border-t border-[#4a413a]">
                <td className="py-1.5">{RUIN[f].factionName}</td>
                {SPAWN_BANDS.map((b) => {
                  const q = quotaOf(f, b);
                  const left = q ? q.capacity - q.taken : 0;
                  return (
                    <td
                      key={b}
                      className={`py-1.5 text-right tabular-nums ${left === 0 ? "opacity-40" : ""}`}
                    >
                      {left} / {q?.capacity ?? 0}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] opacity-50">
          開賽時一定是 600 人 —— 沒有人登記的位置由 AI 領主補上，地理上完全平等。
        </p>
      </section>

      {open && !blocked && (
        <section className="mt-6 space-y-4">
          <h2 className="text-sm font-bold opacity-70">三個選擇，送出後不可更改</h2>

          <div>
            <p className="text-xs opacity-60">陣營</p>
            <div className="mt-1 grid grid-cols-3 gap-1">
              {FACTIONS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFaction(f)}
                  className={`rounded px-2 py-2 text-xs ${
                    faction === f ? "bg-[#8a6b3a]" : "bg-[#2e2723] hover:bg-[#4a413a]"
                  }`}
                >
                  <span className="block font-bold">{RUIN[f].factionName}</span>
                  <span className="block opacity-70">{RUIN[f].buffLabel}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs opacity-60">出生環帶</p>
            <div className="mt-1 space-y-1">
              {SPAWN_BANDS.map((b) => {
                const q = quotaOf(faction, b);
                const left = q ? q.capacity - q.taken : 0;
                return (
                  <button
                    key={b}
                    type="button"
                    disabled={left === 0}
                    onClick={() => setBand(b)}
                    className={`block w-full rounded px-3 py-2 text-left text-xs disabled:opacity-30 ${
                      band === b ? "bg-[#8a6b3a]" : "bg-[#2e2723] hover:bg-[#4a413a]"
                    }`}
                  >
                    <span className="flex justify-between font-bold">
                      <span>{SPAWN_BAND[b].label}</span>
                      <span className="tabular-nums">剩 {left}</span>
                    </span>
                    <span className="mt-0.5 block opacity-70">{BAND_BLURB[b]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-xs opacity-60">同行小隊代碼（可留空）</p>
            <input
              value={squadCode}
              onChange={(e) => setSquadCode(e.target.value.toUpperCase())}
              maxLength={12}
              placeholder="例如 PALS"
              className="mt-1 w-full rounded bg-[#2e2723] px-3 py-2 text-sm tracking-widest"
            />
            <p className="mt-1 text-[11px] opacity-50">
              最多 8 人共用同一組代碼，會被放在相隔 8–15 格的群集裡。
              成員必須選同一個陣營與環帶。
            </p>
          </div>

          {message && (
            <p className="rounded border border-[#8a6b3a] bg-[#2e2723] p-2 text-xs">{message}</p>
          )}

          {confirming ? (
            <div className="rounded border border-[#8a6b3a] bg-[#2e2723] p-3 text-xs">
              <p>
                確定登記 <b>{RUIN[faction].factionName}</b> ·{" "}
                <b>{SPAWN_BAND[band].label}</b>
                {squadCode.trim() ? ` · 小隊 ${squadCode.trim()}` : ""}？
              </p>
              <p className="mt-1 opacity-70">送出之後不能更改，也不能退出。</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={submit}
                  className="flex-1 rounded bg-[#8a6b3a] py-2 font-bold disabled:opacity-50"
                >
                  {pending ? "送出中…" : "確定"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="flex-1 rounded bg-[#4a413a] py-2"
                >
                  再想想
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={remaining === 0}
              onClick={() => setConfirming(true)}
              className="w-full rounded bg-[#8a6b3a] py-3 font-bold disabled:opacity-40"
            >
              {remaining === 0 ? "這一格已額滿" : "登記"}
            </button>
          )}
        </section>
      )}

      {board.ruins.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-bold opacity-70">三座遺跡</h2>
          <ul className="mt-2 space-y-1 text-xs">
            {board.ruins.map((r) => (
              <li key={r.id} className="flex justify-between rounded bg-[#2e2723] px-3 py-1.5">
                <span>{RUIN[r.id as RuinId]?.name ?? `遺跡 ${r.id}`}</span>
                <span className="tabular-nums opacity-70">
                  ({r.x}, {r.y})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <FairnessCard report={board.fairness} />
    </main>
  );
}

/** 下一個階段還有多久。★ 只取客戶端時鐘的間隔，不取它的絕對值 */
function PhaseClock({ board, now }: { board: SeasonBoard; now: number }) {
  const next =
    board.phase === "REGISTRATION"
      ? { label: "登記截止", at: board.registrationClosesAt }
      : board.phase === "SEALED"
        ? { label: "全員同時進入", at: board.startsAt }
        : board.phase === "RUNNING"
          ? { label: "賽季結束", at: board.endsAt }
          : null;

  return (
    <div className="mt-3 rounded bg-[#2e2723] px-3 py-2 text-xs">
      {next ? (
        <p className="flex justify-between">
          <span className="opacity-70">{next.label}</span>
          <span className="font-bold tabular-nums">{countdown(next.at - now)}</span>
        </p>
      ) : (
        <p className="opacity-70">這場賽季已經結束了。</p>
      )}
      {board.phase === "RUNNING" && (
        <p className="mt-1 opacity-60">目前是第 {board.gameMonth} 月（一個真實日 = 一個月）</p>
      )}
    </div>
  );
}

function MyCard({ board }: { board: SeasonBoard }) {
  const mine = board.mine!;
  return (
    <section className="mt-4 rounded border border-[#8a6b3a] bg-[#2e2723] p-3 text-sm">
      <p className="font-bold">
        你已登記：{RUIN[mine.faction].factionName} · {SPAWN_BAND[mine.band].label}
        {mine.squadCode ? ` · 小隊 ${mine.squadCode}` : ""}
      </p>
      {mine.assignedX !== null && mine.assignedY !== null ? (
        <p className="mt-1 text-xs">
          出生點 <b className="tabular-nums">({mine.assignedX}, {mine.assignedY})</b>
          {mine.playerId === null && " —— 開賽時據點會出現在這裡"}
        </p>
      ) : (
        <p className="mt-1 text-xs opacity-70">
          出生點在封盤期公布。你會在開戰前 12 小時就知道自己生在哪、鄰居是誰。
        </p>
      )}
    </section>
  );
}

interface FairnessCheck {
  readonly key: string;
  readonly label: string;
  readonly pass: boolean;
  readonly actual: number;
  readonly threshold: number;
  readonly format: string;
}

/**
 * ★ 公平性數字是**公開**的（`docs/13` §3）。
 *   全員同時進入代表任何不公平都會在第一天被攤在論壇上比較 ——
 *   與其被質疑，不如先把數字放出來。
 */
function FairnessCard({ report }: { report: unknown }) {
  const checks = (report as { checks?: FairnessCheck[] } | null)?.checks;
  if (!checks?.length) return null;

  const fmt = (c: FairnessCheck) =>
    c.format === "percent" ? `${(c.actual * 100).toFixed(1)}%` : c.actual.toFixed(1);
  const limit = (c: FairnessCheck) =>
    c.format === "percent" ? `${(c.threshold * 100).toFixed(0)}%` : String(c.threshold);

  return (
    <section className="mt-6">
      <h2 className="text-sm font-bold opacity-70">公平性驗證</h2>
      <ul className="mt-2 space-y-1 text-xs">
        {checks.map((c) => (
          <li key={c.key} className="flex items-baseline justify-between gap-2 rounded bg-[#2e2723] px-3 py-1.5">
            <span className="opacity-80">{c.label}</span>
            <span className="shrink-0 tabular-nums">
              <b className={c.pass ? "" : "text-[#d08a4a]"}>{fmt(c)}</b>
              <span className="opacity-50"> / {limit(c)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
