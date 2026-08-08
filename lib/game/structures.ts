/**
 * 領地建物（旗／石塔／主城）與要塞路網。純函式，無 I/O。
 * 對應 docs/02-base-territory.md §2.6 與 docs/04-military-combat.md §2.5、§5。
 *
 * 這一層回答三件事，而且**全部是伺服器的真相**：
 *
 *   1. 這一格的建物有多少耐久（`structureOf` / `maxHpOf`）
 *   2. 一支部隊一波能打掉多少（`structureDamage`）—— 一般部隊 1 點，器械才算數
 *   3. 兩點之間吃不吃得到路網加速（`roadMultiplier`）
 */

import {
  ROAD,
  STRUCTURE,
  STRUCTURE_DAMAGE,
  STRUCTURE_REPAIR,
  type StructureKind,
  type Unit,
} from "./balance";

export type { StructureKind };

// ─────────────────────────────────────────────────────────────
// 建物
// ─────────────────────────────────────────────────────────────

/** 一格上站著什麼建物：主城 > 要塞石塔 > 領地旗 */
export function structureOf(input: {
  isBase?: boolean;
  facility?: string | null;
}): StructureKind {
  if (input.isBase) return "KEEP";
  return input.facility === "FORTRESS" ? "TOWER" : "FLAG";
}

/** 建物滿血耐久。旗吃不到等級；石塔吃要塞等級；主城吃主堡等級 */
export function maxHpOf(kind: StructureKind, level = 0): number {
  const spec = STRUCTURE[kind];
  return spec.hpBase + spec.hpPerLevel * Math.max(0, level);
}

/**
 * 一支部隊**一波**能對建物造成多少傷害。
 *
 * ★ 與 `resolveBattle` 的戰力完全脫鉤 —— 建物不是「防禦力很高的部隊」。
 *   一般部隊每人 1 點；只有器械算得上攻城武器（`STRUCTURE_DAMAGE`）。
 *   工坊的攻城加成同樣作用在這裡，否則玩家會覺得工坊「升了沒感覺」。
 */
export function structureDamage(
  army: Partial<Record<Unit, number>>,
  opts: { siegeBonus?: number } = {},
): number {
  let plain = 0;
  let siege = 0;
  for (const [unit, n] of Object.entries(army)) {
    if (!n || n <= 0) continue;
    const per = STRUCTURE_DAMAGE.siegePerSoldier[unit as Unit];
    if (per !== undefined) siege += per * n;
    else plain += STRUCTURE_DAMAGE.nonSiegePerSoldier * n;
  }
  const bonus = STRUCTURE_DAMAGE.workshopAppliesToStructures ? (opts.siegeBonus ?? 0) : 0;
  return Math.floor(plain + siege * (1 + bonus));
}

/** 這支部隊裡有沒有真正的攻城器械（UI 要提醒「沒帶器械拆不動」） */
export function hasSiegeEngine(army: Partial<Record<Unit, number>>): boolean {
  return Object.entries(army).some(
    ([unit, n]) => (n ?? 0) > 0 && STRUCTURE_DAMAGE.siegePerSoldier[unit as Unit] !== undefined,
  );
}

/**
 * 建物的當下耐久：沒被打的時候自己長回來（`STRUCTURE_REPAIR`）。
 *
 * ★ 少了自我修復，「一般部隊 1 點傷害」會被時間繞過去 ——
 *   每天派一支小隊敲幾百點，一週之後石塔自己就倒了。
 *
 * `hp === null` 表示從來沒被打過（滿血）。時間一律由呼叫端傳入（P1）。
 */
export function currentHp(
  kind: StructureKind,
  level: number,
  stored: { hp: number | null; hitAt: number | null },
  now: number,
): number {
  const max = maxHpOf(kind, level);
  if (stored.hp === null) return max;
  const hours = stored.hitAt === null ? 0 : Math.max(0, (now - stored.hitAt) / 3_600_000);
  return Math.min(max, Math.max(0, Math.round(stored.hp + STRUCTURE_REPAIR.hpPerHour * hours)));
}

/** 拆完這座建物還要幾波（UI 用；`Infinity` = 這支部隊拆不動） */
export function wavesToDestroy(hp: number, damagePerWave: number): number {
  if (damagePerWave <= 0) return Infinity;
  return Math.ceil(hp / damagePerWave);
}

// ─────────────────────────────────────────────────────────────
// 要塞路網
// ─────────────────────────────────────────────────────────────

export interface RoadNetwork {
  /** 自己的主城（沒有就是還沒開局） */
  readonly citadel?: { readonly x: number; readonly y: number } | null;
  /** 自己蓋了要塞的格子 */
  readonly fortresses: readonly { readonly x: number; readonly y: number }[];
}

const chebyshev = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** 這一點在不在路網上（主城 8 格內，或站在要塞那一格） */
export function onNetwork(p: { x: number; y: number }, net: RoadNetwork): boolean {
  if (net.citadel && chebyshev(p, net.citadel) <= ROAD.citadelRadius) return true;
  return net.fortresses.some((f) => chebyshev(p, f) <= ROAD.fortressRadius);
}

/**
 * 路網加速倍率：起點與終點**都**在路網上才算數（否則是 1）。
 *
 * ★ 「都」是重點。只要一端在路網上就加速的話，
 *   任何一次從家門口出發的攻擊都會變快 —— 那不是驛道，那是全域加速。
 *   要求兩端都在網上，玩家才會有動機去**鋪**這張網
 *   （前推一座要塞 = 把一整片戰場拉進四倍速範圍）。
 */
export function roadMultiplier(
  from: { x: number; y: number },
  to: { x: number; y: number },
  net: RoadNetwork | null | undefined,
): number {
  if (!net) return 1;
  return onNetwork(from, net) && onNetwork(to, net) ? ROAD.speedMultiplier : 1;
}
