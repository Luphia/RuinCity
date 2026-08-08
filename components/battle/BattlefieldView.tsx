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
import { citadelSceneSvg, GRID, type SceneSlot } from "@/lib/game/citadel";

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
}

const DEFAULT_SLOTS: readonly SceneSlot[] = [
  { slot: "A", building: "CITADEL", level: 10, busy: false },
  { slot: "B", building: null, level: 0, busy: false },
  { slot: "C", building: null, level: 0, busy: false },
  { slot: "D", building: null, level: 0, busy: false },
];

// 攻方鏽紅、守方生機藍 —— 都取自 docs/09 §3 的調色盤
const SIDE_BODY = { ATTACKER: "#a35a3a", DEFENDER: "#4a8fa8" } as const;
const SIDE_EDGE = { ATTACKER: "#6e3a26", DEFENDER: "#33454f" } as const;

function drawSquad(ctx: CanvasRenderingContext2D, s: Squad, frame: number) {
  const x = Math.round(s.x * PX);
  const y = Math.round(s.y * PX);
  const body = SIDE_BODY[s.side];
  const edge = SIDE_EDGE[s.side];

  if (s.dead) {
    // 屍體：一個暗色的叉，留在原地
    ctx.fillStyle = "#2e2723";
    ctx.fillRect(x - 3, y - 1, 6, 2);
    ctx.fillRect(x - 1, y - 3, 2, 6);
    return;
  }

  const bob = s.fighting ? 0 : frame % 2; // 行進時上下顛一格
  ctx.fillStyle = "#1a1614";
  switch (s.group) {
    case "CAVALRY":
      ctx.fillRect(x - 5, y - 3 + bob, 10, 7);
      ctx.fillStyle = body;
      ctx.fillRect(x - 4, y - 2 + bob, 8, 5);
      ctx.fillStyle = edge;
      ctx.fillRect(x + 2, y - 4 + bob, 3, 3); // 馬頭
      break;
    case "SIEGE":
      ctx.fillRect(x - 6, y - 3, 12, 7);
      ctx.fillStyle = body;
      ctx.fillRect(x - 5, y - 2, 10, 5);
      ctx.fillStyle = "#1a1614";
      ctx.fillRect(x - 4, y + 3, 2, 2);
      ctx.fillRect(x + 2, y + 3, 2, 2); // 輪
      break;
    default:
      ctx.fillRect(x - 3, y - 4 + bob, 6, 8);
      ctx.fillStyle = body;
      ctx.fillRect(x - 2, y - 3 + bob, 4, 6);
      if (s.group === "ARCHER") {
        ctx.fillStyle = "#e8dcc0";
        ctx.fillRect(x + 3, y - 2 + bob, 1, 4); // 弓
      } else {
        ctx.fillStyle = edge;
        ctx.fillRect(x + 3, y - 5 + bob, 1, 7); // 矛
      }
  }

  // 血條 + 怒氣條：只在受過傷或怒氣累積時畫 —— idle 巡邏保持乾淨
  if (s.hp < s.maxHp || s.rage > 0) {
    const bw = 8;
    const hpRatio = Math.max(0, Math.min(1, s.hp / s.maxHp));
    ctx.fillStyle = "#1a1614";
    ctx.fillRect(x - 4, y - 9, bw, 3);
    ctx.fillStyle = hpRatio > 0.5 ? "#6b7f4a" : hpRatio > 0.25 ? "#d9a441" : "#c4442f";
    ctx.fillRect(x - 4, y - 9, Math.max(1, Math.round(bw * hpRatio)), 1);
    if (s.rage > 0) {
      // 怒氣滿格會亮成羊皮紙白 —— 下一擊就是技能
      ctx.fillStyle = s.rage >= 100 ? "#e8dcc0" : "#a35a3a";
      ctx.fillRect(x - 4, y - 7, Math.max(1, Math.round((bw * s.rage) / 100)), 1);
    }
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
  const background = useMemo(
    () => citadelSceneSvg({ slots: props.slots ?? DEFAULT_SLOTS, garrison: {}, frame: 0 }, 1),
    [props.slots],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let state = createBattlefield(props.input);
    stateRef.current = state;
    let raf = 0;
    let last = 0;
    let acc = 0;
    let frame = 0;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // 先畫屍體（在活人下面）
      for (const s of state.squads) if (s.dead) drawSquad(ctx, s, frame);
      // 弓箭與交戰特效
      for (const s of state.squads) {
        if (s.dead || !s.fighting || s.targetId === null) continue;
        const t = state.squads.find((q) => q.id === s.targetId);
        if (!t || t.dead) continue;
        if (s.group === "ARCHER" || s.group === "SIEGE") {
          // 箭／石：沿線的一個亮點，位置由 frame 決定（無狀態）
          const k = ((frame + s.id) % 6) / 6;
          const px = s.x * PX + (t.x - s.x) * PX * k;
          const py = s.y * PX + (t.y - s.y) * PX * k;
          ctx.fillStyle = s.group === "SIEGE" ? "#c4442f" : "#e8dcc0";
          ctx.fillRect(Math.round(px), Math.round(py), 2, 2);
        } else if ((frame + s.id) % 4 < 2) {
          // 近戰：交戰處閃刀光
          ctx.fillStyle = "#e8dcc0";
          ctx.fillRect(Math.round(((s.x + t.x) / 2) * PX), Math.round(((s.y + t.y) / 2) * PX), 2, 2);
        }
      }
      for (const s of state.squads) if (!s.dead) drawSquad(ctx, s, frame);
      // 怒氣技的金色爆發 —— skillBurst 只亮一 tick，就是那一擊
      for (const s of state.squads) {
        if (s.dead || !s.skillBurst) continue;
        const x = Math.round(s.x * PX);
        const y = Math.round(s.y * PX);
        ctx.fillStyle = "#d9a441";
        ctx.fillRect(x - 8, y - 1, 16, 2);
        ctx.fillRect(x - 1, y - 8, 2, 16);
        ctx.fillStyle = "#e8dcc0";
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
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
        state = stepBattlefield(state);
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
