import { CITADEL, SEASON_MODIFIERS } from "@/lib/game/balance";
import { SEASON_LABEL } from "@/lib/game/calendar";
import { planCoreBuild, type CoreSlot } from "@/lib/game/build";
import { deriveRates, outpostUpkeep } from "@/lib/game/economy-state";
import { BaseView, type CoreSlotView } from "@/components/base/BaseView";
import { BriefingCard } from "@/components/steward/BriefingCard";
import { constructCore, trainUnits, upgradeCore } from "@/app/actions/base";
import { producersOf, unlockedUnits } from "@/lib/game/train";
import { CORE_BUILDING } from "@/lib/game/balance";
import type { TrainQueueView } from "@/components/base/ArmyPanel";
import {
  acknowledgeBriefing,
  loadStewardBriefing,
} from "@/app/actions/steward";
import { loadAndSettle } from "@/lib/server/player-state";
import { zeroAmounts } from "@/lib/game/settle";
import { formatGameDateWithSeason, toGameDate } from "@/lib/game/calendar";
import { serverNow } from "@/lib/time";
import type { Briefing } from "@/lib/server/steward";

export const metadata = { title: "據點 · RuinCity" };
export const dynamic = "force-dynamic";

/**
 * 據點。
 *
 * 每次載入都會**先結算**（`loadAndSettle`）——「快照 + 速率」模型下，
 * 讀取的那一刻才把離線期間的資源補算回來（`docs/03` §2.2）。
 */
export default async function BasePage() {
  let state: Awaited<ReturnType<typeof loadAndSettle>> | null = null;
  let error: string | null = null;

  let briefing: Briefing | null = null;

  try {
    // 賽季登記流程在 M5，所以這裡可能找不到玩家
    state = await loadAndSettle(await currentPlayerId());
    briefing = await loadStewardBriefing();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (!state) {
    return (
      <main className="mx-auto max-w-md px-6 py-16 text-[#e8dcc0]">
        <h1 className="text-2xl font-bold">據點</h1>
        <p className="mt-3 text-sm leading-relaxed opacity-80">
          你還沒有進行中的賽季。賽季登記與開局配置在 M5 實作 （見{" "}
          <code>docs/13-season-registration.md</code>）。
        </p>
        <p className="mt-4 rounded bg-[#2e2723] p-3 text-xs opacity-70">
          {error}
        </p>
      </main>
    );
  }

  const derived = deriveRates({
    citadel: state.build.citadel,
    depotLevel:
      state.build.slots.D.building === "DEPOT" ? state.build.slots.D.level : 0,
    tiles: state.tiles,
    bandBonus: state.bandBonus,
  });
  const season = SEASON_MODIFIERS[state.season];

  const perHour = zeroAmounts();
  for (const r of ["grain", "timber", "stone", "iron"] as const) {
    perHour[r] = derived.baseRates[r] * season.production;
  }
  perHour.grain -= outpostUpkeep(derived.outpostLevels).grain * season.upkeep;

  // ★ 不是 `Date.now()`。時間一律走 `serverNow()`（CLAUDE.md 第三條界線），
  //   而且 React Compiler 也不允許在 render 中呼叫不純函式。
  const now = await serverNow();
  const slotViews: CoreSlotView[] = [
    {
      slot: "A",
      building: "CITADEL",
      level: state.build.citadel,
      next: planFor(state, "CITADEL", now),
    },
    ...(["B", "C", "D"] as const).map((slot) => ({
      slot,
      building: state!.build.slots[slot].building,
      level: state!.build.slots[slot].level,
      next: planFor(state!, slot, now),
    })),
  ];

  return (
    <>
      {briefing ? (
        <div className="mx-auto max-w-md px-4 pt-4">
          <BriefingCard
            briefing={briefing}
            gameDate={formatGameDateWithSeason(
              toGameDate(state.seasonStartedAt, now),
            )}
            onAcknowledge={acknowledgeBriefing}
          />
        </div>
      ) : null}
      <BaseView
        citadel={state.build.citadel}
        resources={state.economy.resources}
        perHour={perHour}
        capacity={derived.capacity}
        population={{
          amount: state.economy.population.amount,
          cap: derived.populationCap,
          used: state.economy.population.used,
          rate: derived.populationRate,
        }}
        territory={{
          used: state.tiles.length,
          cap: derived.territoryCapacity,
          isolated: state.tiles.filter((t) => t.state === "ISOLATED").length,
        }}
        slots={slotViews}
        coreQueue={{ label: "", doneAt: state.build.coreQueue?.doneAt ?? null }}
        territoryQueues={state.build.territoryQueue.map((q) => ({
          label: "",
          doneAt: q?.doneAt ?? null,
        }))}
        seasonLabel={SEASON_LABEL[state.season]}
        serverTime={now}
        army={{
          garrison: state.garrison,
          unlocked: unlockedUnits(state.build.slots),
          resources: state.economy.resources,
          capacity: derived.capacity,
          freePopulation: Math.max(
            0,
            state.economy.population.cap - state.economy.population.used,
          ),
          queues: trainQueueViews(state),
          onTrain: trainUnits,
        }}
        onUpgrade={upgradeCore}
        onConstruct={constructCore}
      />
    </>
  );
}

function planFor(
  state: Awaited<ReturnType<typeof loadAndSettle>>,
  target: "CITADEL" | CoreSlot,
  now: number,
): CoreSlotView["next"] {
  const plan = planCoreBuild(state.build, target, now);
  if ("reason" in plan)
    return { cost: zeroAmounts(), seconds: 0, blocked: plan.reason };
  if (target === "CITADEL" && state.build.citadel >= CITADEL.maxLevel) {
    return { cost: zeroAmounts(), seconds: 0, blocked: "CITADEL_MAXED" };
  }
  return { cost: plan.cost, seconds: plan.seconds, blocked: null };
}

/**
 * 招募佇列的顯示。民兵永遠有一條（不需要任何建築），
 * 每一座生產建築再各給一條。
 */
function trainQueueViews(
  state: Awaited<ReturnType<typeof loadAndSettle>>,
): TrainQueueView[] {
  const out: TrainQueueView[] = [
    {
      producer: null,
      label: "民兵",
      doneAt: state.train.militiaQueue?.doneAt ?? null,
    },
  ];
  for (const p of producersOf(state.build.slots)) {
    out.push({
      producer: p.building,
      label: `${CORE_BUILDING[p.building].label} Lv${p.level}`,
      doneAt: state.train.queues[p.building]?.doneAt ?? null,
    });
  }
  return out;
}

async function currentPlayerId(): Promise<number> {
  const { auth } = await import("@/auth");
  const { getDb, schema } = await import("@/lib/db");
  const { and, eq } = await import("drizzle-orm");

  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error("尚未登入");

  const [row] = await getDb()
    .select({ playerId: schema.players.id })
    .from(schema.players)
    .innerJoin(schema.users, eq(schema.players.userId, schema.users.id))
    .innerJoin(schema.seasons, eq(schema.players.seasonId, schema.seasons.id))
    .where(
      and(eq(schema.users.email, email), eq(schema.seasons.status, "RUNNING")),
    )
    .limit(1);

  if (!row) throw new Error("找不到進行中的賽季角色");
  return row.playerId;
}
