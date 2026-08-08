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

// ─────────────────────────────────────────────────────────────
// 中立野地的混戰（docs/04 §3d）
// ─────────────────────────────────────────────────────────────

export interface MeleeParty {
  /** `participants` 裡的索引，用來把結果對回去 */
  readonly index: number;
  readonly army: Army;
}

export interface MeleeDuel {
  readonly holder: number;
  readonly challenger: number;
  readonly winner: number | null;
  readonly holderSurvivors: Army;
  readonly challengerSurvivors: Army;
}

export interface MeleeResult {
  /** 站到最後的那一位（全部同歸於盡就是 null） */
  readonly winner: number | null;
  readonly survivors: ReadonlyMap<number, Army>;
  readonly duels: readonly MeleeDuel[];
}

/**
 * ★ 中立野地：清完守衛之後，攻方**彼此開打**。
 *
 * 「同一場仗、同一批守衛，三方混戰，存活到最後的拿走那塊地。」
 *
 * ## 為什麼是接力而不是所有人同時互毆
 *
 * 「每一方對上其餘所有人的合計」在數學上很誘人，但三方兵力相近時
 * 每個人都要面對兩倍的敵人 → 一輪之後**全部歸零**。
 * 那不是混戰，那是同歸於盡，而且是常態不是意外。
 *
 * 所以混戰是一串**依抵達順序**的對決：先站上那塊地的人是**守方**，
 * 後到的一個一個上來挑戰。這條規則有三個好處：
 *
 *   1. 只用一個戰鬥引擎（`resolveBattle` 呼叫 N 次），總帳仍然命定
 *   2. 順序是決定性的（`joinedAt`），不需要擲骰
 *   3. 產生真的故事：兩強相爭到兩敗俱傷，第三個到的人走上去把旗插了
 *
 * 守方沒有城牆、沒有固有防禦 —— 大家都只是站在一塊空地上。
 *
 * @param parties 依抵達順序排好的各方（已經是清完守衛之後的殘部）
 * @param duel    打一場：回傳雙方的存活。注入是為了讓這一層仍然是純的，
 *                而且測試可以餵一個可預測的結果
 */
export function resolveMelee(
  parties: readonly MeleeParty[],
  duel: (holder: Army, challenger: Army) => { holder: Army; challenger: Army },
): MeleeResult {
  const alive = parties.filter((p) => armyPopulation(p.army) > 0);
  const survivors = new Map<number, Army>(parties.map((p) => [p.index, p.army]));
  const duels: MeleeDuel[] = [];

  if (alive.length <= 1) {
    return { winner: alive[0]?.index ?? null, survivors, duels };
  }

  // 先到的人站上去，後到的一個一個挑戰
  let holder: MeleeParty | null = alive[0]!;
  for (const challenger of alive.slice(1)) {
    if (!holder) {
      // 上一場兩敗俱傷 → 這一位直接接手（不戰而得，故事的一部分）
      holder = challenger;
      continue;
    }
    const r = duel(holder.army, challenger.army);
    survivors.set(holder.index, r.holder);
    survivors.set(challenger.index, r.challenger);
    duels.push({
      holder: holder.index,
      challenger: challenger.index,
      winner:
        armyPopulation(r.holder) > 0
          ? holder.index
          : armyPopulation(r.challenger) > 0
            ? challenger.index
            : null,
      holderSurvivors: r.holder,
      challengerSurvivors: r.challenger,
    });

    if (armyPopulation(r.holder) > 0) {
      holder = { index: holder.index, army: r.holder };
    } else if (armyPopulation(r.challenger) > 0) {
      holder = { index: challenger.index, army: r.challenger };
    } else {
      holder = null; // 兩敗俱傷，下一位不戰而得
    }
  }

  return {
    winner: holder && armyPopulation(holder.army) > 0 ? holder.index : null,
    survivors,
    duels,
  };
}
