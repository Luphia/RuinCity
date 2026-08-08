/**
 * 交戰：一格上的多方會戰。純函式，無 I/O。
 * 對應 docs/04-military-combat.md §3d。
 *
 * 舊模型是「一支行軍抵達 → 當場算完 → 寫戰報」。新模型是：
 *
 *   抵達 → **加入這一格的交戰**（沒有就開一場）→ 兩分鐘後一起結算
 *
 * 於是三件事同時成立：
 *
 *   1. 戰鬥有**持續時間**，任何人都能在這段時間打開那一格看動畫
 *   2. 一格能塞**多支**部隊（5 對 5，主城 10 對 10），援軍來得及趕到
 *   3. 中立資源地的攻方名額對**所有人**開放 —— 大家在同一場仗裡競爭
 *
 * 這一層只回答「誰能進場」與「總帳怎麼分回每個人身上」。
 * 誰輸誰贏仍然由 `combat.ts` 的 `resolveBattle` 決定（總帳命定），
 * 畫面由 `battlefield.ts` 演（移動自主）—— 那條分界沒有改變。
 */

import { BATTLE_SLOTS } from "./balance";
import { mergeArmies, type Army } from "./army";
import { armyPopulation } from "./formulas";

export type Side = "ATTACKER" | "DEFENDER";

/** 這一格的容量：主城比一般格子大一倍 */
export function slotsFor(isKeep: boolean): { attacker: number; defender: number } {
  return isKeep ? BATTLE_SLOTS.keep : BATTLE_SLOTS.tile;
}

export interface Participant {
  readonly playerId: number;
  readonly side: Side;
  readonly army: Army;
}

export type JoinRejection = "SLOTS_FULL";

/**
 * 這支部隊進得了場嗎。
 *
 * ★ 一位玩家可以佔**多個**名額（派兩支部隊就是兩支），
 *   因為名額算的是**部隊**不是人 —— 戰場擺得下幾支就是幾支。
 *   若改成「一人一格」，五個人聯手圍城時反而比一個人分五批更弱，
 *   那會鼓勵所有人用小號洗名額。
 */
export function canJoin(
  current: readonly Participant[],
  side: Side,
  isKeep: boolean,
): true | JoinRejection {
  const cap = slotsFor(isKeep)[side === "ATTACKER" ? "attacker" : "defender"];
  const used = current.filter((p) => p.side === side).length;
  return used < cap ? true : "SLOTS_FULL";
}

/** 某一方目前佔了幾個名額 / 還剩幾個 */
export function slotUsage(
  current: readonly Participant[],
  isKeep: boolean,
): { attacker: { used: number; cap: number }; defender: { used: number; cap: number } } {
  const cap = slotsFor(isKeep);
  return {
    attacker: {
      used: current.filter((p) => p.side === "ATTACKER").length,
      cap: cap.attacker,
    },
    defender: {
      used: current.filter((p) => p.side === "DEFENDER").length,
      cap: cap.defender,
    },
  };
}

/** 一方的總兵力（結算時餵給 `resolveBattle` 的那一份） */
export function sideArmy(current: readonly Participant[], side: Side): Army {
  return current
    .filter((p) => p.side === side)
    .reduce<Army>((acc, p) => mergeArmies(acc, p.army), {});
}

/**
 * ★ 把「一方的總損失」按各自的出兵比例分回每一位參戰者身上。
 *
 * 用 largest-remainder 分整數，保證**分回去的總和恰好等於總帳** ——
 * 逐一四捨五入會漏掉或多出幾個人，而那幾個人是憑空生滅的士兵。
 *
 * 比例以**兵種為單位**算：你派的是投石機，就只會賠投石機。
 * 用總人口當分母的話，帶器械的人會替別人賠掉步兵。
 */
export function distributeLosses(
  participants: readonly Participant[],
  side: Side,
  totalLosses: Army,
): Map<number, Army> {
  const mine = participants
    .map((p, index) => ({ p, index }))
    .filter(({ p }) => p.side === side);

  const out = new Map<number, Army>();
  for (const { index } of mine) out.set(index, {});
  if (mine.length === 0) return out;

  for (const [unit, lost] of Object.entries(totalLosses) as [keyof Army, number][]) {
    if (!lost || lost <= 0) continue;
    const pool = mine.map(({ p, index }) => ({ index, have: p.army[unit] ?? 0 }));
    const total = pool.reduce((s, x) => s + x.have, 0);
    if (total <= 0) continue;

    const exact = pool.map((x) => ({ ...x, want: (x.have * lost) / total }));
    const floors = exact.map((x) => ({ ...x, base: Math.min(x.have, Math.floor(x.want)) }));
    let assigned = floors.reduce((s, x) => s + x.base, 0);

    // 餘數依「小數部分大的先拿」補足，且永遠不超過自己帶的數量
    const byRemainder = [...floors].sort(
      (a, b) => b.want - b.base - (a.want - a.base) || a.index - b.index,
    );
    let i = 0;
    while (assigned < Math.min(lost, total) && byRemainder.length > 0) {
      const row = byRemainder[i % byRemainder.length]!;
      if (row.base < row.have) {
        row.base++;
        assigned++;
      } else if (byRemainder.every((r) => r.base >= r.have)) {
        break;
      }
      i++;
    }

    for (const row of floors) {
      if (row.base <= 0) continue;
      const cur = out.get(row.index)!;
      cur[unit] = (cur[unit] ?? 0) + row.base;
    }
  }
  return out;
}

/**
 * 掠奪／戰利品的分配：按**存活兵力**的比例。
 *
 * ★ 用存活而不是出兵：死光的那一支沒有人搬得動東西。
 *   這也讓「最後一刻插一腳」不會白拿 —— 你得留得下人。
 */
export function distributeSpoils(
  survivorsByIndex: ReadonlyMap<number, Army>,
  total: number,
): Map<number, number> {
  const weights = [...survivorsByIndex].map(([index, army]) => ({
    index,
    w: armyPopulation(army),
  }));
  const sum = weights.reduce((s, x) => s + x.w, 0);
  const out = new Map<number, number>();
  for (const { index } of weights) out.set(index, 0);
  if (sum <= 0 || total <= 0) return out;

  let given = 0;
  const exact = weights.map((x) => ({ ...x, want: (x.w * total) / sum }));
  for (const row of exact) {
    const v = Math.floor(row.want);
    out.set(row.index, v);
    given += v;
  }
  // 餘數給小數部分最大的那幾位
  const rest = [...exact].sort((a, b) => b.want - Math.floor(b.want) - (a.want - Math.floor(a.want)));
  let i = 0;
  while (given < total && rest.length > 0) {
    const row = rest[i % rest.length]!;
    out.set(row.index, (out.get(row.index) ?? 0) + 1);
    given++;
    i++;
  }
  return out;
}
