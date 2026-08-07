"use client";

/**
 * 戰報詳情：**完整的計算過程**（`docs/10` M3）。
 *
 * ★ 玩家算得出來的數字才有討論的餘地。
 *   「為什麼我輸了」是這類遊戲裡最常見、也最該被回答的問題 ——
 *   把 `breakdown` 逐行攤開，答案就在畫面上，不需要去論壇問。
 */

import { UNIT, type Unit } from "@/lib/game/balance";
import type { ReportView } from "@/app/actions/war";

const RESOURCE_LABEL: Record<string, string> = {
  grain: "糧",
  timber: "木",
  stone: "石",
  iron: "鐵",
};

export function BattleReportCard({ report }: { report: ReportView }) {
  const s = report.snapshot as Record<string, unknown>;

  if (s.kind === "SCOUT") return <ScoutBody snapshot={s} />;
  if (s.kind !== "BATTLE") {
    return <Frame>這份戰報的格式無法解析。</Frame>;
  }

  const attacker = s.attacker as { sent: Army; losses: Army };
  const defender = s.defender as { present: Army; losses: Army; wounded: Army };
  const loot = (s.loot ?? {}) as Record<string, number>;
  const raid = s.raid as {
    lossMultiplier: number;
    decay: number;
    priorRaids: number;
  } | null;
  /**
   * ★ `breakdown` 是從 jsonb 讀回來的 —— 舊戰報可能缺欄位。
   *   缺的顯示成「—」，不要讓一份三天前的戰報把整頁炸掉。
   */
  const raw = (s.breakdown ?? {}) as Record<string, number | undefined>;
  const b = (k: string): number | undefined =>
    typeof raw[k] === "number" ? raw[k] : undefined;

  return (
    <Frame>
      <Section title="兵力">
        <Row label="攻方派出" value={armyText(attacker.sent)} />
        <Row label="攻方陣亡" value={armyText(attacker.losses)} tone="bad" />
        <Row label="守方在場" value={armyText(defender.present)} />
        <Row label="守方陣亡" value={armyText(defender.losses)} tone="bad" />
        {Object.keys(defender.wounded ?? {}).length > 0 ? (
          <Row
            label="守方傷兵（醫療帳）"
            value={armyText(defender.wounded)}
            tone="good"
          />
        ) : null}
      </Section>

      <Section title="攻方戰力">
        <Row label="基礎攻擊力" value={num(b("attackerBasePower"))} />
        <Row label="科技與遺跡加成後" value={num(b("attackerAfterTech"))} />
        <Row
          label="士氣係數"
          value={ratio(b("morale"))}
          note={
            (b("morale") ?? 1) < 1
              ? "大打小 —— 戰力與掠奪量同時被折"
              : undefined
          }
        />
        <Row label="士氣後" value={num(b("attackerAfterMorale"))} />
        {(b("noSiegeMultiplier") ?? 1) < 1 ? (
          <Row
            label="無攻城單位打城牆"
            value={ratio(b("noSiegeMultiplier"))}
            tone="bad"
            note="沒有攻城器械就別想拆牆"
          />
        ) : null}
        <Row label="最終戰力" value={num(b("attackerFinalPower"))} strong />
      </Section>

      <Section title="守方戰力">
        <Row label="部隊防禦力" value={num(b("defenderUnitPower"))} />
        <Row
          label="騎兵佔比（決定用哪種防禦）"
          value={percent(b("cavalryWeight"))}
        />
        <Row label="城牆後" value={num(b("defenderAfterWall"))} />
        <Row label="地形後" value={num(b("defenderAfterTerrain"))} />
        <Row label="科技後" value={num(b("defenderAfterTech"))} />
        <Row
          label="固定防禦（固有 + 哨塔）"
          value={num(b("defenderFlatDefense"))}
          note="早期固有防禦不是「擊退」，是讓交換比貴到不值得"
        />
        <Row label="最終戰力" value={num(b("defenderFinalPower"))} strong />
      </Section>

      <Section title="結果">
        <Row label="戰力比" value={b("powerRatio")?.toFixed(3) ?? "—"} />
        <Row
          label="人口"
          value={`${num(b("attackerPopulation"))} vs ${num(b("defenderPopulation"))}`}
        />
        <Row
          label="計入賽季積分"
          value={s.scoring ? "是" : "否（大打小不計分）"}
        />
        {raid ? (
          <>
            <Row label="突襲損失折扣" value={`×${raid.lossMultiplier}`} />
            <Row
              label="重複劫掠遞減"
              value={`×${raid.decay.toFixed(3)}`}
              note={`6 小時內第 ${raid.priorRaids + 1} 次`}
            />
          </>
        ) : null}
        <Row
          label="掠奪"
          value={
            Object.entries(loot)
              .filter(([, v]) => v > 0)
              .map(([r, v]) => `${RESOURCE_LABEL[r] ?? r}${Math.floor(v)}`)
              .join(" ") || "無"
          }
          tone="good"
        />
      </Section>
    </Frame>
  );
}

function ScoutBody({ snapshot }: { snapshot: Record<string, unknown> }) {
  const report = snapshot.report as {
    success: boolean;
    army: Army | null;
    resources: Record<string, number> | null;
    citadelLevel: number | null;
    wallLevel: number | null;
  };

  if (!report?.success) {
    return (
      <Frame>
        <p className="opacity-80">偵查兵全滅，什麼都沒帶回來。</p>
        <p className="mt-1 text-[10px] opacity-60">
          對方只知道「有人偵查你」，不知道是誰。
        </p>
      </Frame>
    );
  }

  return (
    <Frame>
      <Section title="守軍（±10% 誤差）">
        <Row label="部隊" value={armyText(report.army ?? {})} />
      </Section>
      <Section title="資源（±15% 誤差）">
        <Row
          label="庫存"
          value={Object.entries(report.resources ?? {})
            .map(([r, v]) => `${RESOURCE_LABEL[r] ?? r}${v}`)
            .join(" ")}
        />
      </Section>
      <Section title="建築（精確）">
        <Row label="主堡" value={`Lv${report.citadelLevel}`} />
        <Row
          label="城牆"
          value={report.wallLevel ? `Lv${report.wallLevel}` : "無"}
        />
      </Section>
    </Frame>
  );
}

type Army = Partial<Record<Unit, number>>;

function armyText(army: Army): string {
  const parts = Object.entries(army)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([u, n]) => `${UNIT[u as Unit].label}${n}`);
  return parts.length > 0 ? parts.join(" ") : "無";
}

const num = (v: number | undefined) =>
  v === undefined ? "—" : Math.round(v).toLocaleString();
const ratio = (v: number | undefined) =>
  v === undefined ? "—" : `×${v.toFixed(3)}`;
const percent = (v: number | undefined) =>
  v === undefined ? "—" : `${(v * 100).toFixed(0)}%`;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="battle-report-detail"
      className="mt-1 space-y-2 rounded border border-[#4a413a] bg-[#231e1b] p-3 text-[11px]"
    >
      {children}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 font-bold opacity-80">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  note,
  tone,
  strong,
}: {
  label: string;
  value: string | undefined;
  note?: string;
  tone?: "good" | "bad";
  strong?: boolean;
}) {
  const colour =
    tone === "good" ? "text-[#7a9a5a]" : tone === "bad" ? "text-[#c4442f]" : "";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="opacity-60">
        {label}
        {note ? <span className="ml-1 opacity-70">— {note}</span> : null}
      </span>
      <span
        className={`shrink-0 tabular-nums ${colour} ${strong ? "font-bold" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}
