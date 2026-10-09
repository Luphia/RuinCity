/**
 * 預算書：每一分錢花在哪裡、怎麼算的。
 * 施工中與完成後共用 —— 完成後「實際」欄就是決算。
 */

import type { BlockView } from "@/lib/server/view";

import { CardTitle, IconLedger, glass } from "./hud";

export function BudgetSheet({ budget, total }: { budget: BlockView["budget"]; total: string }) {
  return (
    <section data-testid="budget-sheet" className={`${glass} flex flex-col gap-3 p-5`}>
      <CardTitle icon={<IconLedger />} aside="預計＝已發生的實際 ＋ 未發生的估計">
        預算書
      </CardTitle>
      <div className="overflow-x-auto rounded-xl border border-white/10 bg-slate-950/30">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="bg-white/[0.05] text-xs text-white/55">
            <tr>
              <th className="px-3 py-2 text-left font-normal">項目</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-normal">預計 Token</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-normal">預計</th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-normal">實際</th>
            </tr>
          </thead>
          {budget.filter((g) => g.group !== "surplus").map((g) => (
            <tbody key={g.group} className="border-t border-white/10">
              <tr>
                <td colSpan={4} className="px-3 pb-1 pt-3 text-[11px] uppercase tracking-[0.18em] text-sky-200/80">
                  {g.groupLabel}
                </td>
              </tr>
              {g.lines.map((l) => (
                <tr key={l.key} className="align-top">
                  <td className="px-3 py-1.5 text-white">
                    <div>{l.label}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-white/45">{l.basis}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-white/60">
                    {l.tokensProjected ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-white">{l.projected.twd}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-white/60">
                    {l.actual.micros > 0 ? l.actual.twd : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot className="border-t border-white/15 bg-white/[0.04]">
            <tr>
              <td className="px-3 py-2.5 font-semibold text-white" colSpan={2}>
                完成這一塊所需的募款總額
              </td>
              <td className="px-3 py-2.5 text-right text-base font-semibold tabular-nums text-white" data-testid="budget-total">
                {total}
              </td>
              <td />
            </tr>
            {budget
              .filter((g) => g.group === "surplus")
              .flatMap((g) => g.lines)
              .map((l) => (
                <tr key={l.key} className="align-top text-emerald-200">
                  <td className="px-3 py-1.5" colSpan={2}>
                    <div>{l.label}（已募得超過所需的部分）</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-white/45">{l.basis}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{l.projected.twd}</td>
                  <td />
                </tr>
              ))}
          </tfoot>
        </table>
      </div>
    </section>
  );
}
