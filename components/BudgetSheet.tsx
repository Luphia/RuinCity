/**
 * 預算書：每一分錢花在哪裡、怎麼算的。
 * 施工中與完成後共用 —— 完成後「實際」欄就是決算。
 */

import type { BlockView } from "@/lib/server/view";

export function BudgetSheet({ budget, total }: { budget: BlockView["budget"]; total: string }) {
  return (
    <section data-testid="budget-sheet" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold">預算書</h2>
        <span className="text-ash text-xs">預計＝已發生的實際 ＋ 未發生的估計</span>
      </div>
      <div className="border-ink-mid overflow-x-auto rounded border">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="bg-ink-soft text-ash text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-normal">項目</th>
              <th className="px-3 py-2 text-right font-normal">預計 Token</th>
              <th className="px-3 py-2 text-right font-normal">預計</th>
              <th className="px-3 py-2 text-right font-normal">實際</th>
            </tr>
          </thead>
          {budget.filter((g) => g.group !== "surplus").map((g) => (
            <tbody key={g.group} className="border-ink-mid border-t">
              <tr>
                <td colSpan={4} className="text-moss px-3 pb-1 pt-3 text-xs font-bold">
                  {g.groupLabel}
                </td>
              </tr>
              {g.lines.map((l) => (
                <tr key={l.key} className="align-top">
                  <td className="px-3 py-1.5">
                    <div>{l.label}</div>
                    <div className="text-ash-deep mt-0.5 text-xs leading-relaxed">{l.basis}</div>
                  </td>
                  <td className="text-ash whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                    {l.tokensProjected ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{l.projected.twd}</td>
                  <td className="text-ash whitespace-nowrap px-3 py-1.5 text-right tabular-nums">
                    {l.actual.micros > 0 ? l.actual.twd : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot className="border-ink-mid border-t">
            <tr>
              <td className="px-3 py-2 font-bold" colSpan={2}>
                完成這一塊所需的募款總額
              </td>
              <td className="px-3 py-2 text-right font-bold tabular-nums" data-testid="budget-total">
                {total}
              </td>
              <td />
            </tr>
            {budget
              .filter((g) => g.group === "surplus")
              .flatMap((g) => g.lines)
              .map((l) => (
                <tr key={l.key} className="text-moss align-top">
                  <td className="px-3 py-1.5" colSpan={2}>
                    <div>{l.label}（已募得超過所需的部分）</div>
                    <div className="text-ash-deep mt-0.5 text-xs leading-relaxed">{l.basis}</div>
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
