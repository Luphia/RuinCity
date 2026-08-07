/**
 * 賽季模擬 —— 在寫任何 UI 之前先驗證數值平衡。
 *
 *   pnpm tsx scripts/simulate-season.ts [--runs 10] [--seed 42] [--json] [--trace]
 *
 * ## 這個模擬涵蓋什麼
 *
 * 經濟與軍事的**時間曲線**：四種資源各自的產出、儲存上限的壓迫、
 * 核心佇列（主堡／兵營／倉庫三選一）的競爭、領土佇列的拓荒與升級抉擇、
 * 人口累積、招兵、養兵糧耗、四季係數、遺跡軍團成長。
 *
 * ## 這個模擬**還不**涵蓋什麼（誠實聲明）
 *
 * 地圖是空間性的，而 M1 還沒做。因此以下項目**無法**在這裡驗證，
 * 必須等地圖生成器完成後才能跑：
 *
 *   - 出生點的五項公平性驗證（需要真實地形與 Voronoi 分割）
 *   - 區域軍隊容量與超限損耗（需要玩家的實際座標）
 *   - 行軍距離、遠征可行性、前哨營補給線
 *   - 領土連通性與「切細頸」戰術
 *   - 斬首圍城（需要主旗座標與解圍行軍）
 *   - 玩家之間的互相掠奪（沒有座標就沒有鄰居）
 *
 * 遺跡軍團的清剿時點**部分**依賴空間（行軍可達性、區域容量），
 * 這裡只能用「聯盟可投入的遠征比例」粗略代理，結果標記為指示性。
 *
 * ## 玩家模型
 *
 * 這不是 AI，是一個**稱職玩家的貪婪啟發式**：每次佇列空出來時，
 * 在可負擔的選項裡挑「單位成本的邊際產出」最高的那一個。
 * 真人會比這個好一點（會看地形、會卡時機），執政官會差一點 ——
 * 兩者的差距由 EFFICIENCY 表示。
 */

import {
  CAMPS,
  CITADEL,
  CLAIM,
  FACILITY,
  FACILITY_SCALING,
  LEGION,
  MARCH,
  POPULATION,
  RUIN,
  ROSTER,
  SEASON_MODIFIERS,
  SPAWN_BAND,
  TERRAIN,
  TECH,
  TECHS,
  TIME_SCALE,
  UNIT,
  type Tech,
  type Season,
  type Unit,
} from "../lib/game/balance";
import { seasonOfMonth } from "../lib/game/calendar";
import { mulberry32, shuffle } from "../lib/game/rng";
import { resolveBattle } from "../lib/game/combat";
import { generateWorld } from "../lib/game/map/world";
import { randomSquads } from "../lib/game/map/spawn";
import { regionOf } from "../lib/game/map/regions";
import {
  buildProfiles,
  terrainMultiplier,
  type PlayerProfile,
  type SpatialProfiles,
} from "../lib/game/map/profile";
import {
  armyPopulation,
  citadelBaseYieldPerHour,
  citadelUpgradeCost,
  citadelUpgradeSeconds,
  coreBuildingCost,
  coreBuildingSeconds,
  facilityCost,
  facilitySeconds,
  facilityYieldPerHour,
  innateDefense,
  outpostCap,
  overflowAttrition,
  populationGrowthPerHour,
  regionCapacity,
  storageCapacity,
  techCost,
  techSeconds,
  vaultProtection,
  territoryQueues,
  trainSeconds,
  upkeepPerHour,
} from "../lib/game/formulas";

// ─────────────────────────────────────────────────────────────
// 資源與設施
// ─────────────────────────────────────────────────────────────

type Res = "grain" | "timber" | "stone" | "iron";
const RES: readonly Res[] = ["grain", "timber", "stone", "iron"];

type ProdFacility = "FARM" | "SAWMILL" | "QUARRY" | "MINE";
const PROD: readonly ProdFacility[] = ["FARM", "SAWMILL", "QUARRY", "MINE"];
const PRODUCES: Record<ProdFacility, Res> = {
  FARM: "grain",
  SAWMILL: "timber",
  QUARRY: "stone",
  MINE: "iron",
};

type Bundle = Partial<Record<Res, number>>;

/**
 * 玩家想要的**產出配比**，由賽季末的實際消耗反推：
 *
 *   糧食  養 2,400 兵 ≈ 9,600/h ＋ 招募 ≈ 1,980/h
 *   木材  建築 ≈ 6,900/h（主堡 L26 一次就要 44,897）
 *   石料  只有建築吃，≈ 5,000/h
 *   鐵    招募 ≈ 1,980/h ＋ 建築 ≈ 2,700/h
 *
 * ★ 這個配比是**玩家行為模型**，不是數值表的一部分。
 *   舊版用固定權重，結果貪婪演算法蓋了 58 座農田卻只有 1 座礦坑 ——
 *   木材見底，主堡與招兵同時卡死。真實玩家會看自己缺什麼。
 */
const TARGET_MIX: Record<Res, number> = { grain: 0.41, timber: 0.24, stone: 0.18, iron: 0.17 };

/**
 * 動態邊際估值：缺的貴、滿的便宜。
 *
 * 兩個項相乘 ——
 *   ① 產出配比缺口：目標佔比 ÷ 實際佔比
 *   ② 倉儲飽和度：已經頂到上限的資源，多產一點毫無意義
 */
function valuation(
  y: Record<Res, number>,
  stock: Record<Res, number>,
  cap: number,
  upkeep: number,
) {
  // 養兵的糧耗會吃掉配比 —— 軍隊愈大，農田愈值錢。
  // 少了這一項，玩家會在中期把配比凍結在「軍隊還很小」的比例上，
  // 然後在冬季發現自己養不起任何一支像樣的部隊。
  const grainPressure = Math.min(3, Math.max(0.6, upkeep / Math.max(1, y.grain)));
  const target: Record<Res, number> = { ...TARGET_MIX };
  target.grain *= grainPressure;
  let norm = 0;
  for (const r of RES) norm += target[r];

  let total = 0;
  for (const r of RES) total += y[r];
  const v: Record<Res, number> = { grain: 1, timber: 1, stone: 1, iron: 1 };
  for (const r of RES) {
    const share = total > 0 ? y[r] / total : 0.25;
    const deficit = target[r] / norm / Math.max(share, 0.02);
    const fullness = Math.min(1, stock[r] / cap);
    v[r] = Math.min(8, deficit) * Math.max(0.05, 1 - fullness ** 3);
  }
  return v;
}

function worth(b: Bundle, value: Record<Res, number>): number {
  let v = 0;
  for (const r of RES) v += (b[r] ?? 0) * value[r];
  return Math.max(1, v);
}

/** 非產出設施（哨塔／前哨營／集市）的平均造價 */
const SUPPORT_COST: Bundle = { timber: 330, stone: 300, iron: 100 };
/** 領土中用於哨塔／前哨營／集市的比例（不產出，但補給與預警需要） */
const SUPPORT_SHARE = 0.25;

// ─────────────────────────────────────────────────────────────
// 可調旋鈕
// ─────────────────────────────────────────────────────────────

/**
 * 數值旋鈕。**這裡是模擬的搜尋空間，不是遊戲的真相** ——
 * 找到好的組合之後要寫回 `docs/11` 與 `/lib/game/balance`，再把倍率歸 1。
 *
 * `--sweep` 會在這幾個維度上網格搜尋，找出最貼近 `docs/03` §6 目標曲線的組合。
 */
interface Tune {
  /** 主堡與核心建築的成本倍率 */
  citadelCost: number;
  /** 領土設施的成本倍率 */
  facilityCost: number;
  /** 設施產出倍率 */
  yieldMul: number;
  /** 拓荒成本倍率 */
  claimCost: number;
  /** 領土容量／主堡等級（數值表為 4） */
  territoryPerLevel: number;
  /** 主堡成本成長率的增量（數值表為 1.28 → 實際 1.28 + d） */
  citadelGrowthDelta: number;
  /** 設施成本成長率的增量（數值表為 1.32 → 實際 1.32 + d） */
  facilityGrowthDelta: number;
  /** 冬季產出係數（數值表為 0.55） */
  winterProduction: number;
  /** 冬季糧耗係數（數值表為 1.4） */
  winterUpkeep: number;
  /** 主堡等級上限（數值表為 30） */
  maxCitadel: number;
  /** 設施等級上限的除數（數值表為 2 → ⌊L/2⌋） */
  facilityCapDivisor: number;
  /** 人口上限係數（數值表為 60） */
  popCoefficient: number;
  /** 主堡與核心建築的建造時間倍率 */
  citadelTimeMul: number;
}

/** 全部為 1／取自數值表 —— 旋鈕只在 `--sweep` 或手動覆寫時偏離 */
const BASE_TUNE: Tune = {
  citadelCost: 1,
  facilityCost: 1,
  yieldMul: 1,
  claimCost: 1,
  territoryPerLevel: CITADEL.territoryCapacityPerLevel,
  citadelGrowthDelta: 0,
  facilityGrowthDelta: 0,
  winterProduction: SEASON_MODIFIERS.WINTER.production,
  winterUpkeep: SEASON_MODIFIERS.WINTER.upkeep,
  maxCitadel: CITADEL.maxLevel,
  facilityCapDivisor: FACILITY_SCALING.levelCapDivisor,
  popCoefficient: POPULATION.cap.coefficient,
  citadelTimeMul: 1,
};

/** 天花板全部走這三個包裝，才能在 --sweep 裡一起搜 */
const maxCitadel = () => T.maxCitadel;
const facilityCapOf = (citadel: number) => Math.floor(citadel / T.facilityCapDivisor);
const populationCapOf = (citadel: number) =>
  Math.round(T.popCoefficient * citadel ** POPULATION.cap.exponent);

let T: Tune = BASE_TUNE;
let PLAYER_COUNT: number = ROSTER.playersTotal;

const scaled = (b: Bundle, k: number): Record<Res, number> => ({
  grain: (b.grain ?? 0) * k,
  timber: (b.timber ?? 0) * k,
  stone: (b.stone ?? 0) * k,
  iron: (b.iron ?? 0) * k,
});

/** 把成長率從 g 改成 g + d，等價於整體乘上 ((g+d)/g)^(L-1) */
const growthShift = (level: number, base: number, delta: number) =>
  delta === 0 ? 1 : ((base + delta) / base) ** (level - 1);

const tunedCitadelCost = (level: number) =>
  scaled(citadelUpgradeCost(level), T.citadelCost * growthShift(level, CITADEL.cost.timber.growth, T.citadelGrowthDelta));
const tunedCoreCost = (b: "DEPOT" | "BARRACKS" | "ARCHIVE", level: number) =>
  scaled(coreBuildingCost(b, level), T.citadelCost * growthShift(level, CITADEL.cost.timber.growth, T.citadelGrowthDelta));
const tunedFacilityCost = (f: ProdFacility | "OUTPOST", level: number) =>
  scaled(
    facilityCost(f, level),
    T.facilityCost * growthShift(level, FACILITY_SCALING.costGrowth, T.facilityGrowthDelta),
  );
/**
 * 領土上限 = min(主堡給的容量 + 出生帶加成, **周圍真的有那麼多可用地**)。
 *
 * ★ M1 之前模擬假設地永遠夠用。實際上每人半徑 14 格內、
 *   扣掉山脈與禁建圈、再跟鄰居分攤重疊之後，中位數只有 100 塊，
 *   最少的那位只有 36 塊 —— 遠低於主堡 Lv27 給的 81 塊容量。
 *   有些人是被地圖卡住，不是被資源卡住。
 */
const tunedTerritoryCap = (p: SimPlayer) =>
  Math.min(
    T.territoryPerLevel * p.citadel + SPAWN_BAND[p.profile.band].bonusTerritoryCapacity,
    Math.floor(p.profile.availableTiles),
  );

// ─────────────────────────────────────────────────────────────
// 玩家模型
// ─────────────────────────────────────────────────────────────

/** 玩家的行為原型。決定他把資源往哪裡放，以及有多勤勞。 */
type Archetype = "ACTIVE" | "CASUAL" | "DELEGATED";

interface FacilityGroup {
  count: number;
  /** 該類設施的等級總和（平均等級 = levels / count） */
  levels: number;
}

interface SimPlayer {
  id: number;
  faction: 1 | 2 | 3;
  /** 陣營內的聯盟編號 0–4 */
  alliance: number;
  /** 地圖上的空間事實：座標、鄰居、可用地、地形品質 */
  profile: PlayerProfile;
  archetype: Archetype;
  /** 資源分配傾向：0 = 全部給建設，1 = 全部給軍隊 */
  militaryBias: number;
  /**
   * 決策品質較差（完全委託給執政官）。
   * `docs/18`：執政官是執行者不是決策者 —— 它會挑最近的格、不挑地形、
   * 不為冬季屯糧。所以差距不只是「做得少」，而是「做的選擇比較差」。
   */
  suboptimal: boolean;
  /**
   * 屯糧紀律（1 = 教科書級，0.45 = 打到哪算到哪）。
   *
   * 沒有這個離散度，全體玩家會在同一個安全邊際上同時收手，
   * 冬季要嘛全體平安、要嘛全體餓死 —— 而真實的冬天是**有人被餓到、
   * 有人沒有**，被餓到的那些人正是秋季把糧食全押成兵的那批。
   */
  discipline: number;

  citadel: number;
  barracks: number;
  depot: number;
  /**
   * 檔案館。B/C/D 三格的第三格 —— 它解鎖科技樹，
   * 而科技是後期唯一還在吃資源的地方（見 `11` §14）。
   */
  archive: number;
  /** 各科技等級 */
  tech: Record<Tech, number>;
  /** 研究佇列剩餘（小時）。研究不佔核心佇列，但吃同一份資源 */
  researchUntil: number;

  fac: Record<ProdFacility, FacilityGroup>;
  /** 前哨營：不產出，但每級給 5,000 儲存 —— 後期主堡能不能上去全看它 */
  outposts: FacilityGroup;
  /** 哨塔與集市：不產出、不給儲存，但預警與交易需要 */
  supportTiles: number;

  res: Record<Res, number>;

  /** 可用人口（累積型資源） */
  population: number;
  army: Partial<Record<Unit, number>>;

  /** 核心佇列剩餘（小時）—— 主堡與 B/C/D 共用，永遠只有一條 */
  coreQueueUntil: number;
  /** 領土佇列剩餘（小時） */
  territoryQueueUntil: number[];

  /** 統計 */
  starvedTotal: number;
  /**
   * ★ 佇列閒置時數。這是 `docs/18` §12 唯一驗得到「執政官沒越界」的指標。
   *
   * 執政官補的是**領土**佇列，核心佇列它碰都不碰 ——
   * 所以完全委託的玩家，核心佇列的閒置率必須**比積極玩家高**。
   * 一旦這個數字掉下來，就代表某處的自動化偷偷伸手進了核心佇列，
   * 而核心佇列是整套取捨系統的命脈。
   */
  coreIdleHours: number;
  territoryIdleSlotHours: number;
  territorySlotHours: number;
  /** 掠奪：發動、被打、搶到的糧食、被搶走的資源、戰損 */
  raidsLaunched: number;
  raidsWon: number;
  raidsSuffered: number;
  lootedGrain: number;
  lostToRaids: number;
  battleLosses: number;
  /** 因區域超限而損失的人口 */
  overflowLosses: number;
  /** 資源會計：總產出、實際入庫、花掉的、因為滿倉而蒸發的 */
  produced: number;
  spent: number;
  wasted: number;
  /** 遊戲月 1–2 有沒有被捲入任何**玩家之間**的戰鬥 */
  earlyCombat: boolean;
  /** 清掉的廢土營地數與收穫 */
  campsCleared: number;
  campLoot: number;
  /** 冬季餓死的部隊數 */
  winterStarved: number;
  /** 冬季「產出養不起現有軍隊」的小時數 —— 這才是冬季壓力的本體 */
  winterDeficitHours: number;
  peakArmyPop: number;
  blockedByStorageHours: number;
  /** 核心佇列真正在動工的小時數 —— 佇列如果常常閒著，「唯一一條核心佇列」就不是取捨 */
  coreBusyHours: number;
  /** 領土佇列因為付不出資源而空轉的小時數 */
  territoryIdleHours: number;
}

const ARCHETYPE_MIX: Record<Archetype, number> = {
  ACTIVE: 0.25,
  CASUAL: 0.5,
  DELEGATED: 0.25,
};

/** 執政官對「回本速度」的敏感度（1 = 跟真人一樣會算，0 = 只挑最便宜的） */
const STEWARD_ROI_AWARENESS = 0.35;

/**
 * ★ 手動操作的責任週期。
 *
 * `docs/03` §7.2：**核心佇列與軍事永遠手動，執政官不碰**。
 * 所以完全委託的玩家不是「做得慢一點」，而是**主堡、兵營與招兵
 * 只在他上線的時候才會動** —— 領土那條線倒是全自動。
 *
 * 這才是 `docs/18` §12 那個 75–85% 的來源：
 * 自動化補得了勤奮，補不了判斷，也補不了它根本不被允許碰的東西。
 */
const MANUAL_DUTY: Record<Archetype, number> = {
  ACTIVE: 1.0,
  CASUAL: 0.85,
  DELEGATED: 0.26,
};

/**
 * ★ 陣營性格：`docs/13` §2.1 說三座遺跡的增益不同 → 選陣營等於宣告玩法傾向
 * → 同區玩家玩法相似 → **區域自然演化出不同的性格**。
 *
 * 「鐵搖籃區第一週就打成一片，穹窖區安靜種田到第三週」不是敘事修辭，
 * 它是可模擬的：把 militaryBias 依陣營偏移就會出現。
 *
 * 少了這一項，三個陣營在模擬裡完全對稱，於是三座遺跡總是同一個月被清空 ——
 * `docs/17` §7 的「三座全部在夏季清空 < 15%」永遠不可能成立。
 */
const FACTION_MILITARY_BIAS: Record<1 | 2 | 3, number> = {
  1: 0.15, // 灰燼氏族：行軍 +20% → 機動掠奪流
  2: -0.18, // 穹窖商會：資源 +25% → 發育流，最晚出兵
  3: 0.1, // 鐵搖籃盟：攻防 +12% → 戰鬥流
};

/**
 * 領土佇列的操作效率 —— 執政官會補空檔，所以這條線的差距小得多。
 * 完全委託者慢在「不挑地形、不卡時機」，不是慢在沒人操作。
 */
const EFFICIENCY: Record<Archetype, number> = {
  ACTIVE: 1.0,
  CASUAL: 0.95,
  DELEGATED: 0.88,
};

/**
 * ★ 發展度：一位玩家把「主堡 Lv30 的完全體」走完了幾成。
 *
 * 四條軸各自對照它在主堡滿級時的理論上限。權重給主堡最重，
 * 因為它同時決定其他三條的天花板 —— 它不是四分之一，是那個閘門本身。
 *
 * 設計目標：**第 80 百分位的玩家剛好完成 80%**。
 * 也就是說五個人裡有一個能推過八成，其餘的人在賽季結束時
 * 手上都還有明確的下一步 —— 天花板要看得見，但摸不到。
 */
const DEV_WEIGHTS = {
  citadel: 0.3,
  territory: 0.2,
  facility: 0.175,
  army: 0.175,
  tech: 0.15,
} as const;

function developmentIndex(p: SimPlayer): number {
  const maxLevel = maxCitadel();
  const maxTerritory = T.territoryPerLevel * maxLevel;
  const maxFacility = facilityCapOf(maxLevel);
  const maxArmy = populationCapOf(maxLevel);

  let facCount = 0;
  let facLevels = 0;
  for (const f of PROD) {
    facCount += p.fac[f].count;
    facLevels += p.fac[f].levels;
  }
  const avgFacility = facCount > 0 ? facLevels / facCount : 0;

  return (
    DEV_WEIGHTS.citadel * Math.min(1, p.citadel / maxLevel) +
    DEV_WEIGHTS.territory * Math.min(1, territoryOf(p) / maxTerritory) +
    DEV_WEIGHTS.facility * Math.min(1, avgFacility / maxFacility) +
    DEV_WEIGHTS.army * Math.min(1, armyPopulation(p.army) / maxArmy) +
    DEV_WEIGHTS.tech * Math.min(1, totalTechLevels(p) / MAX_TECH_LEVELS)
  );
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i]!;
}

function territoryOf(p: SimPlayer): number {
  let n = p.supportTiles + p.outposts.count;
  for (const f of PROD) n += p.fac[f].count;
  return n;
}

function capacityOf(p: SimPlayer): number {
  return storageCapacity(p.citadel, p.depot, p.outposts.levels);
}

// ─────────────────────────────────────────────────────────────
// 模擬
// ─────────────────────────────────────────────────────────────

const HOURS_PER_MONTH = 24;
const TOTAL_HOURS = 12 * HOURS_PER_MONTH;

/** 遠征時能離家的兵力比例 —— 其餘必須留守，否則主堡是空的 */
const EXPEDITION_SHARE = 0.55;

/** 一個遊戲月裡，遠征軍實際壓在遺跡上的小時數 */
const SIEGE_HOURS_PER_MONTH = 6;

/** 聯盟願意超出區域容量多少倍 —— 超過的部分持續失血 */
const OVERCOMMIT_TOLERANCE = 1.25;

interface LegionState {
  ruinId: 1 | 2 | 3;
  population: number;
  cleared: boolean;
  clearedMonth: number | null;
}

interface MonthSnapshot {
  month: number;
  season: Season;
  medianCitadel: number;
  medianTerritory: number;
  medianArmyPop: number;
  medianFacilityLevel: number;
  negativeGrainShare: number;
  storageBlockedShare: number;
  /** 本月有部隊餓死的玩家比例 */
  starvingShare: number;
}

interface BattleTally {
  month: number;
  season: Season;
  battles: number;
  /** 攻守人口比 > 5:1 的戰鬥（大打小） */
  lopsided: number;
  /** 第 1 天（遊戲月 1）被攻擊的新手實際損失的資源 */
  day1Losses: number[];
}

interface SeasonResult {
  players: SimPlayer[];
  legions: LegionState[];
  monthly: MonthSnapshot[];
  battles: BattleTally[];
  camps: CampPool;
}

function makePlayers(rand: () => number, spatial: SpatialProfiles): SimPlayer[] {
  const players: SimPlayer[] = [];
  const archetypes: Archetype[] = [];
  for (const [a, share] of Object.entries(ARCHETYPE_MIX)) {
    const n = Math.round(PLAYER_COUNT * share);
    for (let i = 0; i < n; i++) archetypes.push(a as Archetype);
  }
  while (archetypes.length < PLAYER_COUNT) archetypes.push("CASUAL");
  shuffle(rand, archetypes);

  for (let i = 0; i < PLAYER_COUNT; i++) {
    const profile = spatial.players[i]!;
    // 出生帶的起始加成（`docs/01` §5.4）：邊陲 +40% 資源、前線 +1 領土容量
    const mult = SPAWN_BAND[profile.band].startingResourceMultiplier;
    players.push({
      id: i,
      faction: profile.faction,
      alliance: profile.alliance,
      profile,
      archetype: archetypes[i] ?? "CASUAL",
      // 0.25–0.75，讓流派自然分散
      militaryBias: Math.min(
        0.9,
        Math.max(0.1, 0.25 + rand() * 0.5 + FACTION_MILITARY_BIAS[profile.faction]),
      ),
      suboptimal: (archetypes[i] ?? "CASUAL") === "DELEGATED",
      discipline: 0.45 + rand() * 0.95,
      citadel: 1,
      barracks: 0,
      depot: 0,
      archive: 0,
      tech: Object.fromEntries(TECHS.map((t) => [t, 0])) as Record<Tech, number>,
      researchUntil: 0,
      // 初始 4 × 4 據點：一格主堡 + 每類產出設施各一座 Lv1
      fac: {
        FARM: { count: 1, levels: 1 },
        SAWMILL: { count: 1, levels: 1 },
        QUARRY: { count: 1, levels: 1 },
        MINE: { count: 1, levels: 1 },
      },
      outposts: { count: 0, levels: 0 },
      supportTiles: 0,
      res: {
        grain: 500 * mult,
        timber: 500 * mult,
        stone: 500 * mult,
        iron: 200 * mult,
      },
      population: 0,
      army: { MILITIA: 10 },
      coreQueueUntil: 0,
      territoryQueueUntil: [0],
      starvedTotal: 0,
      coreIdleHours: 0,
      territoryIdleSlotHours: 0,
      territorySlotHours: 0,
      winterDeficitHours: 0,
      raidsLaunched: 0,
      raidsWon: 0,
      raidsSuffered: 0,
      lootedGrain: 0,
      lostToRaids: 0,
      battleLosses: 0,
      overflowLosses: 0,
      produced: 0,
      spent: 0,
      wasted: 0,
      earlyCombat: false,
      campsCleared: 0,
      campLoot: 0,
      winterStarved: 0,
      peakArmyPop: 10,
      blockedByStorageHours: 0,
      coreBusyHours: 0,
      territoryIdleHours: 0,
    });
  }
  return players;
}

/**
 * 設施產出。**地形是真的了** ——
 * 伐木場蓋在森林是 ×1.25、礦坑蓋在礦脈是 ×1.4，但好地有限，
 * 蓋到第 30 座時就只剩平原甚至荒地（見 `map/profile.ts`）。
 */
/** 耕作：糧食產出 +4%/級 */
const cultivationBonus = (p: SimPlayer) => p.tech.CULTIVATION * TECH.CULTIVATION.perLevel;
/** 開採：木石鐵產出 +4%/級 */
const extractionBonus = (p: SimPlayer) => p.tech.EXTRACTION * TECH.EXTRACTION.perLevel;

function techYieldBonus(p: SimPlayer, f: ProdFacility): number {
  return f === "FARM" ? cultivationBonus(p) : extractionBonus(p);
}

function totalTechLevels(p: SimPlayer): number {
  let n = 0;
  for (const t of TECHS) n += p.tech[t];
  return n;
}

/** 全部科技點滿的總等級數 —— 發展度的分母之一 */
const MAX_TECH_LEVELS = TECHS.reduce((s, t) => s + TECH[t].maxLevel, 0);

function facYield(
  p: SimPlayer,
  f: ProdFacility,
  level: number,
  count: number,
  season: (typeof SEASON_MODIFIERS)[Season],
): number {
  // terrainMultiplier 已經涵蓋地形，所以這裡用 PLAIN（倍率 1.0）當基準
  return (
    facilityYieldPerHour(f, level, "PLAIN", { season, techBonus: techYieldBonus(p, f) }) *
    terrainMultiplier(p.profile, f, count) *
    T.yieldMul
  );
}

function yieldOf(p: SimPlayer, season: (typeof SEASON_MODIFIERS)[Season]): Record<Res, number> {
  const out: Record<Res, number> = { grain: 0, timber: 0, stone: 0, iron: 0 };
  for (const f of PROD) {
    const g = p.fac[f];
    if (g.count <= 0 || g.levels <= 0) continue;
    // 非空間模擬：地形一律視為平原（TERRAIN_YIELD 對 PLAIN 無修正）。
    // 真實地圖上玩家會把伐木場蓋在森林、礦坑蓋在礦脈，
    // 所以這裡是**偏保守**的估計。
    out[PRODUCES[f]] += facYield(p, f, g.levels / g.count, g.count, season) * g.count;
  }
  const base = citadelBaseYieldPerHour(p.citadel, season);
  for (const r of RES) out[r] += base;
  return out;
}

function canAfford(p: SimPlayer, cost: Bundle): boolean {
  for (const r of RES) if (p.res[r] < (cost[r] ?? 0)) return false;
  return true;
}

function pay(p: SimPlayer, cost: Bundle) {
  for (const r of RES) {
    const v = cost[r] ?? 0;
    p.res[r] -= v;
    p.spent += v;
  }
}

/** 這筆開銷是否**永遠**存不到（超過儲存上限）—— 倉庫的存在理由 */
function exceedsStorage(p: SimPlayer, cost: Bundle): boolean {
  const cap = capacityOf(p);
  for (const r of RES) if ((cost[r] ?? 0) > cap) return true;
  return false;
}

/**
 * 兵營的合理目標等級。
 *
 * 兵營每級只給 +5% 招募速度，而招募的瓶頸從來不是速度而是人口與資源，
 * 所以真實玩家把兵營蓋到解鎖劍士（Lv5）／弓手（Lv7）之後就會收手。
 * 舊版讓兵營跟著主堡一路長到 21 級，白白吃掉整條核心佇列。
 */
/**
 * 倉庫的合理目標等級 = 剛好能存下「再往上兩級主堡」最貴的那一項，留 15% 餘裕。
 *
 * 舊版讓核心佇列在沒事做的時候無限往上堆倉庫，結果倉庫衝到 27 級、
 * 儲存上限 71,390 —— 資源上限完全不再是約束，這是模擬的假象。
 * 真實玩家蓋倉庫是為了解鎖下一級主堡，不是為了看數字變大。
 */
function depotTarget(p: SimPlayer): number {
  const c = tunedCitadelCost(Math.min(maxCitadel(), p.citadel + 2));
  const need = Math.max(c.timber ?? 0, c.stone ?? 0, c.iron ?? 0) * 1.15;
  let lvl = 0;
  while (lvl < p.citadel && storageCapacity(p.citadel, lvl, p.outposts.levels) < need) lvl++;
  return lvl;
}

function barracksTarget(p: SimPlayer): number {
  return Math.min(p.citadel, Math.round(7 + p.militaryBias * 8));
}

/**
 * 檔案館的目標等級。
 *
 * 研究速度 +6%/級，而科技本身是後期唯一還吃得下資源的地方，
 * 所以發育傾向（militaryBias 低）的玩家會把它推得比較高。
 * 它跟主堡、兵營、倉庫**共用那條唯一的核心佇列** ——
 * 這才是「每一分鐘你在升主堡，就是一分鐘你沒在升檔案館」真正的樣子。
 */
function archiveTarget(p: SimPlayer): number {
  return Math.min(p.citadel, Math.round(6 + (1 - p.militaryBias) * 14));
}

/**
 * 核心佇列：主堡 / 兵營 / 倉庫三選一，永遠只有一條。
 * 依優先序往下找第一個付得起的 —— 付不起就往下讓，不空轉。
 */
function runCoreQueue(p: SimPlayer, hour: number, eff: number, rand: () => number) {
  if (p.coreQueueUntil > hour) return;

  const nextCitadel = tunedCitadelCost(p.citadel + 1);
  const storageBlocked = p.citadel < maxCitadel() && exceedsStorage(p, nextCitadel);

  // ① 倉庫是**先決條件**，不是選項：存不下就永遠升不上去。
  //    這正是「資源上限逼迫玩家做建築取捨」要製造的壓力。
  if (storageBlocked && p.depot < depotTarget(p)) {
    const cost = tunedCoreCost("DEPOT", p.depot + 1);
    if (canAfford(p, cost)) {
      pay(p, cost);
      p.depot++;
      const h = (coreBuildingSeconds("DEPOT", p.depot) * T.citadelTimeMul) / 3600 / eff;
      p.coreQueueUntil = hour + h;
      p.coreBusyHours += h;
      return;
    }
    p.blockedByStorageHours++;
  }

  // ② 兵營：沒有兵營就沒有兵
  if (p.barracks < barracksTarget(p)) {
    const cost = tunedCoreCost("BARRACKS", p.barracks + 1);
    if (canAfford(p, cost)) {
      pay(p, cost);
      p.barracks++;
      const h = (coreBuildingSeconds("BARRACKS", p.barracks) * T.citadelTimeMul) / 3600 / eff;
      p.coreQueueUntil = hour + h;
      p.coreBusyHours += h;
      return;
    }
  }

  // ③ 檔案館：解鎖科技樹。發育流會排在主堡前面
  if (p.archive < archiveTarget(p) && (p.archive === 0 || rand() < 1 - p.militaryBias)) {
    const cost = tunedCoreCost("ARCHIVE", p.archive + 1);
    if (canAfford(p, cost)) {
      pay(p, cost);
      p.archive++;
      const h = (coreBuildingSeconds("ARCHIVE", p.archive) * T.citadelTimeMul) / 3600 / eff;
      p.coreQueueUntil = hour + h;
      p.coreBusyHours += h;
      return;
    }
  }

  // ④ 主堡
  if (!storageBlocked && p.citadel < maxCitadel() && canAfford(p, nextCitadel)) {
    pay(p, nextCitadel);
    p.citadel++;
    const h = (citadelUpgradeSeconds(p.citadel) * T.citadelTimeMul) / 3600 / eff;
    p.coreQueueUntil = hour + h;
    p.coreBusyHours += h;
    return;
  }

  // ⑤ 主堡卡在存量或資源上 → 把倉庫先往上墊（提前為下一級鋪路）
  if (p.depot < depotTarget(p)) {
    const cost = tunedCoreCost("DEPOT", p.depot + 1);
    if (canAfford(p, cost)) {
      pay(p, cost);
      p.depot++;
      const h = (coreBuildingSeconds("DEPOT", p.depot) * T.citadelTimeMul) / 3600 / eff;
      p.coreQueueUntil = hour + h;
      p.coreBusyHours += h;
    }
  }
}

/**
 * 挑下一個要研究的科技：單位成本的效益最高者。
 *
 * 產出類（耕作、開採）直接換成資源，軍事類（鍛造、甲冑）換成戰力，
 * 兩者用 militaryBias 加權 —— 打仗流的人會先點鍛造，發育流先點耕作。
 */
function bestTech(p: SimPlayer): { tech: Tech; cost: Record<Res, number>; hours: number } | null {
  let best: { tech: Tech; cost: Record<Res, number>; hours: number; score: number } | null = null;

  for (const t of TECHS) {
    const level = p.tech[t] + 1;
    if (level > TECH[t].maxLevel) continue;
    // 遺物工藝要遺物，而模擬沒有模擬遺物的取得
    if (TECH[t].cost.relic) continue;

    const raw = techCost(t, level);
    const cost: Record<Res, number> = {
      grain: raw.grain ?? 0,
      timber: raw.timber ?? 0,
      stone: raw.stone ?? 0,
      iron: raw.iron ?? 0,
    };
    if (!canAfford(p, cost)) continue;

    const military = t === "FORGING" || t === "PLATING" || t === "SIEGECRAFT" || t === "MARCHING";
    const weight = military ? p.militaryBias : 1 - p.militaryBias;
    const totalCost = cost.grain + cost.timber + cost.stone + cost.iron;
    const score = (TECH[t].perLevel * weight) / Math.max(1, totalCost);

    if (!best || score > best.score) {
      best = { tech: t, cost, hours: techSeconds(t, level, p.archive) / 3600, score };
    }
  }
  return best;
}

type ActionKind = "SUPPORT" | "OUTPOST" | "OUTPOST_UP" | "CLAIM" | "UPGRADE";

/**
 * 決策結果。**刻意重複使用同一個物件**：這個函式每場模擬會被呼叫
 * 數百萬次，每次配置一個候選陣列會讓 600 人 × 12 天跑不進「幾秒鐘」。
 */
const zeroCost = (): Record<Res, number> => ({ grain: 0, timber: 0, stone: 0, iron: 0 });
const chosen = { kind: "CLAIM" as ActionKind, facility: "FARM" as ProdFacility, hours: 0, cost: zeroCost() };
const candidate = zeroCost();

function copyCost(from: Record<Res, number>, to: Record<Res, number>) {
  to.grain = from.grain;
  to.timber = from.timber;
  to.stone = from.stone;
  to.iron = from.iron;
}

/**
 * 領土佇列：拓荒 vs 升級，挑「單位估值成本能換到的估值產出」最高的。
 *
 * ★ 這是舊版模擬最大的錯誤來源。舊版只有在「領土滿了」之後才升設施，
 *   而領土永遠沒滿（資源不夠），於是所有設施終生停在 Lv1、
 *   產出被鎖死在主堡保底值 —— 整條經濟曲線因此腰斬。
 *   真實玩家不會這樣打：農田 Lv1→Lv2 的回本只要兩小時。
 */
function bestTerritoryAction(
  p: SimPlayer,
  season: (typeof SEASON_MODIFIERS)[Season],
  value: Record<Res, number>,
): typeof chosen | null {
  let bestScore = -Infinity;
  let found = false;
  /**
   * 執政官的評分方式本身就比較差。
   * `docs/18`：它「只選最近的格、不挑地形、不卡時機」——
   * 也就是挑**當下最便宜、最快做完**的，而不是回本最快的。
   */
  const score = p.suboptimal
    ? (gain: number, cost: number) => gain ** STEWARD_ROI_AWARENESS / cost
    : (gain: number, cost: number) => gain / cost;
  const territory = territoryOf(p);
  const facCap = facilityCapOf(p.citadel);

  // ── 拓荒 ──
  if (territory < tunedTerritoryCap(p)) {
    const growth = 1 + territory / CLAIM.costGrowthDivisor;
    const claimGrain = CLAIM.cost.grain * growth * T.claimCost;
    const claimTimber = CLAIM.cost.timber * growth * T.claimCost;
    const hours =
      (CLAIM.baseSeconds * (1 + territory / CLAIM.timeGrowthDivisor)) / TIME_SCALE / 3600;

    const supportCount = p.supportTiles + p.outposts.count;
    if (supportCount / Math.max(1, territory) < SUPPORT_SHARE) {
      // 補給設施（前哨營／哨塔／集市）沒有產出，但補給、儲存與預警需要，
      // 所以不算 ROI —— 比例不足時就是最高優先。
      // 前哨營優先（它同時給儲存與區域容量），額滿之後才鋪哨塔與集市。
      const wantOutpost = p.outposts.count < outpostCap(p.citadel);
      const build = wantOutpost
        ? tunedFacilityCost("OUTPOST", 1)
        : scaled(SUPPORT_COST, T.facilityCost);
      candidate.grain = claimGrain;
      candidate.timber = claimTimber + (build.timber ?? 0);
      candidate.stone = build.stone ?? 0;
      candidate.iron = build.iron ?? 0;
      if (canAfford(p, candidate)) {
        chosen.kind = wantOutpost ? "OUTPOST" : "SUPPORT";
        chosen.hours = hours;
        copyCost(candidate, chosen.cost);
        return chosen;
      }
    } else {
      for (const f of PROD) {
        const build = tunedFacilityCost(f, 1);
        candidate.grain = claimGrain;
        candidate.timber = claimTimber + (build.timber ?? 0);
        candidate.stone = build.stone ?? 0;
        candidate.iron = build.iron ?? 0;
        if (!canAfford(p, candidate)) continue;
        const gain = facYield(p, f, 1, p.fac[f].count + 1, season) * value[PRODUCES[f]];
        const s = score(gain, worth(candidate, value));
        if (s > bestScore) {
          bestScore = s;
          found = true;
          chosen.kind = "CLAIM";
          chosen.facility = f;
          chosen.hours = hours;
          copyCost(candidate, chosen.cost);
        }
      }
    }
  }

  // ── 前哨營升級 ──
  // 只在「儲存上限正卡住主堡」時才做 —— 前哨營沒有產出，
  // 用 ROI 比永遠比不過設施，但它是後期主堡唯一的解鎖鑰匙。
  if (
    p.outposts.count > 0 &&
    p.citadel < maxCitadel() &&
    p.outposts.levels / p.outposts.count < facCap &&
    exceedsStorage(p, tunedCitadelCost(p.citadel + 1))
  ) {
    const next = Math.floor(p.outposts.levels / p.outposts.count) + 1;
    const cost = tunedFacilityCost("OUTPOST", next);
    candidate.grain = 0;
    candidate.timber = cost.timber ?? 0;
    candidate.stone = cost.stone ?? 0;
    candidate.iron = cost.iron ?? 0;
    if (canAfford(p, candidate)) {
      chosen.kind = "OUTPOST_UP";
      chosen.hours = facilitySeconds(next) / 3600;
      copyCost(candidate, chosen.cost);
      return chosen;
    }
  }

  // ── 升級 ──
  for (const f of PROD) {
    const g = p.fac[f];
    if (g.count <= 0) continue;
    const avg = g.levels / g.count;
    if (avg >= facCap) continue;
    const next = Math.floor(avg) + 1;
    const cost = tunedFacilityCost(f, next);
    candidate.grain = cost.grain ?? 0;
    candidate.timber = cost.timber ?? 0;
    candidate.stone = cost.stone ?? 0;
    candidate.iron = cost.iron ?? 0;
    if (!canAfford(p, candidate)) continue;
    const before = facYield(p, f, avg, g.count, season) * g.count;
    const after = facYield(p, f, (g.levels + 1) / g.count, g.count, season) * g.count;
    const s = score((after - before) * value[PRODUCES[f]], worth(candidate, value));
    if (s > bestScore) {
      bestScore = s;
      found = true;
      chosen.kind = "UPGRADE";
      chosen.facility = f;
      chosen.hours = facilitySeconds(next) / 3600;
      copyCost(candidate, chosen.cost);
    }
  }

  return found ? chosen : null;
}

function applyTerritoryAction(p: SimPlayer, a: typeof chosen) {
  switch (a.kind) {
    case "SUPPORT":
      p.supportTiles++;
      return;
    case "OUTPOST":
      p.outposts.count++;
      p.outposts.levels++;
      return;
    case "OUTPOST_UP":
      p.outposts.levels++;
      return;
    default: {
      const g = p.fac[a.facility];
      if (a.kind === "CLAIM") g.count++;
      g.levels++;
    }
  }
}

/**
 * ★ 掠奪：`docs/16` 說冬季飢餓的正解是「去搶」，而 M1 之前模擬不了。
 *
 * 這裡**不寫死季節性的開戰機率**，而是讓玩家算划不划算：
 * 每次評估都真的跑一次 `resolveBattle`，比較搶得到的糧食與預期戰損。
 * 這樣才能檢驗設計文件的那句主張 ——
 * 「戰爭在春天不發生，不是因為被禁止，是因為不划算」。
 */

/**
 * 每小時「有在看地圖找目標」的機率 —— 人不會每小時都在評估要不要出兵。
 *
 * ★ 掠奪與打營地**共用**這一份注意力，而且掠奪優先評估。
 *   分成兩份獨立的機率是錯的：玩家只有一支軍隊、一個晚上。
 *   賽季模擬顯示分開給的時候（營地 0.6、掠奪 0.12）營地會直接把 PvP
 *   擠掉 —— 秋冬戰鬥佔比從 95% 掉到 63%，冬季餓死的人剩 1%。
 *
 *   共用之後它會自己分配：春季掠奪不划算 → 注意力全給營地；
 *   秋冬掠奪開始划算 → 自然轉回 PvP。這正是設計要的節奏。
 */
const MILITARY_ATTENTION = 0.55;

/** 一次出兵最多帶走多少比例的常備軍（其餘必須留守） */
const RAID_COMMIT = 0.6;

/**
 * 一單位糧食相對於一點人口戰損的價值。低於這個比值就不划算。
 *
 * 掠奪用的是**淨賺**的門檻（搶到的東西相對於戰損的邊際價值），
 * 所以不是重置成本 —— 掠奪還有削弱鄰居、搶時間差等等的價值。
 */
const LOOT_PER_CASUALTY_THRESHOLD = 45;

/**
 * 一點人口的**重置成本**，依實際軍隊組成計算。
 *
 * 民兵是 80／人口、長矛兵 140、劍士 220 —— 早期玩家用便宜的兵，
 * 所以他們清得動的營地門檻比後期玩家低。用固定常數會讓新手
 * 完全清不了營地，而那正是他們最需要營地的時候。
 *
 * 打營地跟掠奪不一樣 —— 營地不會反過來打你，也沒有戰略價值，
 * 純粹是一筆買賣。所以判準必須是「獎勵 > 補回這些兵要花的錢」，
 * 用掠奪那個寬鬆的邊際門檻會讓玩家拿主力去換小錢，
 * 賽季模擬裡的軍隊會被營地磨到只剩幾十個人。
 */
function replacementCost(army: Partial<Record<Unit, number>>): number {
  let cost = 0;
  let pop = 0;
  for (const [u, n] of Object.entries(army)) {
    if (!n) continue;
    const spec = UNIT[u as Unit];
    cost += n * (spec.cost.grain + spec.cost.timber + spec.cost.stone + spec.cost.iron);
    pop += n * spec.population;
  }
  return pop > 0 ? cost / pop : 220;
}
/**
 * 還要賺得夠明顯才值得跑這一趟。
 *
 * ★ 這個數字決定了**早期軍隊的規模**。門檻壓低（1.4）時玩家一有兵
 *   就去清營地，損兵與補兵打平，常備軍永遠停在幾十人；
 *   拉高之後玩家會先把軍隊養到「清起來幾乎不掉人」才出門 ——
 *   那才是 `docs/03` §6 說的月 3 有 200–350 兵力的來源。
 */
const CAMP_PROFIT_MARGIN = 2.6;

/** 一趟最多折損多少比例的常備軍 —— 家還要守，兵也不是拋棄式的 */
const CAMP_MAX_CASUALTY_SHARE = 0.1;

function lootableOf(p: SimPlayer, season: (typeof SEASON_MODIFIERS)[Season]): Record<Res, number> {
  const vault = vaultProtection(p.citadel, p.depot, season);
  const out = {} as Record<Res, number>;
  for (const r of RES) out[r] = Math.max(0, p.res[r] - vault);
  return out;
}

/** 某聯盟在某區域的軍隊容納上限（`docs/16` §2） */
function allianceRegionCapacity(
  players: readonly SimPlayer[],
  faction: number,
  alliance: number,
  region: number,
  season: (typeof SEASON_MODIFIERS)[Season],
): number {
  let territoryTiles = 0;
  let outpostLevels = 0;
  let citadelLevels = 0;
  for (const q of players) {
    if (q.faction !== faction || q.alliance !== alliance || q.profile.region !== region) continue;
    territoryTiles += territoryOf(q);
    outpostLevels += q.outposts.levels;
    citadelLevels += q.citadel;
  }
  return regionCapacity({ territoryTiles, outpostLevels, citadelLevels }, season);
}

function playersInRegion(players: readonly SimPlayer[], p: SimPlayer): number {
  let n = 0;
  for (const q of players) {
    if (q.faction === p.faction && q.alliance === p.alliance && q.profile.region === p.profile.region) n++;
  }
  return n;
}

interface RaidContext {
  tally: BattleTally;
  players: SimPlayer[];
  season: (typeof SEASON_MODIFIERS)[Season];
  seasonName: Season;
  month: number;
  rand: () => number;
  /** (陣營, 聯盟, 區域) → 容量，每小時重算一次 */
  capacityCache: Map<string, number>;
}

function tryRaid(attacker: SimPlayer, ctx: RaidContext): boolean {
  const { players, season, rand } = ctx;
  const army = attacker.army;
  const armyPop = armyPopulation(army);
  if (armyPop < 40) return false;

  const neighbours = attacker.profile.neighbours;
  if (neighbours.length === 0) return false;

  // 挑一個非同盟的鄰居。近的優先 —— 行軍時間就是成本
  const pick = neighbours[Math.floor(rand() * Math.min(neighbours.length, 25))];
  if (!pick || pick.sameAlliance) return false;
  const target = players[pick.index];
  if (!target) return false;

  // 出兵規模受**目標所在區域**的容量限制（`docs/16` §2）
  const capKey = `${attacker.faction}:${attacker.alliance}:${target.profile.region}`;
  let cap = ctx.capacityCache.get(capKey);
  if (cap === undefined) {
    cap = allianceRegionCapacity(
      players,
      attacker.faction,
      attacker.alliance,
      target.profile.region,
      season,
    );
    ctx.capacityCache.set(capKey, cap);
  }

  // ★ 超限不是硬性禁止，是持續失血（`docs/16` §2）。
  //   打進聯盟毫無基礎建設的區域仍然做得到 —— 只是路上就開始掉人。
  const committed = armyPop * RAID_COMMIT;
  if (committed < 20) return false;

  const marchHours = pick.marchSeconds / 3600;
  const bleed = Math.min(committed * 0.5, overflowAttrition(committed, cap) * marchHours);

  const scale = (committed - bleed) / armyPop;
  const force: Partial<Record<Unit, number>> = {};
  for (const [u, n] of Object.entries(army)) {
    const k = Math.floor((n ?? 0) * scale);
    if (k > 0) force[u as Unit] = k;
  }
  if (armyPopulation(force) < 20) return false;

  const lootable = lootableOf(target, season);
  const result = resolveBattle(
    { army: force },
    {
      army: target.army,
      innateDefense: innateDefense(target.citadel),
      terrainDefense: TERRAIN[terrainOfPlayer(target)].defenseBonus,
      lootable,
    },
    { marchType: "RAID", defenderAtHome: true },
  );

  const gained = (result.loot.grain ?? 0) + (result.loot.timber ?? 0) + (result.loot.iron ?? 0);
  const casualties = armyPopulation(result.attackerLosses) + bleed;

  // ★ 划不划算：搶到的東西夠不夠補回戰損？春天不划算，冬天很划算。
  if (gained < casualties * LOOT_PER_CASUALTY_THRESHOLD) return false;

  // ★ 大打小積分歸零（`docs/04`）。賽季排名是玩家真正在追的東西，
  //   所以除非快餓死了，沒有人會拿主力去清一個不算分的目標。
  const desperate = attacker.res.grain < upkeepPerHour(attacker.army, { season }) * 4;
  if (!result.scoring && !desperate) return false;

  attacker.raidsLaunched++;
  target.raidsSuffered++;
  ctx.tally.battles++;
  if (armyPopulation(force) > armyPopulation(target.army) * 5) ctx.tally.lopsided++;
  if (ctx.month <= 2) {
    attacker.earlyCombat = true;
    target.earlyCombat = true;
  }

  applyLosses(attacker, result.attackerLosses);
  if (bleed > 0) {
    const total = armyPopulation(attacker.army);
    if (total > 0) {
      const keep = Math.max(0, 1 - bleed / total);
      for (const [u, n] of Object.entries(attacker.army)) {
        if (!n) continue;
        attacker.army[u as Unit] = Math.floor(n * keep);
      }
    }
  }
  applyLosses(target, result.defenderLosses);
  attacker.battleLosses += armyPopulation(result.attackerLosses);
  attacker.overflowLosses += bleed;
  target.battleLosses += armyPopulation(result.defenderLosses);

  let stolen = 0;
  if (result.outcome === "ATTACKER_WIN") {
    attacker.raidsWon++;
    for (const r of RES) {
      const taken = Math.min(target.res[r], result.loot[r] ?? 0);
      target.res[r] -= taken;
      attacker.res[r] += taken;
      target.lostToRaids += taken;
      stolen += taken;
      if (r === "grain") attacker.lootedGrain += taken;
    }
  }
  if (ctx.month === 1) ctx.tally.day1Losses.push(stolen);
  return true;
}

function applyLosses(p: SimPlayer, losses: Partial<Record<Unit, number>>) {
  for (const [u, n] of Object.entries(losses)) {
    if (!n) continue;
    p.army[u as Unit] = Math.max(0, (p.army[u as Unit] ?? 0) - n);
  }
}

/** 玩家所在格的地形（守方地形加成） */
function terrainOfPlayer(p: SimPlayer) {
  return p.profile.homeTerrain;
}

/**
 * ★ 廢土營地（PvE）。`docs/01` §7：新手期與非戰鬥玩家的主要成長管道。
 *
 * 全圖維持 800 個，每 90 分鐘補滿。這個**固定的絕對值**就是它的
 * 自動衰減機制：對第 1 天的玩家是收入翻倍，對第 10 天的玩家是零頭。
 */
interface CampPool {
  /** 各等級剩餘的營地數 */
  available: number[];
  /** 統計 */
  cleared: number[];
  lastRespawnHour: number;
}


function makeCampPool(): CampPool {
  const pool: CampPool = {
    available: new Array<number>(CAMPS.maxLevel + 1).fill(0),
    cleared: new Array<number>(CAMPS.maxLevel + 1).fill(0),
    lastRespawnHour: -999,
  };
  refillCamps(pool, 0);
  return pool;
}

function campLevelWeights(): number[] {
  const w: number[] = [0];
  for (let L = 1; L <= CAMPS.maxLevel; L++) w.push(CAMPS.levelWeightDecay ** (L - 1));
  return w;
}
const CAMP_WEIGHTS = campLevelWeights();
const CAMP_WEIGHT_SUM = CAMP_WEIGHTS.reduce((a, b) => a + b, 0);

/** 補滿到 800 個。低階佔多數 —— 高階營地是稀缺資源 */
function refillCamps(pool: CampPool, hour: number) {
  const respawnHours = CAMPS.respawnMs / 3_600_000;
  if (hour - pool.lastRespawnHour < respawnHours) return;
  pool.lastRespawnHour = hour;
  for (let L = 1; L <= CAMPS.maxLevel; L++) {
    pool.available[L] = Math.round((CAMPS.target * CAMP_WEIGHTS[L]!) / CAMP_WEIGHT_SUM);
  }
}

function campGarrison(level: number): Partial<Record<Unit, number>> {
  const pop = CAMPS.garrison.base * CAMPS.garrison.growth ** (level - 1);
  const archerShare = Math.min(CAMPS.archerShareMax, CAMPS.archerSharePerLevel * level);
  return {
    MILITIA: Math.round((pop * (1 - archerShare)) / UNIT.MILITIA.population),
    ARCHER: Math.round((pop * archerShare) / UNIT.ARCHER.population),
  };
}

/**
 * ★ 營地給了早期玩家一個養兵的理由。
 *
 * 春季打人不划算（模擬確認月 1–2 有 100% 的玩家零戰鬥），
 * 所以如果沒有 PvE，理性玩家在前三個月根本不該養兵 ——
 * 而 `docs/03` §6 的目標是月 3 有 200–350 的兵力。
 * 這個缺口就是「營地沒進模擬」造成的。
 *
 * 打得動營地之前，玩家會把資源優先放在軍隊上。
 */
function campDrivenBias(p: SimPlayer, pool: CampPool): number {
  const armyPop = armyPopulation(p.army);
  // 找出目前打得動的最高階營地；如果連 Lv2 都打不動就是還沒起步
  for (let level = 4; level >= 1; level--) {
    if (pool.available[level]! <= 0) continue;
    const g = campGarrison(level);
    if (armyPop >= armyPopulation(g) * 4) return p.militaryBias;
  }
  return Math.max(p.militaryBias, 0.7);
}

function campReward(level: number, season: (typeof SEASON_MODIFIERS)[Season]): number {
  // ★ 吃季節產出係數 —— 冬天廢土也在挨餓，營地搶不出那麼多東西
  return CAMPS.reward.base * CAMPS.reward.growth ** (level - 1) * season.production;
}

/**
 * 打營地。
 *
 * 玩家挑**打得動的最高階**營地 —— 獎勵 ×1.55/級快過守軍 ×1.5/級，
 * 所以永遠是能打多高就打多高。判準跟掠奪一樣是「划不划算」，
 * 差別在於營地不會反過來搶你，所以春季打營地是划算的，打人不是。
 */
function tryCamp(p: SimPlayer, pool: CampPool, season: (typeof SEASON_MODIFIERS)[Season]) {
  const armyPop = armyPopulation(p.army);
  if (armyPop < 15) return;

  // 前線出生帶周邊的營地等級 +3
  const bonus = SPAWN_BAND[p.profile.band].campLevelBonus;

  for (let level = CAMPS.maxLevel; level >= 1; level--) {
    if (pool.available[level]! <= 0) continue;
    // 出生帶加成讓前線玩家有機會碰到更高階的營地
    if (level > CAMPS.maxLevel - bonus && bonus === 0) continue;

    const result = resolveBattle(
      { army: p.army },
      {
        army: campGarrison(level),
        innateDefense: CAMPS.innateDefensePerLevel * level,
      },
      // ★ 營地是 PvE，不套用士氣 —— 反霸凌機制只該作用在玩家之間
      { marchType: "ATTACK", skipMorale: true },
    );
    if (result.outcome !== "ATTACKER_WIN") continue;

    const casualties = armyPopulation(result.attackerLosses);
    const reward = campReward(level, season);
    if (reward * RES.length < casualties * replacementCost(p.army) * CAMP_PROFIT_MARGIN) continue;
    // 也不能把主力打光 —— 家還要守
    if (casualties > armyPop * CAMP_MAX_CASUALTY_SHARE) continue;

    pool.available[level]!--;
    pool.cleared[level]!++;
    applyLosses(p, result.attackerLosses);
    p.battleLosses += casualties;
    p.campsCleared++;

    const cap = capacityOf(p);
    for (const r of RES) {
      p.campLoot += Math.min(reward, cap - p.res[r]);
      p.res[r] = Math.min(cap, p.res[r] + reward);
    }
    return;
  }
}

function simulateSeason(seed: number, spatial: SpatialProfiles): SeasonResult {
  const rand = mulberry32(seed);
  const players = makePlayers(rand, spatial);
  const legions: LegionState[] = ([1, 2, 3] as const).map((id) => ({
    ruinId: id,
    population: RUIN[id].legionBase,
    cleared: false,
    clearedMonth: null,
  }));

  const monthly: MonthSnapshot[] = [];
  const battles: BattleTally[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    season: seasonOfMonth(i + 1),
    battles: 0,
    lopsided: 0,
    day1Losses: [],
  }));
  const starvedAtMonthStart = new Map<number, number>();
  const camps = makeCampPool();

  for (let hour = 0; hour < TOTAL_HOURS; hour++) {
    if (hour % HOURS_PER_MONTH === 0) {
      for (const p of players) starvedAtMonthStart.set(p.id, p.starvedTotal);
    }
    const month = Math.floor(hour / HOURS_PER_MONTH) + 1;
    const seasonName = seasonOfMonth(month);
    const season =
      seasonName === "WINTER"
        ? { ...SEASON_MODIFIERS.WINTER, production: T.winterProduction, upkeep: T.winterUpkeep }
        : SEASON_MODIFIERS[seasonName];

    for (const p of players) {
      const eff = EFFICIENCY[p.archetype];
      const cap = capacityOf(p);

      // ── 產出 ──────────────────────────────────────────
      const y = yieldOf(p, season);
      for (const r of RES) {
        if (r === "grain") continue;
        p.produced += y[r];
        const before = p.res[r];
        p.res[r] = Math.min(cap, p.res[r] + y[r]);
        p.wasted += y[r] - (p.res[r] - before);
      }

      // ── 養兵糧耗 ──────────────────────────────────────
      const upkeep = upkeepPerHour(p.army, { season });
      if (seasonName === "WINTER" && y.grain < upkeep) p.winterDeficitHours++;
      p.res.grain = Math.min(cap, p.res.grain + y.grain - upkeep);

      // 糧食見底 → 每 10 分鐘餓死 3%（一小時六次）
      if (p.res.grain < 0) {
        p.res.grain = 0;
        const survive = (1 - 0.03) ** 6;
        for (const [u, n] of Object.entries(p.army)) {
          if (!n) continue;
          const left = Math.floor(n * survive);
          p.starvedTotal += n - left;
          if (seasonName === "WINTER") p.winterStarved += n - left;
          p.army[u as Unit] = left;
        }
      }

      // ── 人口累積 ──────────────────────────────────────
      const popCap = populationCapOf(p.citadel);
      const used = armyPopulation(p.army);
      p.population = Math.min(
        Math.max(0, popCap - used),
        p.population + populationGrowthPerHour(p.citadel, territoryOf(p)),
      );

      // ── 佇列閒置統計（docs/18 §12 的越界檢查）────────
      if (p.coreQueueUntil <= hour) p.coreIdleHours++;
      for (const until of p.territoryQueueUntil) {
        p.territorySlotHours++;
        if (until <= hour) p.territoryIdleSlotHours++;
      }

      // ── 核心佇列（永遠手動，執政官不碰）──────────────
      const manual = rand() < MANUAL_DUTY[p.archetype];
      if (manual) runCoreQueue(p, hour, eff, rand);

      // ── 招兵 ──────────────────────────────────────────
      if (manual && p.barracks > 0 && p.population >= 1) {
        const bias = campDrivenBias(p, camps);
        const unit: Unit = p.barracks >= 5 ? "SWORDSMAN" : "SPEARMAN";
        const spec = UNIT[unit];
        const perHour = 3600 / trainSeconds(unit, p.barracks, season);

        // 糧食緩衝：庫存低於 N 小時糧耗就停止招募，而不是「只花超出的部分」。
        // 後者在後期等於完全停招 —— 30 小時的糧耗早就超過倉庫容得下的量。
        //
        // 秋季（產出 ×1.2）要為冬季（×0.55、糧耗 ×1.4）屯糧。
        // 執政官不會做這件事：完全委託的玩家入冬就會被餓掉一批部隊。
        const banking =
          (p.suboptimal ? 4 : seasonName === "AUTUMN" ? 12 : 8) * p.discipline;
        const reserve = Math.min(upkeep * banking, cap * 0.4);
        const spendableGrain = p.res.grain > reserve ? (p.res.grain - reserve) * bias : 0;
        const budget = Math.min(
          Math.floor(spendableGrain / spec.cost.grain),
          Math.floor((p.res.iron * bias) / Math.max(1, spec.cost.iron)),
          Math.floor((p.res.timber * bias) / Math.max(1, spec.cost.timber)),
          Math.floor(p.population / spec.population),
          Math.floor(perHour * eff),
        );
        if (process.env.RECRUIT_TRACE && p.id === 7 && hour % 24 === 0) {
          console.log(
            `    [h${hour}] 兵營${p.barracks} 軍${armyPopulation(p.army)} 人口${p.population.toFixed(0)}` +
              ` 糧${p.res.grain.toFixed(0)}(留${reserve.toFixed(0)}) 鐵${p.res.iron.toFixed(0)}` +
              ` bias${bias.toFixed(2)} | 上限 糧${Math.floor(spendableGrain / spec.cost.grain)}` +
              ` 鐵${Math.floor((p.res.iron * bias) / Math.max(1, spec.cost.iron))}` +
              ` 木${Math.floor((p.res.timber * bias) / Math.max(1, spec.cost.timber))}` +
              ` 人口${Math.floor(p.population / spec.population)}` +
              ` 產能${Math.floor(perHour * eff)} → ${budget}`,
          );
        }
        if (budget > 0) {
          p.res.grain -= budget * spec.cost.grain;
          p.res.timber -= budget * spec.cost.timber;
          p.res.iron -= budget * spec.cost.iron;
          p.population -= budget * spec.population;
          p.army[unit] = (p.army[unit] ?? 0) + budget;
        }
      }

      // ── 領土佇列 ──────────────────────────────────────
      // 一小時內可能完成多件事（立旗 7–15 分、低階設施更短），
      // 所以用 while 追平佇列，而不是每小時只做一件。
      const value = valuation(y, p.res, cap, upkeep);
      const queues = territoryQueues(p.citadel);
      while (p.territoryQueueUntil.length < queues) p.territoryQueueUntil.push(hour);

      for (let q = 0; q < queues; q++) {
        let guard = 0;
        while ((p.territoryQueueUntil[q] ?? 0) <= hour + 1 && guard++ < 40) {
          const cursor = Math.max(hour, p.territoryQueueUntil[q] ?? 0);
          const action = bestTerritoryAction(p, season, value);
          if (!action) {
            p.territoryIdleHours += 1 / queues;
            break;
          }
          pay(p, action.cost);
          applyTerritoryAction(p, action);
          p.territoryQueueUntil[q] = cursor + action.hours / eff;
        }
      }

      // ── 研究佇列 ──────────────────────────────────────
      // 獨立於核心佇列，但吃同一份資源。後期主堡與領土都頂到天花板之後，
      // 這是唯一還在消耗產出的地方。
      if (p.archive > 0 && p.researchUntil <= hour) {
        const best = bestTech(p);
        if (best) {
          pay(p, best.cost);
          p.tech[best.tech]++;
          p.researchUntil = hour + best.hours / eff;
        }
      }

      p.peakArmyPop = Math.max(p.peakArmyPop, armyPopulation(p.army));
    }

    refillCamps(camps, hour);

    // ── 區域軍隊容量與超限損耗（`docs/16` §2）─────────────
    // 你能在一個地方投入多少兵，取決於你在那裡有多少基礎建設。
    const capacityCache = new Map<string, number>();
    for (const p of players) {
      const key = `${p.faction}:${p.alliance}:${p.profile.region}`;
      let cap = capacityCache.get(key);
      if (cap === undefined) {
        cap = allianceRegionCapacity(players, p.faction, p.alliance, p.profile.region, season);
        capacityCache.set(key, cap);
      }
      // 聯盟在該區的兵力共用容量，所以每人分到的額度按人頭均分
      const share = Math.max(1, playersInRegion(players, p));
      const lost = overflowAttrition(armyPopulation(p.army), cap / share);
      if (lost > 0) {
        const total = armyPopulation(p.army);
        const ratio = Math.max(0, 1 - lost / total);
        for (const [u, n] of Object.entries(p.army)) {
          if (!n) continue;
          p.army[u as Unit] = Math.floor(n * ratio);
        }
        p.overflowLosses += total - armyPopulation(p.army);
      }
    }

    // ── 軍事行動：掠奪優先，不划算才去打營地 ────────────────
    const ctx: RaidContext = {
      tally: battles[month - 1]!,
      players,
      season,
      seasonName,
      month,
      rand,
      capacityCache,
    };
    for (const p of players) {
      // 軍事永遠手動（`docs/03` §7.2）—— 執政官不會替你出兵
      if (rand() >= MILITARY_ATTENTION * MANUAL_DUTY[p.archetype]) continue;
      if (!tryRaid(p, ctx)) tryCamp(p, camps, season);
    }

    // ── 遺跡軍團 ────────────────────────────────────────
    for (const legion of legions) {
      if (legion.cleared) continue;
      if (month >= LEGION.unsealMonth) {
        legion.population =
          RUIN[legion.ruinId].legionBase * LEGION.growthPerMonth ** (month - LEGION.unsealMonth);
      }
    }

    if ((hour + 1) % HOURS_PER_MONTH === 0) {
      if (month >= LEGION.unsealMonth) {
        for (const legion of legions) {
          if (legion.cleared) continue;
          const ruin = spatial.ruins[legion.ruinId];
          const ruinRegion = regionOf(ruin.x, ruin.y);

          // ★ M1 之後這一段是真的了：只有**行軍打得到**遺跡的人能參戰，
          //   而且整個聯盟在遺跡所在區域能投入的兵力受區域容量上限壓制。
          //   「建立通往遺跡的補給線」因此是秋季大會戰前的實質任務。
          let best = 0;
          for (let a = 0; a < ROSTER.alliancesPerFaction; a++) {
            const members = players.filter(
              (p) => p.faction === legion.ruinId && p.alliance === a,
            );
            if (members.length === 0) continue;

            const reachable = members.filter(
              (p) => p.profile.ruinMarchSeconds <= MARCH.maxSeconds,
            );
            const available =
              reachable.reduce((sum, p) => sum + armyPopulation(p.army), 0) * EXPEDITION_SHARE;
            if (available <= 0) continue;

            const cap = allianceRegionCapacity(players, legion.ruinId, a, ruinRegion, season);
            // 稱職的指揮官會壓過容量一點點逼出戰果，但不會把整支軍隊
            // 丟進一個補給撐不住的區域慢慢流血
            const raw = Math.min(available, cap * OVERCOMMIT_TOLERANCE);

            // ★ 這是「補給線」真正咬人的地方：整個聯盟把主力壓到遺跡上，
            //   但聯盟在那個區域的基礎建設撐不住這麼多人，多出來的部分
            //   在圍攻期間持續失血。想帶更多人去，就得先在那裡蓋前哨營。
            if (raw > cap) {
              const bleed = overflowAttrition(raw, cap) * SIEGE_HOURS_PER_MONTH;
              const ratio = Math.min(1, bleed / raw);
              for (const m of reachable) {
                const before = armyPopulation(m.army);
                const keep = 1 - ratio * EXPEDITION_SHARE;
                for (const [u, n] of Object.entries(m.army)) {
                  if (!n) continue;
                  m.army[u as Unit] = Math.floor(n * keep);
                }
                m.overflowLosses += before - armyPopulation(m.army);
              }
            }

            best = Math.max(best, Math.min(raw, cap));
            if (process.env.RUIN_TRACE && month <= 6) {
              console.log(
                `    [月${month}] 遺跡${legion.ruinId} 聯盟${a}: raw ${raw.toFixed(0)} cap ${cap.toFixed(0)} → ${Math.min(raw, cap).toFixed(0)} / 需要 ${(legion.population * 1.3).toFixed(0)}`,
              );
            }
          }

          // Lanchester 損失曲線下，約需 1.3 倍軍團人口才吃得下來
          if (best >= legion.population * 1.3) {
            legion.cleared = true;
            legion.clearedMonth = month;
          }
        }
      }

      const median = (fn: (p: SimPlayer) => number) => {
        const arr = players.map(fn).sort((a, b) => a - b);
        return arr[Math.floor(arr.length / 2)] ?? 0;
      };

      monthly.push({
        month,
        season: seasonName,
        medianCitadel: median((p) => p.citadel),
        medianTerritory: median(territoryOf),
        medianArmyPop: median((p) => armyPopulation(p.army)),
        medianFacilityLevel: median((p) => {
          let c = 0;
          let l = 0;
          for (const f of PROD) {
            c += p.fac[f].count;
            l += p.fac[f].levels;
          }
          return c > 0 ? l / c : 0;
        }),
        negativeGrainShare:
          players.filter((p) => yieldOf(p, season).grain - upkeepPerHour(p.army, { season }) < 0)
            .length / players.length,
        storageBlockedShare:
          players.filter((p) => exceedsStorage(p, tunedCitadelCost(p.citadel + 1))).length /
          players.length,
        starvingShare:
          players.filter((p) => p.starvedTotal > (starvedAtMonthStart.get(p.id) ?? 0)).length /
          players.length,
      });
    }
  }

  return { players, legions, monthly, battles, camps };
}

// ─────────────────────────────────────────────────────────────
// 驗證與報告
// ─────────────────────────────────────────────────────────────

interface Check {
  label: string;
  pass: boolean;
  actual: string;
  target: string;
  /** 依賴空間資訊，M1 之前只能當參考 */
  indicative?: boolean;
}

function evaluate(results: SeasonResult[]): Check[] {
  const checks: Check[] = [];
  const atMonth = (r: SeasonResult, m: number) => r.monthly[m - 1]!;
  const avg = (fn: (r: SeasonResult) => number) =>
    results.reduce((s, r) => s + fn(r), 0) / results.length;

  // 經濟曲線目標（docs/03 §6）
  const curve: [number, [number, number], [number, number], [number, number]][] = [
    [3, [10, 12], [16, 26], [200, 350]],
    [6, [17, 21], [52, 68], [700, 1100]],
    [9, [22, 26], [72, 90], [1500, 2200]],
    [12, [25, 27], [74, 92], [1800, 2600]],
  ];
  for (const [m, cit, terr, army] of curve) {
    const c = avg((r) => atMonth(r, m).medianCitadel);
    const t = avg((r) => atMonth(r, m).medianTerritory);
    const a = avg((r) => atMonth(r, m).medianArmyPop);
    checks.push({
      label: `遊戲月 ${m} · 主堡`,
      pass: c >= cit[0] && c <= cit[1],
      actual: c.toFixed(1),
      target: `${cit[0]}–${cit[1]}`,
    });
    checks.push({
      label: `遊戲月 ${m} · 領土`,
      pass: t >= terr[0] && t <= terr[1],
      actual: t.toFixed(1),
      target: `${terr[0]}–${terr[1]}`,
    });
    checks.push({
      label: `遊戲月 ${m} · 兵力`,
      pass: a >= army[0] && a <= army[1],
      actual: a.toFixed(0),
      target: `${army[0]}–${army[1]}`,
    });
  }

  // 冬季逼迫（docs/16 §10）
  // ★ 量的是**真的餓死了部隊**，而不是某一瞬間的收支為負 ——
  //   玩家一旦被餓過就會把軍隊砍到養得起，瞬時收支會立刻回到正的，
  //   用瞬時值量會誤判成「冬季完全沒有壓力」。
  // ★ 量的是「產出養不起現有軍隊」的小時數，而不是「真的餓死了」。
  //   M1 加入掠奪之後，撐得住的玩家會**去搶**而不是餓死 ——
  //   那正是設計要的行為，但它會讓「餓死」這個指標看不見冬季的壓力。
  //   壓力的本體是「你必須做點什麼，否則就會餓死」。
  const winterPressure = avg(
    (r) => r.players.filter((p) => p.winterDeficitHours >= 12).length / r.players.length,
  );
  checks.push({
    label: "冬季糧食收支轉負超過 12 小時的玩家",
    pass: winterPressure >= 0.62,
    actual: `${(winterPressure * 100).toFixed(0)}%`,
    target: "≥ 62%（其餘是刻意養小軍隊的發育流）",
  });

  const winterStarve = avg(
    (r) => r.players.filter((p) => p.winterStarved > 0).length / r.players.length,
  );
  checks.push({
    label: "冬季真的餓死部隊的玩家",
    pass: winterStarve >= 0.03 && winterStarve <= 0.45,
    actual: `${(winterStarve * 100).toFixed(0)}%`,
    // 加入營地與掠奪之後，多數人**有辦法應對**冬季的缺口 ——
    // 壓力真實（六成以上收支轉負），但只有應對失敗的人才真的餓死。
    target: "3–45%（壓力普遍，崩潰只發生在應對失敗的人身上）",
  });

  const winterLoss = avg((r) => {
    const peak = r.players.reduce((s, p) => s + p.peakArmyPop, 0) / r.players.length;
    const end = r.players.reduce((s, p) => s + armyPopulation(p.army), 0) / r.players.length;
    return peak > 0 ? 1 - end / peak : 0;
  });
  checks.push({
    label: "賽季末兵力相對峰值的折損",
    pass: winterLoss <= 0.35,
    actual: `${(winterLoss * 100).toFixed(0)}%`,
    target: "≤ 35%（冬季要痛，但不能把軍隊清空）",
  });

  // 夏季不該逼迫（對照組：冬季的壓力必須是季節造成的，不是常態）
  const summerStarve = avg((r) => {
    const s = r.monthly.filter((m) => m.season === "SUMMER");
    return s.reduce((acc, m) => acc + m.starvingShare, 0) / s.length;
  });
  checks.push({
    label: "夏季有部隊餓死的玩家比例",
    pass: summerStarve <= 0.2,
    actual: `${(summerStarve * 100).toFixed(0)}%`,
    target: "≤ 20%（壓力要來自冬季）",
  });

  // 遺跡軍團（docs/17 §7）
  const atLeastOneInSummer =
    results.filter((r) =>
      r.legions.some((l) => l.clearedMonth !== null && l.clearedMonth >= 4 && l.clearedMonth <= 6),
    ).length / results.length;
  const allInSummer =
    results.filter((r) => r.legions.every((l) => l.clearedMonth !== null && l.clearedMonth <= 6))
      .length / results.length;

  checks.push({
    label: "至少 1 座遺跡在夏季被清空",
    pass: atLeastOneInSummer >= 0.7,
    actual: `${(atLeastOneInSummer * 100).toFixed(0)}%`,
    target: "≥ 70%",
    indicative: true,
  });
  checks.push({
    label: "三座全部在夏季被清空",
    pass: allInSummer < 0.15,
    actual: `${(allInSummer * 100).toFixed(0)}%`,
    target: "< 15%",
    indicative: true,
  });

  /**
   * ★ 用**發展度**而不是常備軍人數來比。
   *
   * 加入掠奪與營地之後，**當下**的常備軍不再是實力的好指標：
   * 積極玩家不斷出兵、手上的兵隨時在折損，換回來的是資源與領土。
   * 用當下軍隊人數量會得出「完全委託的人比較強」這種荒謬結論（實測 106%）。
   *
   * 改用**兵力峰值** —— 他這個賽季最多同時養得起多少兵，
   * 那才是 `docs/18` §12 說的「戰力」。
   */
  const power = (r: SeasonResult, a: Archetype) => {
    const g = r.players.filter((p) => p.archetype === a);
    return g.reduce((s, p) => s + p.peakArmyPop, 0) / Math.max(1, g.length);
  };

  // 委託平價（docs/18 §12）
  const parity = avg((r) => {
    const active = power(r, "ACTIVE");
    return active > 0 ? power(r, "DELEGATED") / active : 0;
  });
  checks.push({
    label: "完全委託 vs 積極玩家的戰力比",
    pass: parity >= 0.75 && parity <= 0.85,
    actual: `${(parity * 100).toFixed(0)}%`,
    target: "75–85%",
  });

  /**
   * ★ 核心佇列的閒置率**不因執政官而下降**（`docs/18` §12）。
   *
   * 這是唯一驗得到「執政官沒有越界」的指標。它補的是領土佇列，
   * 核心佇列碰都不碰 —— 所以完全委託的玩家，核心佇列閒得**更兇**。
   * 一旦這個比值掉到 1 以下，就代表某處的自動化伸手進了核心佇列，
   * 而核心佇列是整套取捨系統的命脈。
   */
  const coreIdle = (r: SeasonResult, a: Archetype) => {
    const g = r.players.filter((p) => p.archetype === a);
    return g.reduce((s, p) => s + p.coreIdleHours, 0) / Math.max(1, g.length);
  };
  const coreIdleRatio = avg((r) => {
    const active = coreIdle(r, "ACTIVE");
    return active > 0 ? coreIdle(r, "DELEGATED") / active : 0;
  });
  checks.push({
    label: "★ 核心佇列閒置率（委託 ÷ 積極）—— 執政官不碰核心佇列",
    pass: coreIdleRatio >= 1,
    actual: `${coreIdleRatio.toFixed(2)}×`,
    target: "≥ 1.00×",
  });

  /**
   * 領土佇列的閒置時間 < 15%（`docs/18` §12）——
   * 驗證執政官確實補上了每日上線 3 次的玩家留下的空檔。
   */
  const territoryIdle = (r: SeasonResult, a: Archetype) => {
    const g = r.players.filter((p) => p.archetype === a);
    const idle = g.reduce((s, p) => s + p.territoryIdleSlotHours, 0);
    const total = g.reduce((s, p) => s + p.territorySlotHours, 0);
    return total > 0 ? idle / total : 1;
  };
  const casualIdle = avg((r) => territoryIdle(r, "CASUAL"));
  const activeIdle = avg((r) => territoryIdle(r, "ACTIVE"));
  checks.push({
    /**
     * ★ 把積極玩家的數字一起印出來，這個檢查才讀得懂。
     *   `docs/18` §12 訂 15% 時假設閒置的成因是**注意力**；
     *   但如果連天天在線的人也閒著同樣多，成因就是**資源**，
     *   而那不是執政官補得了的東西。見 `11` §17.2。
     */
    label: "休閒玩家的領土佇列閒置率",
    pass: casualIdle < 0.15,
    actual: `${(casualIdle * 100).toFixed(0)}%（積極玩家 ${(activeIdle * 100).toFixed(0)}%）`,
    target: "< 15%",
    indicative: true,
  });

  // 休閒 vs 硬核（docs/03 §6 設計檢查點）
  const casualRatio = avg((r) => {
    const active = power(r, "ACTIVE");
    return active > 0 ? power(r, "CASUAL") / active : 0;
  });
  checks.push({
    label: "休閒玩家 vs 積極玩家的戰力比",
    pass: casualRatio >= 0.5,
    actual: `${(casualRatio * 100).toFixed(0)}%`,
    target: "> 50%",
  });

  // ── 戰爭節奏（`docs/16` §10）—— M1 之後才驗得到 ──────────
  const totalBattles = (r: SeasonResult) => r.battles.reduce((s, b) => s + b.battles, 0);
  const bySeason = (r: SeasonResult, ss: Season) =>
    r.battles.filter((b) => b.season === ss).reduce((s, b) => s + b.battles, 0);

  const quietStart = avg(
    (r) => r.players.filter((p) => !p.earlyCombat).length / r.players.length,
  );
  checks.push({
    label: "遊戲月 1–2 完全沒有戰鬥的玩家",
    pass: quietStart > 0.9,
    actual: `${(quietStart * 100).toFixed(0)}%`,
    target: "> 90%（春天不打仗，因為不划算）",
  });

  const lateShare = avg((r) => {
    const total = totalBattles(r);
    return total > 0 ? (bySeason(r, "AUTUMN") + bySeason(r, "WINTER")) / total : 0;
  });
  checks.push({
    label: "秋 + 冬的戰鬥次數佔全季",
    pass: lateShare >= 0.65,
    actual: `${(lateShare * 100).toFixed(0)}%`,
    target: "≥ 65%",
  });

  const winterVsAutumn = avg((r) => {
    const a = bySeason(r, "AUTUMN");
    return a > 0 ? bySeason(r, "WINTER") / a : 0;
  });
  checks.push({
    label: "冬季戰鬥次數 ÷ 秋季",
    pass: winterVsAutumn >= 1,
    actual: winterVsAutumn.toFixed(2),
    target: "≥ 1.00（冬季應為全季最高）",
  });

  const overflowShare = avg((r) => {
    const overflow = r.players.reduce((s, p) => s + p.overflowLosses, 0);
    const battle = r.players.reduce((s, p) => s + p.battleLosses, 0);
    const starve = r.players.reduce((s, p) => s + p.starvedTotal, 0);
    const total = overflow + battle + starve;
    return total > 0 ? overflow / total : 0;
  });
  checks.push({
    label: "區域超限損兵佔全季總損兵",
    pass: overflowShare >= 0.05 && overflowShare <= 0.15,
    actual: `${(overflowShare * 100).toFixed(1)}%`,
    target: "5–15%",
  });

  const day1Median = avg((r) => {
    const all = r.battles[0]!.day1Losses.slice().sort((a, b) => a - b);
    return all.length === 0 ? 0 : all[all.length >> 1]!;
  });
  checks.push({
    label: "第 1 天被攻擊的新手，資源損失中位數",
    pass: day1Median === 0,
    actual: day1Median.toFixed(0),
    target: "= 0（春季地窖加倍 + 士氣折掠奪）",
  });

  const lopsidedShare = avg((r) => {
    const total = totalBattles(r);
    const lop = r.battles.reduce((s, b) => s + b.lopsided, 0);
    return total > 0 ? lop / total : 0;
  });
  checks.push({
    label: "攻守人口比 > 5:1 的戰鬥佔全季",
    pass: lopsidedShare < 0.08,
    actual: `${(lopsidedShare * 100).toFixed(1)}%`,
    target: "< 8%",
  });

  // ── 發展度分佈 ────────────────────────────────────────────
  const devAt = (q: number) =>
    avg((r) => percentile(r.players.map(developmentIndex), q));
  const p50 = devAt(0.5);
  const p80 = devAt(0.8);
  const p99 = devAt(0.99);

  checks.push({
    label: "★ 第 80 百分位玩家的發展度",
    pass: p80 >= 0.76 && p80 <= 0.84,
    actual: `${(p80 * 100).toFixed(1)}%`,
    target: "80% ± 4",
  });
  checks.push({
    label: "中位數玩家的發展度",
    pass: p50 >= 0.6 && p50 <= 0.72,
    actual: `${(p50 * 100).toFixed(1)}%`,
    target: "60–72%",
  });
  // ★ 上限 90% 而不是 100%：模擬裡的 600 個玩家跑的是同一套貪婪啟發式，
  //   彼此只差在勤奮度、屯糧紀律與出生地。真人之間的策略差距遠大於此，
  //   所以這一項的上緣是**模型的性質**，不是遊戲的性質。
  checks.push({
    label: "最強的那 1% 的發展度",
    pass: p99 >= 0.78 && p99 < 0.95,
    actual: `${(p99 * 100).toFixed(1)}%`,
    target: "78–95%（要有人明顯領先，但沒人走滿）",
  });

  // 主堡 Lv30 在 12 天內不該達成
  const maxedShare = avg(
    (r) => r.players.filter((p) => p.citadel >= maxCitadel()).length / r.players.length,
  );
  checks.push({
    label: `賽季結束時達到主堡 Lv${maxCitadel()} 的比例`,
    pass: maxedShare < 0.05,
    actual: `${(maxedShare * 100).toFixed(1)}%`,
    target: "< 5%（天花板應望而不可及）",
  });

  // 倉庫必須是真的取捨，而不是走個過場
  const depot = avg(
    (r) => r.players.reduce((s, p) => s + p.depot, 0) / r.players.length,
  );
  checks.push({
    label: "賽季結束時的平均倉庫等級",
    pass: depot >= 4,
    actual: depot.toFixed(1),
    target: "≥ 4（儲存上限必須是真的約束）",
  });

  return checks;
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

/** 目標曲線與模擬結果的差距（相對誤差平方和，越小越好） */
const TARGET_CURVE: [number, number, number, number][] = [
  // [遊戲月, 主堡, 領土, 兵力]  —— 取 docs/03 §6 目標區間的中點
  [3, 11, 21.5, 275],
  [6, 18, 46, 900],
  [9, 23, 67, 1850],
  [12, 26, 83, 2200],
];

function curveError(r: SeasonResult): number {
  let e = 0;
  for (const [m, cit, terr, army] of TARGET_CURVE) {
    const s = r.monthly[m - 1]!;
    e += ((s.medianCitadel - cit) / cit) ** 2;
    e += ((s.medianTerritory - terr) / terr) ** 2;
    e += ((s.medianArmyPop - army) / army) ** 2;
  }
  return e;
}

function sweep(players: number, spatial: SpatialProfiles) {
  PLAYER_COUNT = players;
  const grid: Tune[] = [];
  for (const citadelCost of [1, 1.25, 1.5])
    for (const citadelGrowthDelta of [0, 0.02])
      for (const facilityCost of [1, 1.4])
        for (const facilityGrowthDelta of [0, 0.02])
          for (const yieldMul of [1, 0.9, 0.8])
            grid.push({
              ...BASE_TUNE,
              citadelCost,
              facilityCost,
              yieldMul,
              territoryPerLevel: CITADEL.territoryCapacityPerLevel,
              citadelGrowthDelta,
              facilityGrowthDelta,
            });

  console.log(`\n  網格搜尋 ${grid.length} 組 × ${players} 人 × 12 遊戲月\n`);
  console.log(
    "  主堡×  主堡growth  設施×  設施growth  產出 |  誤差  | 月3 月6 月9 月12 主堡 | 月12 領土 兵力",
  );
  const scored = grid.map((tune) => {
    T = tune;
    const r = simulateSeason(7, spatial);
    return { tune, err: curveError(r), r };
  });
  scored.sort((a, b) => a.err - b.err);
  for (const { tune, err, r } of scored.slice(0, 12)) {
    const c = (m: number) => String(r.monthly[m - 1]!.medianCitadel).padStart(3);
    const last = r.monthly[11]!;
    console.log(
      `  ${tune.citadelCost.toFixed(2).padStart(5)}  ${(CITADEL.cost.timber.growth + tune.citadelGrowthDelta).toFixed(2).padStart(9)}  ` +
        `${tune.facilityCost.toFixed(2).padStart(5)}  ${(FACILITY_SCALING.costGrowth + tune.facilityGrowthDelta).toFixed(2).padStart(9)}  ` +
        `${tune.yieldMul.toFixed(2).padStart(4)} | ` +
        `${err.toFixed(2).padStart(6)} | ${c(3)}${c(6)}${c(9)}${c(12)}      | ` +
        `${String(last.medianTerritory).padStart(6)} ${String(Math.round(last.medianArmyPop)).padStart(5)}`,
    );
  }
  T = BASE_TUNE;
}

function main() {
  const args = process.argv.slice(2);
  const runs = Number(args[args.indexOf("--runs") + 1]) || 10;
  const baseSeed = Number(args[args.indexOf("--seed") + 1]) || 1;
  const asJson = args.includes("--json");
  const trace = args.includes("--trace");

  if (args.includes("--players")) {
    PLAYER_COUNT = Number(args[args.indexOf("--players") + 1]) || ROSTER.playersTotal;
  }
  for (const k of ["citadelCost", "facilityCost", "yieldMul", "claimCost", "territoryPerLevel", "citadelGrowthDelta", "facilityGrowthDelta", "winterProduction", "winterUpkeep", "maxCitadel", "facilityCapDivisor", "popCoefficient", "citadelTimeMul"] as const) {
    const i = args.indexOf(`--${k}`);
    if (i >= 0) T = { ...T, [k]: Number(args[i + 1]) };
  }
  // ── 世界生成 ─────────────────────────────────────────────
  // 地圖是靜態的，所以整批模擬共用同一個世界；
  // 換 --worldSeed 才會換地圖（各場的差異來自玩家行為的亂數）。
  const worldSeed = Number(args[args.indexOf("--worldSeed") + 1]) || 99991;
  const wt0 = Date.now();
  const world = generateWorld(worldSeed, { squads: randomSquads(worldSeed, 0.25) });
  const spatial = buildProfiles(world);
  const worldMs = Date.now() - wt0;
  if (PLAYER_COUNT > spatial.players.length) PLAYER_COUNT = spatial.players.length;

  if (args.includes("--sweep")) {
    sweep(Number(args[args.indexOf("--players") + 1]) || 120, spatial);
    process.exit(0);
  }

  const t0 = Date.now();
  const results: SeasonResult[] = [];
  for (let i = 0; i < runs; i++) results.push(simulateSeason(baseSeed + i, spatial));
  const elapsed = Date.now() - t0;

  const checks = evaluate(results);

  if (asJson) {
    console.log(JSON.stringify({ runs, elapsedMs: elapsed, checks }, null, 2));
    process.exit(checks.every((c) => c.pass) ? 0 : 1);
  }

  const sample = results[0]!;
  console.log(`\n  RuinCity 賽季模擬 · ${runs} 場 × ${PLAYER_COUNT} 人 × 12 遊戲月`);
  console.log(
    `  耗時 ${elapsed} ms · 世界 seed ${world.seed}` +
      `（${world.seedAttempts} 次嘗試 / ${worldMs} ms / 公平性${world.fairness.pass ? "全過" : "未過"}）\n`,
  );

  console.log("  ── 中位數玩家的軌跡（第 1 場）──────────────────────────────");
  console.log("  月  季    主堡   領土  設施均等  兵力   餓死中  存量卡關");
  for (const m of sample.monthly) {
    const s = { SPRING: "春", SUMMER: "夏", AUTUMN: "秋", WINTER: "冬" }[m.season];
    console.log(
      `  ${String(m.month).padStart(2)}  ${s}   ` +
        `${String(m.medianCitadel).padStart(4)}   ` +
        `${String(m.medianTerritory).padStart(4)}   ` +
        `${m.medianFacilityLevel.toFixed(1).padStart(6)}  ` +
        `${String(Math.round(m.medianArmyPop)).padStart(6)}   ` +
        `${(m.starvingShare * 100).toFixed(0).padStart(5)}%   ` +
        `${(m.storageBlockedShare * 100).toFixed(0).padStart(6)}%`,
    );
  }

  if (trace) {
    const p = sample.players.find((x) => x.archetype === "ACTIVE")!;
    console.log(
      `\n  ── 範例積極玩家 #${p.id}（bias ${p.militaryBias.toFixed(2)}）────────────`,
    );
    console.log(
      `  主堡 ${p.citadel} · 兵營 ${p.barracks} · 倉庫 ${p.depot} · 檔案館 ${p.archive}` +
        ` · 科技 ${totalTechLevels(p)}/${MAX_TECH_LEVELS}`,
    );
    for (const f of PROD) {
      const g = p.fac[f];
      console.log(
        `  ${FACILITY[f].label.padEnd(4)} ×${String(g.count).padStart(3)} 均等 ${(g.levels / Math.max(1, g.count)).toFixed(1)}`,
      );
    }
    console.log(
      `  前哨營 ×${p.outposts.count} 均等 ${(p.outposts.levels / Math.max(1, p.outposts.count)).toFixed(1)}`,
    );
    console.log(`  哨塔集市 ${p.supportTiles} · 餓死累計 ${p.starvedTotal} · 兵力峰值 ${p.peakArmyPop}`);
    console.log(
      `  核心佇列動工 ${p.coreBusyHours.toFixed(0)}/${TOTAL_HOURS} h ` +
        `(${((p.coreBusyHours / TOTAL_HOURS) * 100).toFixed(0)}%) · ` +
        `領土佇列空轉 ${p.territoryIdleHours.toFixed(0)} h`,
    );
    console.log(
      `  存量：` + RES.map((r) => `${r} ${Math.round(p.res[r])}`).join(" / ") +
        `（上限 ${capacityOf(p)}）`,
    );
  }

  const devs = sample.players.map(developmentIndex).sort((a, b) => a - b);
  console.log("\n  ── 發展度分佈（第 1 場）──────────────────────────────────");
  console.log(
    "  " +
      [10, 25, 50, 75, 80, 90, 99]
        .map((q) => `P${q} ${(percentile(devs, q / 100) * 100).toFixed(0)}%`)
        .join("   "),
  );
  const capped = (fn: (p: SimPlayer) => boolean) =>
    `${((sample.players.filter(fn).length / sample.players.length) * 100).toFixed(0)}%`;
  console.log(
    `  頂到天花板的比例：主堡 ${capped((p) => p.citadel >= maxCitadel())}` +
      ` · 領土 ${capped((p) => territoryOf(p) >= tunedTerritoryCap(p))}` +
      ` · 設施 ${capped((p) => {
        let c = 0;
        let l = 0;
        for (const f of PROD) {
          c += p.fac[f].count;
          l += p.fac[f].levels;
        }
        return c > 0 && l / c >= facilityCapOf(p.citadel);
      })}` +
      ` · 人口 ${capped((p) => armyPopulation(p.army) >= populationCapOf(p.citadel) * 0.95)}`,
  );
  const axisOf = (fn: (p: SimPlayer) => number) => {
    const v = sample.players.map(fn).sort((a, b) => a - b);
    return `${(percentile(v, 0.5) * 100).toFixed(0)}/${(percentile(v, 0.8) * 100).toFixed(0)}`;
  };
  const maxT = T.territoryPerLevel * maxCitadel();
  console.log(
    "  各軸 P50/P80：" +
      `主堡 ${axisOf((p) => p.citadel / maxCitadel())}` +
      ` · 領土 ${axisOf((p) => territoryOf(p) / maxT)}` +
      ` · 設施 ${axisOf((p) => {
        let c = 0;
        let l = 0;
        for (const f of PROD) {
          c += p.fac[f].count;
          l += p.fac[f].levels;
        }
        return c > 0 ? l / c / facilityCapOf(maxCitadel()) : 0;
      })}` +
      ` · 兵力 ${axisOf((p) => armyPopulation(p.army) / populationCapOf(maxCitadel()))}` +
      ` · 科技 ${axisOf((p) => totalTechLevels(p) / MAX_TECH_LEVELS)}`,
  );
  const techLevels = sample.players.map(totalTechLevels).sort((a, b) => a - b);
  console.log(
    `  科技等級合計（上限 ${MAX_TECH_LEVELS}）：` +
      `中位 ${techLevels[techLevels.length >> 1]}` +
      ` · 最高 ${techLevels[techLevels.length - 1]}` +
      ` · 檔案館中位 ${sample.players.map((p) => p.archive).sort((a, b) => a - b)[sample.players.length >> 1]}`,
  );

  const acct = (fn: (p: SimPlayer) => number) =>
    Math.round(sample.players.reduce((s, p) => s + fn(p), 0) / sample.players.length);
  console.log(
    `  資源會計（每人平均）：產出 ${acct((p) => p.produced).toLocaleString()}` +
      ` · 花掉 ${acct((p) => p.spent).toLocaleString()}` +
      ` · 滿倉蒸發 ${acct((p) => p.wasted).toLocaleString()}` +
      `（${((acct((p) => p.wasted) / Math.max(1, acct((p) => p.produced))) * 100).toFixed(0)}%）`,
  );

  console.log("\n  ── 廢土營地（第 1 場）────────────────────────────────────");
  const clearedTotal = sample.camps.cleared.reduce((a, b) => a + b, 0);
  console.log(
    `  清空 ${clearedTotal.toLocaleString()} 座 · 每人平均 ${(clearedTotal / sample.players.length).toFixed(1)} 座` +
      ` · 收穫 ${Math.round(sample.players.reduce((s2, p) => s2 + p.campLoot, 0) / sample.players.length).toLocaleString()}/人`,
  );
  console.log(
    "  各等級清空數：" +
      sample.camps.cleared
        .map((n, L) => (L === 0 || n === 0 ? null : `L${L} ${n}`))
        .filter(Boolean)
        .join("  "),
  );
  console.log(
    "  剩餘未清：" +
      sample.camps.available
        .map((n, L) => (L === 0 ? null : `L${L} ${n}`))
        .filter(Boolean)
        .join("  "),
  );

  console.log("\n  ── 戰爭節奏（第 1 場）────────────────────────────────────");
  const seasonBattles = { SPRING: 0, SUMMER: 0, AUTUMN: 0, WINTER: 0 } as Record<Season, number>;
  for (const b of sample.battles) seasonBattles[b.season] += b.battles;
  console.log(
    `  戰鬥次數  春 ${seasonBattles.SPRING}  夏 ${seasonBattles.SUMMER}  ` +
      `秋 ${seasonBattles.AUTUMN}  冬 ${seasonBattles.WINTER}`,
  );
  const totalLoot = sample.players.reduce((s, p) => s + p.lootedGrain, 0);
  const totalOverflow = sample.players.reduce((s, p) => s + p.overflowLosses, 0);
  console.log(
    `  掠奪糧食合計 ${Math.round(totalLoot).toLocaleString()} · ` +
      `區域超限損兵 ${Math.round(totalOverflow).toLocaleString()} · ` +
      `平均每人發動 ${(sample.players.reduce((s, p) => s + p.raidsLaunched, 0) / sample.players.length).toFixed(1)} 次`,
  );

  console.log("\n  ── 遺跡軍團（第 1 場）──────────────────────────────────────");
  for (const l of sample.legions) {
    const name = RUIN[l.ruinId].name;
    console.log(
      `  ${name}：${
        l.cleared
          ? `第 ${l.clearedMonth} 月清空`
          : `未清空（第 12 月 ${Math.round(l.population).toLocaleString()} 人）`
      }`,
    );
  }

  console.log("\n  ── 平衡驗證 ────────────────────────────────────────────────");
  let failed = 0;
  for (const c of checks) {
    const mark = c.pass ? "✓" : "✗";
    if (!c.pass) failed++;
    console.log(
      `  ${mark} ${c.label.padEnd(30)} ${c.actual.padStart(8)}  (目標 ${c.target})` +
        (c.indicative ? " ※指示性" : ""),
    );
  }

  const indicativeFails = checks.filter((c) => !c.pass && c.indicative).length;
  console.log(
    `\n  ${checks.length - failed}/${checks.length} 通過` +
      (failed > 0
        ? `，${failed} 項需要調整數值` +
          (indicativeFails > 0 ? `（其中 ${indicativeFails} 項為指示性，需 M1 後複驗）` : "") +
          "\n"
        : "\n"),
  );

  console.log(
    "  ※ 指示性 = 結果依賴地圖空間資訊（行軍距離、區域容量），M1 完成前只能參考。\n",
  );

  process.exit(failed - indicativeFails > 0 ? 1 : 0);
}

main();
