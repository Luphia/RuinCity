"use client";

/**
 * 戰場重播的畫面層：底圖（據點全景）＋ canvas（士兵）。
 *
 * ★ 這一層**只演不算**。移動、尋敵、死亡全在 `lib/game/battlefield.ts`
 *   的純函式裡；戰局的真相在伺服器的戰報裡（CLAUDE.md 第三條界線）。
 *   畫面上的最終存活數收斂到戰報 —— 這是重播，不是第二個戰鬥引擎。
 *
 * ★ 用 canvas 而不是 SVG：每 tick 有幾十隊在動，SVG 每幀重建 DOM
 *   划不來。底圖不動，畫一次 SVG；動的東西（士兵、屍體、箭）疊在
 *   canvas 上，rAF 驅動。相機不動、元素少，用不到 PixiJS。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  battleOver,
  createBattlefield,
  stepBattlefield,
  tally,
  type BattlefieldInput,
  type BattlefieldState,
  type Squad,
} from "@/lib/game/battlefield";
import { citadelSceneSvg, territorySceneSvg, GRID, type SceneSlot } from "@/lib/game/citadel";
import {
  pickAnim,
  renderSoldier,
  SOLDIER_SIZE,
  type AnimEvents,
  type SoldierAnim,
  type SoldierSide,
} from "@/lib/game/soldier";
import { SPRITE_PALETTE } from "@/lib/game/sprite";
import type { TroopGroup } from "@/lib/game/citadel";

/** 一 tick 幾毫秒（1× 速度）。120 tick ≈ 36 秒的一場戲 */
const TICK_MS = 300;
/** canvas 內部解析度：一格 8px */
const PX = 8;

export interface BattlefieldViewProps {
  readonly input: BattlefieldInput;
  readonly attackerLabel: string;
  readonly defenderLabel: string;
  /** 底圖的建築配置；不知道（敵方據點）就給預設 */
  readonly slots?: readonly SceneSlot[];
  /**
   * 領地建物（`docs/02` §2.6）。給了就畫**領地場景**（中央一面旗或一座石塔），
   * 不畫城 —— 資源地不是「沒蓋東西的據點」，它是另一種地方。
   */
  readonly structure?: {
    readonly kind: "FLAG" | "TOWER";
    readonly level: number;
    readonly mine: boolean;
  } | null;
}

const DEFAULT_SLOTS: readonly SceneSlot[] = [
  { slot: "A", building: "CITADEL", level: 10, busy: false },
  { slot: "B", building: null, level: 0, busy: false },
  { slot: "C", building: null, level: 0, busy: false },
  { slot: "D", building: null, level: 0, busy: false },
];

/**
 * 士兵 sprite 的快取：(兵種, 陣營, 動畫, 幀) → 畫好的 25×25 canvas。
 * `renderSoldier` 是決定性的純函式，所以第一次要到就烘一張、永遠重用 ——
 * 全部組合也就 152 張小圖。模組層級的 Map：跨戰場、跨重播共用。
 */
const spriteCache = new Map<string, HTMLCanvasElement>();

function soldierSprite(
  group: TroopGroup,
  side: SoldierSide,
  anim: SoldierAnim,
  frame: number,
): HTMLCanvasElement {
  const key = `${group}:${side}:${anim}:${frame}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;

  const g = renderSoldier(group, side, anim, frame);
  const c = document.createElement("canvas");
  c.width = SOLDIER_SIZE;
  c.height = SOLDIER_SIZE;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(SOLDIER_SIZE, SOLDIER_SIZE);
  for (let i = 0; i < g.length; i++) {
    const v = g[i]!;
    if (v === 0) continue;
    const hex = SPRITE_PALETTE[v]!;
    img.data[i * 4] = parseInt(hex.slice(1, 3), 16);
    img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16);
    img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  spriteCache.set(key, c);
  return c;
}

/**
 * 畫一隊士兵：25×25 sprite + 血條/怒氣條。
 * 動畫的選擇（`pickAnim`）是純函式；這裡只餵它「什麼時候發生的」。
 */
function drawSquad(ctx: CanvasRenderingContext2D, s: Squad, ev: AnimEvents, tick: number) {
  const x = Math.round(s.x * PX);
  const y = Math.round(s.y * PX);
  const pick = pickAnim(s, ev, tick, s.id);
  // sprite 的地面在第 23 列 —— 讓腳踩在隊伍的座標上
  ctx.drawImage(soldierSprite(s.group, s.side, pick.anim, pick.frame), x - 12, y - 22);

  if (s.dead) return;

  // 血條 + 怒氣條：只在受過傷或怒氣累積時畫 —— idle 巡邏保持乾淨
  if (s.hp < s.maxHp || s.rage > 0) {
    const bw = 10;
    const hpRatio = Math.max(0, Math.min(1, s.hp / s.maxHp));
    ctx.fillStyle = "#1a1614";
    ctx.fillRect(x - 5, y - 26, bw, 3);
    ctx.fillStyle = hpRatio > 0.5 ? "#6b7f4a" : hpRatio > 0.25 ? "#d9a441" : "#c4442f";
    ctx.fillRect(x - 5, y - 26, Math.max(1, Math.round(bw * hpRatio)), 1);
    if (s.rage > 0) {
      // 怒氣滿格會亮成羊皮紙白 —— 下一擊就是技能
      ctx.fillStyle = s.rage >= 100 ? "#e8dcc0" : "#a35a3a";
      ctx.fillRect(x - 5, y - 24, Math.max(1, Math.round((bw * s.rage) / 100)), 1);
    }
  }
}

/** 每一隊的「什麼時候發生的」—— 掉血、放技、倒下。畫面層的記憶，不進 sim */
type EventMap = Map<number, { deathTick: number | null; skillTick: number | null; hitTick: number | null }>;

function trackEvents(prev: BattlefieldState, next: BattlefieldState, events: EventMap) {
  for (const s of next.squads) {
    let ev = events.get(s.id);
    if (!ev) {
      ev = { deathTick: null, skillTick: null, hitTick: null };
      events.set(s.id, ev);
    }
    const before = prev.squads.find((q) => q.id === s.id);
    if (s.dead && ev.deathTick === null) ev.deathTick = next.tick;
    if (s.skillBurst) ev.skillTick = next.tick;
    if (before && s.hp < before.hp && !s.dead) ev.hitTick = next.tick;
  }
}

export function BattlefieldView(props: BattlefieldViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<BattlefieldState | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [hud, setHud] = useState({ tick: 0, over: false, a: 0, d: 0 });
  const [resetKey, setResetKey] = useState(0);

  // 播放狀態進 ref，rAF 迴圈才不用重建。★ 在 effect 裡同步，不在 render 中寫 ref
  const playingRef = useRef(true);
  const speedRef = useRef(1);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  // 底圖只算一次：地形 + 城牆 + 建築（士兵不在底圖上，由 canvas 畫）
  const structure = props.structure ?? null;
  const background = useMemo(
    () =>
      structure
        ? territorySceneSvg(
            {
              structure: structure.kind,
              level: structure.level,
              owned: structure.mine,
              garrison: {},
              frame: 0,
            },
            1,
          )
        : citadelSceneSvg({ slots: props.slots ?? DEFAULT_SLOTS, garrison: {}, frame: 0 }, 1),
    // ★ 依賴用基本型別，不要用 structure 物件本身（`11` §20.23 的教訓）
    [props.slots, structure?.kind, structure?.level, structure?.mine, structure],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let state = createBattlefield(props.input);
    stateRef.current = state;
    // 每一隊的動畫事件（掉血/放技/倒下的 tick）—— 重播重置時跟著重生
    const events: EventMap = new Map();
    let raf = 0;
    let last = 0;
    let acc = 0;
    let frame = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const evOf = (id: number) =>
        events.get(id) ?? { deathTick: null, skillTick: null, hitTick: null };

      // 先畫屍體（在活人下面）—— DEATH 動畫的最後一幀就是永久的屍體
      for (const s of state.squads) if (s.dead) drawSquad(ctx, s, evOf(s.id), state.tick);

      // 弓箭與投石：沿線的一個亮點，位置由 frame 決定（無狀態）
      for (const s of state.squads) {
        if (s.dead || !s.fighting || s.targetId === null) continue;
        const t = state.squads.find((q) => q.id === s.targetId);
        if (!t || t.dead) continue;
        if (s.group === "ARCHER" || s.group === "SIEGE") {
          const k = ((frame + s.id) % 6) / 6;
          const px = s.x * PX + (t.x - s.x) * PX * k;
          const py = s.y * PX + (t.y - s.y) * PX * k;
          ctx.fillStyle = s.group === "SIEGE" ? "#c4442f" : "#e8dcc0";
          ctx.fillRect(Math.round(px), Math.round(py), 2, 2);
        } else if ((frame + s.id) % 4 < 2) {
          ctx.fillStyle = "#e8dcc0";
          ctx.fillRect(Math.round(((s.x + t.x) / 2) * PX), Math.round(((s.y + t.y) / 2) * PX), 2, 2);
        }
      }

      // 活人依 y 排序（下面的畫在上面）—— 25px 的小人會互相重疊
      const alive = state.squads.filter((s) => !s.dead).sort((a, b) => a.y - b.y);
      for (const s of alive) drawSquad(ctx, s, evOf(s.id), state.tick);
    };

    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (last === 0) last = ts;
      const dt = ts - last;
      last = ts;
      if (!playingRef.current) return;
      acc += dt * speedRef.current;
      let stepped = false;
      while (acc >= TICK_MS && !battleOver(state)) {
        const prev = state;
        state = stepBattlefield(state);
        trackEvents(prev, state, events);
        acc -= TICK_MS;
        stepped = true;
      }
      if (stepped || frame === 0) {
        frame++;
        stateRef.current = state;
        draw();
        const a = tally(state, "ATTACKER");
        const d = tally(state, "DEFENDER");
        setHud({ tick: state.tick, over: battleOver(state), a: a.alive, d: d.alive });
      }
    };

    draw();
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [props.input, resetKey]);

  const progress = Math.round((hud.tick / (props.input.durationTicks ?? 120)) * 100);

  return (
    <div data-testid="battlefield">
      <div className="relative aspect-square w-full overflow-hidden rounded border border-[#4a413a] bg-[#1a1614]">
        <div aria-hidden className="absolute inset-0" dangerouslySetInnerHTML={{ __html: background }} />
        <canvas
          ref={canvasRef}
          width={GRID * PX}
          height={GRID * PX}
          className="absolute inset-0 h-full w-full"
          style={{ imageRendering: "pixelated" }}
        />
        {hud.over ? (
          <div className="absolute inset-x-0 bottom-0 bg-[#1a1614]/85 px-3 py-2 text-center text-xs">
            重播結束 —— 帳目以戰報為準
          </div>
        ) : null}
      </div>

      {/* HUD */}
      <div className="mt-2 flex items-center justify-between text-xs tabular-nums">
        <span className="text-[#a35a3a]">
          ⚔ {props.attackerLabel} <b>{hud.a.toLocaleString()}</b>
        </span>
        <span className="opacity-60">{progress}%</span>
        <span className="text-[#4a8fa8]">
          <b>{hud.d.toLocaleString()}</b> {props.defenderLabel} 🛡
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded bg-[#2e2723]">
        <div className="h-full bg-[#8a6b3a]" style={{ width: `${progress}%` }} />
      </div>

      <div className="mt-2 flex gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="rounded border border-[#4a413a] px-3 py-1.5"
        >
          {playing ? "暫停" : "播放"}
        </button>
        <button
          type="button"
          onClick={() => {
            setResetKey((k) => k + 1);
            setPlaying(true);
          }}
          className="rounded border border-[#4a413a] px-3 py-1.5"
        >
          重播
        </button>
        <div className="ml-auto flex gap-1">
          {[1, 2, 4].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={`rounded border px-2 py-1.5 ${
                speed === s ? "border-[#8a6b3a] text-[#d9a441]" : "border-[#4a413a]"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
