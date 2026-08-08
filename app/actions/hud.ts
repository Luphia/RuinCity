"use server";

/**
 * 常駐 HUD 的資料來源。
 *
 * ★ 與據點頁用**同一組純函式**（`deriveRates`、季節係數、`loadAndSettle`）——
 *   HUD 的數字必須跟據點頁完全一致，不然玩家會在兩個地方看到兩個糧食量。
 *
 * ★ 回傳 null = 「沒有登入或沒有進行中的賽季」，是正常狀態，不是錯誤 ——
 *   呼叫端據此隱藏 HUD。真的炸掉（DB 斷線）就讓它 throw，
 *   客戶端 catch 之後要顯示同步失敗，不准吞掉。
 */


import { SEASON_MODIFIERS, type Season } from "@/lib/game/balance";
import { formatGameDateWithSeason, toGameDate } from "@/lib/game/calendar";
import { deriveRates, outpostUpkeep } from "@/lib/game/economy-state";
import { nearestCompletion, type NextCompletion } from "@/lib/game/hud";
import { zeroAmounts, type Amounts } from "@/lib/game/settle";
import { slotLabel } from "@/lib/game/sprite";
import { loadAndSettle } from "@/lib/server/player-state";
import { currentPlayer } from "@/lib/server/current-player";
import { serverNow } from "@/lib/time";

export interface HudState {
  readonly serverTime: number;
  readonly resources: Amounts;
  readonly perHour: Amounts;
  readonly capacity: number;
  readonly population: { readonly amount: number; readonly cap: number; readonly used: number };
  readonly season: Season;
  readonly gameDate: string;
  /** 下一件會完成的事（所有佇列裡最接近的未來）；null = 全部閒置 */
  readonly next: NextCompletion | null;
}

export async function loadHud(): Promise<HudState | null> {
  const me = await currentPlayer();
  if (!me) return null;

  const state = await loadAndSettle(me.playerId);
  const now = await serverNow();

  const derived = deriveRates({
    citadel: state.build.citadel,
    depotLevel: state.build.slots.D.building === "DEPOT" ? state.build.slots.D.level : 0,
    tiles: state.tiles,
    bandBonus: state.bandBonus,
  });
  const season = SEASON_MODIFIERS[state.season];
  const perHour = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    perHour[r] = derived.baseRates[r] * season.production;
  }
  perHour.grain -= outpostUpkeep(derived.outpostLevels).grain * season.upkeep;

  const next = nearestCompletion(
    [
      {
        label:
          state.build.coreQueue?.target === "CITADEL"
            ? "主堡"
            : slotLabel(
                state.build.coreQueue?.target
                  ? state.build.slots[state.build.coreQueue.target].building
                  : null,
              ),
        doneAt: state.build.coreQueue?.doneAt ?? null,
      },
      ...state.build.territoryQueue.map((q) => ({ label: "領土", doneAt: q?.doneAt ?? null })),
      { label: "招募", doneAt: state.train.militiaQueue?.doneAt ?? null },
      ...Object.values(state.train.queues).map((q) => ({
        label: "招募",
        doneAt: q?.doneAt ?? null,
      })),
    ],
    now,
  );

  return {
    serverTime: now,
    resources: state.economy.resources,
    perHour,
    capacity: derived.capacity,
    population: {
      amount: state.economy.population.amount,
      cap: derived.populationCap,
      used: state.economy.population.used,
    },
    season: state.season,
    gameDate: formatGameDateWithSeason(toGameDate(state.seasonStartedAt, now)),
    next,
  };
}
