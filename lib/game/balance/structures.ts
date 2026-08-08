/**
 * 領地建物與要塞路網。
 * 對應 docs/02-base-territory.md §2.6 與 docs/04-military-combat.md §2.5、§5。
 *
 * 這一組數值回答兩個問題：
 *
 *   1. **一格領地要怎麼樣才會易主** —— 打掉站在上面的軍隊還不夠，
 *      還要把那面旗（或石塔）拆掉。而「拆」是器械的工作：
 *      一般部隊對建物一次只有 1 點傷害。
 *   2. **自己的地盤上跑得比較快** —— 要塞與要塞之間、主城 8 格以內，
 *      行軍速度 ×4。地圖放大到 900×900 之後，
 *      「經營自己的路網」才是把大地圖變成可用縱深的方法。
 */

import type { Unit } from "./units";

// ─────────────────────────────────────────────────────────────
// 領地建物：旗 → 石塔 → 主城
// ─────────────────────────────────────────────────────────────

export const STRUCTURES = ["FLAG", "TOWER", "KEEP"] as const;
export type StructureKind = (typeof STRUCTURES)[number];

export interface StructureSpec {
  readonly label: string;
  /**
   * 耐久 = `hpBase + hpPerLevel × 等級`。
   * 旗沒有等級（等級恆 0）；石塔吃要塞等級；主城吃主堡等級。
   */
  readonly hpBase: number;
  readonly hpPerLevel: number;
}

/**
 * ★ 數字的意義（以「一般部隊 1 點傷害」為尺）：
 *
 * - **領地旗 300**：300 名普通兵一波剛好拆得掉 —— 沒有器械也搶得到地，
 *   但要付出一整支部隊的行程。帶 8 台攻城車（8 × 40 = 320）則是一趟的事。
 * - **要塞石塔 600 + 600×Lv**：Lv1 就是 1,200，一般部隊得來三、四波；
 *   而 20 台投石機（20 × 60 = 1,200）一趟拆完。**要塞的意義是逼對方帶器械**。
 * - **主城 400×Lv**：Lv20 是 8,000 —— 破城是一次戰役級的行動，
 *   不是順手做得到的事。
 */
export const STRUCTURE: Record<StructureKind, StructureSpec> = {
  FLAG: { label: "領地旗", hpBase: 300, hpPerLevel: 0 },
  TOWER: { label: "要塞石塔", hpBase: 600, hpPerLevel: 600 },
  KEEP: { label: "主城", hpBase: 0, hpPerLevel: 400 },
} as const;

/**
 * 對建物的傷害。**與部隊的攻擊力完全脫鉤** —— 這是刻意的：
 * 建物不是「防禦力很高的部隊」，它是另一種東西。
 *
 * 一般部隊每人 1 點；只有器械算得上攻城武器。
 * 少了這條規則，「要塞」只是一個比較大的數字，
 * 帶著三千名劍士照樣可以把它輾過去 —— 那樣器械就沒有存在的理由。
 */
export const STRUCTURE_DAMAGE = {
  /** 非器械單位每人每波的傷害 */
  nonSiegePerSoldier: 1,
  /** 器械單位每台每波的傷害 */
  siegePerSoldier: { RAM: 40, CATAPULT: 60 } as Partial<Record<Unit, number>>,
  /**
   * 工坊的攻城加成同樣作用在拆建物上（與 `resolveBattle` 的 `siegeBonus` 同一個值）。
   * 沒有這一條的話，工坊只影響野戰的攻城傷害，玩家會覺得它「升了沒感覺」。
   */
  workshopAppliesToStructures: true,
} as const;

/**
 * 建物修復：沒被打的時候自己長回來。
 *
 * ★ 少了這一條，「一般部隊 1 點傷害」會被時間繞過去 ——
 *   每天派一支小隊敲幾百點，一週之後石塔自己就倒了。
 *   回復速度刻意訂成「一天內回滿一座 Lv1 石塔」：
 *   持續施壓仍然有效，零星騷擾則追不上。
 */
export const STRUCTURE_REPAIR = {
  /** 每真實小時回復的耐久 */
  hpPerHour: 50,
} as const;

// ─────────────────────────────────────────────────────────────
// 要塞路網
// ─────────────────────────────────────────────────────────────

/**
 * 行軍加速：起點與終點**都**在自己的路網上時，速度 ×4。
 *
 * 兩種節點：
 * - **要塞**：那一格本身（半徑 0）。要塞之間因此形成一條條驛道。
 * - **主城**：周圍 `citadelRadius` 格（切比雪夫）。
 *   8 格不是隨手挑的 —— 它剛好是 `PLAYER_MIN_SPACING`，
 *   也就是**保證只屬於你一個人**的那一圈（`docs/11` §22.1）。
 *   於是「主城周邊調度」永遠是快的，而那圈之外要靠要塞去鋪。
 */
export const ROAD = {
  speedMultiplier: 4,
  citadelRadius: 8,
  fortressRadius: 0,
} as const;
