/**
 * 戰場:50×50 的即時戰略式重播。純函式,無 I/O。
 *
 * ## ★ 戰鬥自主、總帳命定
 *
 * 戰鬥的真相只有一個:伺服器在結算迴圈裡用戰鬥引擎一次算完
 * (CLAUDE.md 第三條界線、`docs/11` §19)。這個模組把**已經決定的結果**
 * 演成一場即時戰略,分工是:
 *
 * - **微觀戰鬥是真的**:每一隊有血量、攻擊力、防禦力、攻速、怒氣,
 *   兵種相剋 ±20%,怒氣滿了放技能 —— 誰先倒下、在哪裡倒下,
 *   由這些規則打出來。
 * - **總帳是命定的**:每一種兵能死幾隊由戰報的損失欄決定(死亡配額)。
 *   配額用完後,血條見底的隊以殘血再戰 —— 戰報說他們沒死,
 *   那他們就是沒死。配額沒用完的,在戰鬥尾聲傷重不治。
 *
 * 少了這條分界,客戶端就是第二個戰鬥引擎,兩個引擎遲早算出不同的結果。
 *
 * ## ★ 數值的來源
 *
 * 攻擊力與防禦力直接取自 `balance/units.ts`(單一真相)。
 * 血量、攻速、怒氣、相剋表是**戰場層的呈現常數** —— 它們只決定
 * 這場戲怎麼演,不影響任何 PvP 結果,所以不進數值表、
 * 不 bump `BALANCE_VERSION`。
 *
 * ## ★ 決定性
 *
 * 同一份戰報 + 同一個 seed(= 戰報 id)→ 每一幀都相同。
 * 所有隨機在 `createBattlefield` 一次抽完;`stepBattlefield` **零隨機**
 * (遊走抖動用純 hash(squadId, epoch),戰鬥數學本身是決定性的)。
 */

import { UNIT, type Unit } from "./balance";
import { deriveSeed, mulberry32 } from "./rng";
import { CAMPS, CITADEL, GATE, GRID, groupOf, INNER, type TroopGroup } from "./citadel";

export type Side = "ATTACKER" | "DEFENDER";

export interface Squad {
  readonly id: number;
  readonly side: Side;
  readonly unit: Unit;
  readonly group: TroopGroup;
  /** 這一小隊代表幾名士兵(畫面壓縮:一隊 ≠ 一人) */
  readonly soldiers: number;
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  readonly maxHp: number;
  /** 0–100;滿了下一擊是技能 */
  readonly rage: number;
  /** 還要幾 tick 才能再出手 */
  readonly cooldown: number;
  readonly dead: boolean;
  /** 這一刻正在交戰(有目標在射程內) */
  readonly fighting: boolean;
  readonly targetId: number | null;
  /** 這一 tick 放了技能 —— 畫面畫爆發特效 */
  readonly skillBurst: boolean;
}

export interface SideInput {
  readonly army: Readonly<Partial<Record<Unit, number>>>;
  readonly losses: Readonly<Partial<Record<Unit, number>>>;
}

export interface BattlefieldInput {
  readonly seed: number;
  readonly attacker: SideInput;
  readonly defender: SideInput;
  readonly hasBase: boolean;
  readonly durationTicks?: number;
}

export interface BattlefieldState {
  readonly tick: number;
  readonly duration: number;
  readonly hasBase: boolean;
  readonly squads: readonly Squad[];
  /** 死亡配額:`${side}:${unit}` → 還能死幾隊。這就是「總帳命定」 */
  readonly budgets: Readonly<Record<string, number>>;
}

export const DEFAULT_DURATION = 120;

/**
 * ★ 觀戰窗口:戰鬥結束後 30 分鐘內,這一格在地圖上有交戰標示,
 *   而且**同賽季的任何人**都能點進去看重播(烽火全世界看得到)。
 *   窗口過了,重播回到只有當事人看得到 —— 與戰報同一條迷霧規則。
 *   數字戰報(精確損失、掠奪量)永遠只有當事人看得到。
 */
export const SPECTATE_WINDOW_MS = 30 * 60 * 1000;

/**
 * ★ 戰場殘跡窗口:觀戰窗口過了之後,交戰地點在地圖上再以「暗色殘跡」
 *   顯示 6 小時 —— 「這一帶最近打得兇」本身就是值得繞路的情報。
 *   殘跡只有座標,點進去**不會**有重播(觀戰權限仍以 SPECTATE_WINDOW_MS 為準)。
 */
export const BATTLE_TRACE_WINDOW_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// 兵種數值
// ─────────────────────────────────────────────────────────────

/** 移動速度(格/tick)與射程(格)。呈現常數 */
const GROUP_SPEED: Record<TroopGroup, number> = {
  CAVALRY: 1.1,
  INFANTRY: 0.65,
  ARCHER: 0.6,
  SIEGE: 0.35,
};
const GROUP_RANGE: Record<TroopGroup, number> = {
  CAVALRY: 1.4,
  INFANTRY: 1.4,
  ARCHER: 7,
  SIEGE: 10,
};

/** 攻速:每幾 tick 出手一次。呈現常數 */
export const ATTACK_INTERVAL: Record<TroopGroup, number> = {
  CAVALRY: 3,
  INFANTRY: 3,
  ARCHER: 4,
  SIEGE: 8,
};

/**
 * ★ 相剋:步剋騎、騎剋弓、弓剋步;騎兵另剋器械(繞側翼)。
 *   剋到 = 攻擊 +20%;被剋方防禦時 −20%(等效於雙向各 20% 的加成,
 *   對應「相剋屬性影響 20% 攻擊與防禦加成」)。
 */
export const BEATS: Record<TroopGroup, readonly TroopGroup[]> = {
  INFANTRY: ["CAVALRY"],
  CAVALRY: ["ARCHER", "SIEGE"],
  ARCHER: ["INFANTRY"],
  SIEGE: [],
};

export const COUNTER_BONUS = 0.2;

export function counters(attacker: TroopGroup, defender: TroopGroup): boolean {
  return BEATS[attacker].includes(defender);
}

export interface SquadStats {
  readonly attack: number;
  readonly defense: number;
  readonly hp: number;
}

/**
 * 攻防取自數值表:attack 直接用;防禦依**來襲兵種**選
 * `defInfantry` / `defCavalry`(表本來就是方向性防禦)。
 * 血量 = 兩向防禦之和 + 常數 —— 呈現用,讓硬的兵站得久。
 */
export function statsOf(unit: Unit, attackerGroup: TroopGroup): SquadStats {
  const u = UNIT[unit];
  const defense = attackerGroup === "CAVALRY" ? u.defCavalry : u.defInfantry;
  return { attack: u.attack, defense, hp: 18 + u.defInfantry + u.defCavalry };
}

/**
 * 一次出手的傷害。相剋 ±20% 進攻與防禦兩側。
 * `skill` = 怒氣技:傷害 ×3。
 */
export function damageOf(attacker: Squad, defender: Squad, skill: boolean): number {
  const atkStats = statsOf(attacker.unit, defender.group);
  const defStats = statsOf(defender.unit, attacker.group);
  const atk = atkStats.attack * (counters(attacker.group, defender.group) ? 1 + COUNTER_BONUS : 1);
  const def =
    defStats.defense * (counters(defender.group, attacker.group) ? 1 + COUNTER_BONUS : 1);
  const raw = atk - def * 0.5;
  return Math.max(2, Math.round(raw)) * (skill ? 3 : 1);
}

/**
 * 威脅度:這個敵人一擊能打掉我多少血(含相剋)。
 * 「射程內優先打威脅最高的」用的就是這個數字。
 */
export function threatOf(enemy: Squad, me: Squad): number {
  return damageOf(enemy, me, false);
}

/** 怒氣:出手 +20、挨打 +15,滿 100 下一擊變技能並清空 */
export const RAGE_PER_SWING = 20;
export const RAGE_PER_HIT = 15;
export const RAGE_MAX = 100;

/** 一種兵拆成幾個小隊。對數壓縮 */
export function squadCountFor(soldiers: number): number {
  if (soldiers <= 0) return 0;
  return Math.max(1, Math.min(6, Math.round(Math.log10(soldiers + 1) * 1.8)));
}

/** 決定性的雜訊:step 期間唯一的「隨機」來源 */
function hash(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// ─────────────────────────────────────────────────────────────
// 地形:城牆擋路
// ─────────────────────────────────────────────────────────────

export function isWallCell(cx: number, cy: number): boolean {
  const inCitadel =
    cx >= CITADEL.x && cx < CITADEL.x + CITADEL.w && cy >= CITADEL.y && cy < CITADEL.y + CITADEL.h;
  if (!inCitadel) return false;
  const inInner = cx >= INNER.x && cx < INNER.x + INNER.w && cy >= INNER.y && cy < INNER.y + INNER.h;
  if (inInner) return false;
  const isGate = cy === GATE.y && cx >= GATE.x && cx < GATE.x + GATE.w;
  return !isGate;
}

function passable(hasBase: boolean, x: number, y: number): boolean {
  if (x < 0.5 || y < 0.5 || x > GRID - 0.5 || y > GRID - 0.5) return false;
  if (!hasBase) return true;
  return !isWallCell(Math.floor(x), Math.floor(y));
}

// ─────────────────────────────────────────────────────────────
// 建立
// ─────────────────────────────────────────────────────────────

export function budgetKey(side: Side, unit: Unit): string {
  return `${side}:${unit}`;
}

export function createBattlefield(input: BattlefieldInput): BattlefieldState {
  const rng = mulberry32(deriveSeed(input.seed, "battlefield"));
  const duration = input.durationTicks ?? DEFAULT_DURATION;
  const squads: Squad[] = [];
  const budgets: Record<string, number> = {};
  let nextId = 1;

  const edge = (["N", "E", "W"] as const)[Math.floor(rng() * 3)]!;

  const build = (side: Side, sideInput: SideInput) => {
    for (const [unitKey, count] of Object.entries(sideInput.army)) {
      const unit = unitKey as Unit;
      const total = count ?? 0;
      if (total <= 0) continue;
      const losses = Math.min(total, sideInput.losses[unit] ?? 0);
      const n = squadCountFor(total);
      const group = groupOf(unit);

      /**
       * ★ 總帳命定的核心:這種兵有 n 隊,配額 = round(n × 損失率)。
       *   誰用掉配額由戰鬥決定;配額用完就沒有人再死。
       */
      budgets[budgetKey(side, unit)] = total > 0 ? Math.round((n * losses) / total) : 0;
      const per = total / n;
      const hp = statsOf(unit, "INFANTRY").hp;

      for (let i = 0; i < n; i++) {
        let x: number;
        let y: number;
        if (side === "DEFENDER") {
          const camp = CAMPS[group];
          x = camp.x + 1 + rng() * (camp.w - 2);
          y = camp.y + 1 + rng() * (camp.h - 2);
        } else {
          const along = 10 + rng() * (GRID - 20);
          if (edge === "N") {
            x = along;
            y = 1 + rng() * 3;
          } else if (edge === "E") {
            x = GRID - 2 - rng() * 3;
            y = along;
          } else {
            x = 1 + rng() * 3;
            y = along;
          }
        }

        squads.push({
          id: nextId++,
          side,
          unit,
          group,
          soldiers: Math.round(per),
          x,
          y,
          hp,
          maxHp: hp,
          rage: 0,
          cooldown: 0,
          dead: false,
          fighting: false,
          targetId: null,
          skillBurst: false,
        });
      }
    }
  };

  build("DEFENDER", input.defender);
  build("ATTACKER", input.attacker);

  return { tick: 0, duration, hasBase: input.hasBase, squads, budgets };
}

// ─────────────────────────────────────────────────────────────
// 每一 tick
// ─────────────────────────────────────────────────────────────

export function battleOver(state: BattlefieldState): boolean {
  return state.tick >= state.duration;
}

interface Mutable {
  hp: number;
  rage: number;
  cooldown: number;
  x: number;
  y: number;
  dead: boolean;
  fighting: boolean;
  targetId: number | null;
  skillBurst: boolean;
}

/** 一步。純函式:同一個 state 進來,永遠同一個 state 出去 */
export function stepBattlefield(state: BattlefieldState): BattlefieldState {
  if (battleOver(state)) return state;
  const tick = state.tick + 1;
  const budgets: Record<string, number> = { ...state.budgets };

  // 工作副本 —— 同一 tick 內傷害要能疊加,最後再凍回不可變的 Squad
  const work = new Map<number, Mutable>();
  for (const s of state.squads) {
    work.set(s.id, {
      hp: s.hp,
      rage: s.rage,
      cooldown: Math.max(0, s.cooldown - 1),
      x: s.x,
      y: s.y,
      dead: s.dead,
      fighting: false,
      targetId: null,
      skillBurst: false,
    });
  }

  const living = (side?: Side) =>
    state.squads.filter((s) => !work.get(s.id)!.dead && (side === undefined || s.side === side));

  // ── 行動:每一隊依序決策(id 序,決定性) ────────────────
  for (const s of state.squads) {
    const me = work.get(s.id)!;
    if (me.dead) continue;

    const enemies = living().filter((e) => e.side !== s.side);
    if (enemies.length === 0) {
      // 沒有敵人 → 在原地附近遊走(戰前守軍、戰後倖存者)
      const epoch = Math.floor(tick / 16);
      const wx = me.x + (hash(s.id, epoch) - 0.5) * 6;
      const wy = me.y + (hash(epoch, s.id) - 0.5) * 6;
      const d = Math.hypot(wx - me.x, wy - me.y);
      if (d >= 0.3) {
        const speed = GROUP_SPEED[s.group] * 0.3;
        const nx = me.x + ((wx - me.x) / d) * speed;
        const ny = me.y + ((wy - me.y) / d) * speed;
        if (passable(state.hasBase, nx, ny)) {
          me.x = nx;
          me.y = ny;
        }
      }
      continue;
    }

    const range = GROUP_RANGE[s.group];
    const dist = (e: Squad) => {
      const w = work.get(e.id)!;
      return Math.hypot(w.x - me.x, w.y - me.y);
    };

    /**
     * ★ 目標選擇(對應規格):
     *   1. 射程內 → 打**威脅度最高**的(它一擊能打掉我最多血,含相剋)
     *   2. 射程外 → 朝**最近**的敵人移動
     */
    const inRange = enemies.filter((e) => dist(e) <= range);
    if (inRange.length > 0) {
      let target = inRange[0]!;
      let best = -1;
      for (const e of inRange) {
        const t = threatOf(e, s);
        if (t > best || (t === best && e.id < target.id)) {
          best = t;
          target = e;
        }
      }
      me.fighting = true;
      me.targetId = target.id;

      if (me.cooldown === 0) {
        const skill = me.rage >= RAGE_MAX;
        const dmg = damageOf(s, target, skill);
        const tw = work.get(target.id)!;
        tw.hp -= dmg;
        tw.rage = Math.min(RAGE_MAX, tw.rage + RAGE_PER_HIT);
        me.cooldown = ATTACK_INTERVAL[s.group];
        me.rage = skill ? 0 : Math.min(RAGE_MAX, me.rage + RAGE_PER_SWING);
        me.skillBurst = skill;

        if (tw.hp <= 0) {
          const key = budgetKey(target.side, target.unit);
          if ((budgets[key] ?? 0) > 0) {
            budgets[key] = budgets[key]! - 1;
            tw.dead = true;
          } else {
            /**
             * ★ 配額用完:戰報說這種兵沒死這麼多,所以他們就是沒死。
             *   殘血再戰 —— 微觀戰鬥服從總帳,不是反過來。
             */
            tw.hp = Math.round(statsOf(target.unit, "INFANTRY").hp * 0.4);
          }
        }
      }
      continue;
    }

    // 射程外:朝最近的敵人前進,撞牆滑牆(自然繞到南門)
    let nearest = enemies[0]!;
    let nd = Infinity;
    for (const e of enemies) {
      const d = dist(e);
      if (d < nd) {
        nd = d;
        nearest = e;
      }
    }
    const tw = work.get(nearest.id)!;
    const speed = GROUP_SPEED[s.group];
    const dx = ((tw.x - me.x) / nd) * speed;
    const dy = ((tw.y - me.y) / nd) * speed;
    let nx = me.x + dx;
    let ny = me.y + dy;
    if (!passable(state.hasBase, nx, ny)) {
      if (passable(state.hasBase, me.x + dx, me.y)) {
        nx = me.x + dx;
        ny = me.y;
      } else if (passable(state.hasBase, me.x, me.y + dy)) {
        nx = me.x;
        ny = me.y + dy;
      } else {
        nx = me.x;
        ny = me.y;
      }
    }
    me.x = nx;
    me.y = ny;
  }

  /**
   * ── 傷重不治:戰鬥尾聲把沒用完的配額結清 ──────────────
   *
   * 戰報說要死這麼多,重播結束時就要死這麼多。尾聲每 3 tick、
   * 每種兵一隊,挑血最少的倒下 —— 看起來就是「撐到最後撐不住了」。
   */
  const settleFrom = Math.max(0, state.duration - 20);
  if (tick >= settleFrom && tick % 3 === 0) {
    for (const [key, left] of Object.entries(budgets)) {
      if (left <= 0) continue;
      const [side, unit] = key.split(":") as [Side, Unit];
      const candidates = state.squads
        .filter((s) => s.side === side && s.unit === unit && !work.get(s.id)!.dead)
        .sort((a, b) => work.get(a.id)!.hp - work.get(b.id)!.hp || a.id - b.id);
      const victim = candidates[0];
      if (victim) {
        work.get(victim.id)!.dead = true;
        budgets[key] = left - 1;
      }
    }
  }
  // 最後一 tick:無條件結清(絕對保證收斂)
  if (tick === state.duration) {
    for (const [key, left] of Object.entries(budgets)) {
      let remaining = left;
      if (remaining <= 0) continue;
      const [side, unit] = key.split(":") as [Side, Unit];
      const candidates = state.squads
        .filter((s) => s.side === side && s.unit === unit && !work.get(s.id)!.dead)
        .sort((a, b) => work.get(a.id)!.hp - work.get(b.id)!.hp || a.id - b.id);
      for (const v of candidates) {
        if (remaining <= 0) break;
        work.get(v.id)!.dead = true;
        remaining--;
      }
      budgets[key] = remaining;
    }
  }

  const squads = state.squads.map((s): Squad => {
    const w = work.get(s.id)!;
    return {
      ...s,
      x: w.x,
      y: w.y,
      hp: Math.max(0, w.hp),
      rage: w.dead ? 0 : w.rage,
      cooldown: w.cooldown,
      dead: w.dead,
      fighting: w.dead ? false : w.fighting,
      targetId: w.dead ? null : w.targetId,
      skillBurst: w.dead ? false : w.skillBurst,
    };
  });

  return { ...state, tick, squads, budgets };
}

// ─────────────────────────────────────────────────────────────
// 統計(HUD 用)
// ─────────────────────────────────────────────────────────────

export interface SideTally {
  readonly alive: number;
  readonly dead: number;
}

export function tally(state: BattlefieldState, side: Side): SideTally {
  let alive = 0;
  let dead = 0;
  for (const s of state.squads) {
    if (s.side !== side) continue;
    if (s.dead) dead += s.soldiers;
    else alive += s.soldiers;
  }
  return { alive, dead };
}
