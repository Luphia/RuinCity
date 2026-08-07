/**
 * 戰場：50×50 的即時戰略式重播。純函式，無 I/O。
 *
 * ## ★ 這是**重播**，不是模擬器
 *
 * 戰鬥的真相只有一個：伺服器在結算迴圈裡用戰鬥引擎一次算完
 * （CLAUDE.md 第三條界線、`docs/11` §19）。這個模組把**已經決定的結果**
 * 演成一場即時戰略：士兵自主尋敵、移動、交戰 —— 但誰死、死多少，
 * 由戰報的損失欄決定。重播結束時的存活數**恰好**收斂到戰報。
 *
 * 換句話說：移動與交戰是自主的（每一格的走位都是規則算出來的），
 * 死亡是命定的（照排程收斂）。少了這條分界，客戶端就會出現第二個
 * 戰鬥引擎，而兩個引擎遲早算出不同的結果。
 *
 * ## ★ 決定性
 *
 * 同一份戰報 + 同一個 seed（= 戰報 id）→ 每一幀都相同。
 * 兩位玩家看同一場重播要看到同一場戲。所以：
 * - 所有隨機性在 `createBattlefield` 一次抽完（mulberry32）
 * - `stepBattlefield` **零隨機**：遊走的抖動用純 hash(squadId, epoch)
 *
 * ## 版面
 *
 * 與據點全景（`citadel.ts`）共用同一張 50×50 的格：守軍從四面營區出發，
 * 攻方從地圖邊緣進場。城牆是實體 —— 走不進去，只能繞到南門。
 */

import { deriveSeed, mulberry32 } from "./rng";
import { CAMPS, CITADEL, GATE, GRID, groupOf, INNER, type TroopGroup } from "./citadel";
import type { Unit } from "./balance";

export type Side = "ATTACKER" | "DEFENDER";

export interface Squad {
  readonly id: number;
  readonly side: Side;
  readonly unit: Unit;
  readonly group: TroopGroup;
  /** 這一小隊代表幾名士兵（畫面壓縮：一隊 ≠ 一人） */
  readonly soldiers: number;
  readonly x: number;
  readonly y: number;
  /** 命定的陣亡時刻；null = 活到最後 */
  readonly deathTick: number | null;
  readonly dead: boolean;
  /** 這一刻正在交戰（畫攻擊特效用） */
  readonly fighting: boolean;
  /** 交戰對象（畫弓箭軌跡用） */
  readonly targetId: number | null;
}

export interface SideInput {
  readonly army: Readonly<Partial<Record<Unit, number>>>;
  readonly losses: Readonly<Partial<Record<Unit, number>>>;
}

export interface BattlefieldInput {
  readonly seed: number;
  readonly attacker: SideInput;
  readonly defender: SideInput;
  /** 這一格有據點 → 畫城牆、走位要繞門 */
  readonly hasBase: boolean;
  /** 重播長度（tick）。一 tick 由渲染層決定幾毫秒 */
  readonly durationTicks?: number;
}

export interface BattlefieldState {
  readonly tick: number;
  readonly duration: number;
  readonly hasBase: boolean;
  readonly squads: readonly Squad[];
}

export const DEFAULT_DURATION = 120;

/** 每一種部隊的移動速度（格/tick）與射程（格） */
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

/** 一種兵拆成幾個小隊。對數壓縮 —— 一萬人畫不下，也沒有意義 */
export function squadCountFor(soldiers: number): number {
  if (soldiers <= 0) return 0;
  return Math.max(1, Math.min(6, Math.round(Math.log10(soldiers + 1) * 1.8)));
}

/** 決定性的雜訊：step 期間唯一的「隨機」來源 */
function hash(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

// ─────────────────────────────────────────────────────────────
// 地形：城牆擋路
// ─────────────────────────────────────────────────────────────

/** 這一格是不是牆（門不算牆） */
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
// 建立：抽完所有隨機、排好所有死期
// ─────────────────────────────────────────────────────────────

export function createBattlefield(input: BattlefieldInput): BattlefieldState {
  const rng = mulberry32(deriveSeed(input.seed, "battlefield"));
  const duration = input.durationTicks ?? DEFAULT_DURATION;
  const squads: Squad[] = [];
  let nextId = 1;

  /** 攻方從哪一條邊進場（門在南，攻方不從正南進 —— 太整齊了） */
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
       * ★ 收斂的核心：這種兵有 n 隊，其中 `round(n × 損失率)` 隊會死。
       *   士兵數照隊分攤 —— 所以最終「死掉的士兵數」與戰報的誤差
       *   最多半個小隊，而總隊數本來就是對數壓縮，這是顯示粒度，
       *   不是帳目（帳目在戰報的數字裡）。
       */
      const dyingSquads = total > 0 ? Math.round((n * losses) / total) : 0;
      const per = total / n;

      for (let i = 0; i < n; i++) {
        const dies = i < dyingSquads;
        // 死期鋪在戰鬥中段 —— 開場就倒與最後一秒團滅都很假
        const deathTick = dies ? Math.floor(duration * (0.2 + rng() * 0.68)) : null;

        let x: number;
        let y: number;
        if (side === "DEFENDER") {
          const camp = CAMPS[group];
          x = camp.x + 1 + rng() * (camp.w - 2);
          y = camp.y + 1 + rng() * (camp.h - 2);
        } else {
          // 攻方沿著入場邊排開
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
          deathTick,
          dead: false,
          fighting: false,
          targetId: null,
        });
      }
    }
  };

  build("DEFENDER", input.defender);
  build("ATTACKER", input.attacker);

  return { tick: 0, duration, hasBase: input.hasBase, squads };
}

// ─────────────────────────────────────────────────────────────
// 每一 tick：尋敵 → 移動或交戰 → 命定的死亡
// ─────────────────────────────────────────────────────────────

export function battleOver(state: BattlefieldState): boolean {
  return state.tick >= state.duration;
}

/** 一步。純函式：同一個 state 進來，永遠同一個 state 出去 */
export function stepBattlefield(state: BattlefieldState): BattlefieldState {
  if (battleOver(state)) return state;
  const tick = state.tick + 1;

  const living = state.squads.filter((s) => !s.dead);

  const squads = state.squads.map((s): Squad => {
    if (s.dead) return s;

    // ★ 命定的死亡：時辰到了就倒下，帳目才會收斂到戰報
    if (s.deathTick !== null && tick >= s.deathTick) {
      return { ...s, dead: true, fighting: false, targetId: null };
    }

    // 尋敵：最近的活著的敵隊
    let target: Squad | null = null;
    let best = Infinity;
    for (const e of living) {
      if (e.side === s.side || e.dead) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d < best) {
        best = d;
        target = e;
      }
    }

    if (!target) {
      /**
       * 沒有敵人（戰前的守軍、戰後的倖存者）→ 在原地附近遊走。
       * 抖動來自 hash(squadId, epoch)，不是 rng —— step 必須零隨機。
       */
      const epoch = Math.floor(tick / 16);
      const wx = s.x + (hash(s.id, epoch) - 0.5) * 6;
      const wy = s.y + (hash(epoch, s.id) - 0.5) * 6;
      const d = Math.hypot(wx - s.x, wy - s.y);
      if (d < 0.3) return { ...s, fighting: false, targetId: null };
      const speed = GROUP_SPEED[s.group] * 0.3;
      const nx = s.x + ((wx - s.x) / d) * speed;
      const ny = s.y + ((wy - s.y) / d) * speed;
      if (!passable(state.hasBase, nx, ny)) return { ...s, fighting: false, targetId: null };
      return { ...s, x: nx, y: ny, fighting: false, targetId: null };
    }

    // 射程內 → 交戰（站定）。射程外 → 朝目標前進
    if (best <= GROUP_RANGE[s.group]) {
      return { ...s, fighting: true, targetId: target.id };
    }

    const speed = GROUP_SPEED[s.group];
    const dx = ((target.x - s.x) / best) * speed;
    const dy = ((target.y - s.y) / best) * speed;

    /**
     * ★ 城牆是實體。直走撞牆時先試只走 x、再試只走 y ——
     *   經典的滑牆，會讓部隊自然沿著牆面推到南門。
     */
    let nx = s.x + dx;
    let ny = s.y + dy;
    if (!passable(state.hasBase, nx, ny)) {
      if (passable(state.hasBase, s.x + dx, s.y)) {
        nx = s.x + dx;
        ny = s.y;
      } else if (passable(state.hasBase, s.x, s.y + dy)) {
        nx = s.x;
        ny = s.y + dy;
      } else {
        nx = s.x;
        ny = s.y;
      }
    }

    return { ...s, x: nx, y: ny, fighting: false, targetId: null };
  });

  return { ...state, tick, squads };
}

// ─────────────────────────────────────────────────────────────
// 統計（HUD 用）
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
