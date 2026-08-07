/**
 * Drizzle schema —— 對應 docs/08-data-model.md。
 *
 * 兩個貫穿全表的設計：
 *  1. 所有遊戲資料以 `seasonId` 分割。任何時刻有兩場賽季並行（12 天賽季、7 天輪替）。
 *  2. 資源與人口採「快照 + 速率」惰性結算，不用定時器每秒寫 DB。
 */

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────

export const seasonStatusEnum = pgEnum("season_status", [
  "REGISTRATION",
  "SEALED",
  "RUNNING",
  "ENDING",
  "ARCHIVED",
]);

export const spawnBandEnum = pgEnum("spawn_band", ["VANGUARD", "HEARTLAND", "FRONTIER"]);

export const aiPersonaEnum = pgEnum("ai_persona", [
  "SETTLER",
  "WARDEN",
  "WARLORD",
  "RUIN_LEGION",
]);

export const allianceStatusEnum = pgEnum("alliance_status", ["ACTIVE", "FALLEN"]);
export const allianceRankEnum = pgEnum("alliance_rank", ["LEADER", "OFFICER", "MEMBER"]);
export const recruitModeEnum = pgEnum("recruit_mode", ["OPEN", "APPLY", "INVITE"]);

export const tileKindEnum = pgEnum("tile_kind", [
  "BASE_CORE",
  "TERRITORY",
  "RUIN",
  "RUIN_OUTPOST",
  "CAMP",
]);
export const tileStateEnum = pgEnum("tile_state", [
  "NORMAL",
  "CONTESTED",
  "ISOLATED",
  "CLAIMING",
]);

/**
 * 地形。真相在地圖靜態檔（`public/terrain/s{seasonId}`），
 * 這裡是**佔領時抄下來的一份**。
 *
 * ★ 為什麼要反正規化：結算路徑要算設施產出，而產出乘地形修正
 *   （`TERRAIN_YIELD`）。如果不存在這裡，每次結算都得去讀 chunk 檔 ——
 *   而 `/lib/game` 不准有 I/O，那些讀取只能發生在結算的熱路徑上。
 *   一格的地形整季不會變，抄一次就好。
 */
export const terrainEnum = pgEnum("terrain", [
  "PLAIN",
  "RUBBLE",
  "FOREST",
  "WASTE",
  "LODE",
  "MARSH",
  "MOUNTAIN",
]);

export const marchTypeEnum = pgEnum("march_type", [
  "RAID",
  "ATTACK",
  "SCOUT",
  "CLAIM",
  "REINFORCE",
  "GARRISON",
  "RETURN",
]);
export const marchStatusEnum = pgEnum("march_status", ["IN_TRANSIT", "ARRIVED", "RECALLED"]);

export const ruinPhaseEnum = pgEnum("ruin_phase", [
  "SEALED",
  "DORMANT",
  "AWAKENED",
  "CONTESTED",
  "CONTROLLED",
]);

export const siegeStatusEnum = pgEnum("siege_status", ["ACTIVE", "BROKEN", "SUCCEEDED"]);

export const eventTypeEnum = pgEnum("event_type", [
  "BUILD_DONE",
  "DEMOLISH_DONE",
  "TRAIN_DONE",
  "MARCH_ARRIVE",
  "CLAIM_DONE",
  "MARKET_DELIVERY",
  "ISOLATION_EXPIRE",
  "CONTEST_EXPIRE",
  "RUIN_TICK",
  "RUIN_UNSEAL",
  "CAMP_RESPAWN",
  "SEASON_VICTORY_CHECK",
  "SEASON_EXPIRE",
  "SEASON_CHANGE",
  "REGION_ATTRITION",
  "STARVATION",
  "LEGION_GROWTH",
  "LEGION_SORTIE",
  "SIEGE_RESOLVE",
  "LEADER_TRANSFER",
  "AI_TICK",
  "AI_RETALIATE",
  "AI_TAKEOVER",
  "STEWARD_TICK",
]);

export const stewardLogKindEnum = pgEnum("steward_log_kind", [
  "CLAIM",
  "BUILD",
  "LEVY",
  "WARNING",
  "BLOCKED",
]);

// ─────────────────────────────────────────────────────────────
// 全域
// ─────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  email: text("email").notNull().unique(),
  /** google | email —— 不做訪客帳號 */
  provider: text("provider").notNull(),
  displayName: text("display_name").notNull(),
  /** 跨賽季傳承。上限刻意壓得極低，老玩家的優勢是經驗與人脈，不是數值。 */
  legacyPoints: integer("legacy_points").notNull().default(0),
  titles: jsonb("titles").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const seasons = pgTable("seasons", {
  id: serial("id").primaryKey(),
  /** 地圖生成種子，可能在封盤期因公平性驗證未過而被換掉多次 */
  seed: bigint("seed", { mode: "bigint" }).notNull(),
  status: seasonStatusEnum("status").notNull().default("REGISTRATION"),

  registrationOpensAt: timestamp("registration_opens_at", { withTimezone: true }),
  registrationClosesAt: timestamp("registration_closes_at", { withTimezone: true }),
  /** T = 0，全員同時進入 */
  startedAt: timestamp("started_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),

  /**
   * ★ 數值表版本快照，封盤時固定。
   * 進行中的賽季永遠不受新版本影響 —— 兩場並行時的隔離牆。
   */
  balanceVersion: text("balance_version").notNull(),

  humanCount: integer("human_count").notNull().default(0),
  aiCount: integer("ai_count").notNull().default(0),

  ruinPositions: jsonb("ruin_positions"),
  /** 五項公平性驗證的實際數值，封盤期公開給玩家檢查 */
  fairnessReport: jsonb("fairness_report"),
  /**
   * ★ 封盤期解出來的 600 個座位（含 AI），T = 0 直接照抄。
   *
   * 不在開賽時重跑一次 `generateWorld` —— 那要 7～20 秒，
   * 而 T = 0 是在交易裡寫 600 位玩家，不能再多花二十秒開著交易。
   * 更要緊的是：重跑就代表「預覽的座標」與「真正的座標」是兩次獨立計算，
   * 只要生成參數有任何一點不同，玩家就會生在別的地方。
   */
  spawnPlan: jsonb("spawn_plan"),

  victoryAllianceId: bigint("victory_alliance_id", { mode: "number" }),
  victoryCountdownStartedAt: timestamp("victory_countdown_started_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────
// 登記與名額
// ─────────────────────────────────────────────────────────────

export const seasonRegistrations = pgTable(
  "season_registrations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    userId: bigint("user_id", { mode: "number" }).notNull().references(() => users.id),
    /** 1 | 2 | 3，對應三座遺跡（各 200 名額） */
    faction: smallint("faction").notNull(),
    spawnBand: spawnBandEnum("spawn_band").notNull(),
    /** 同行小隊代碼，最多 8 人共用 */
    squadCode: varchar("squad_code", { length: 12 }),
    assignedX: smallint("assigned_x"),
    assignedY: smallint("assigned_y"),
    playerId: bigint("player_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reg_season_user_uq").on(t.seasonId, t.userId),
    index("reg_squad_idx").on(t.seasonId, t.squadCode),
    check("reg_faction_range", sql`${t.faction} BETWEEN 1 AND 3`),
  ],
);

/**
 * 每場固定 600 人 → 容量是常數，`CHECK (taken <= capacity)` 直接在 DB 層擋住超賣，
 * 不需要 advisory lock 或應用層的容量計算。
 */
export const seasonQuotas = pgTable(
  "season_quotas",
  {
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    faction: smallint("faction").notNull(),
    spawnBand: spawnBandEnum("spawn_band").notNull(),
    /** 40 | 100 | 60 */
    capacity: integer("capacity").notNull(),
    taken: integer("taken").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.faction, t.spawnBand] }),
    /** 這一條讓登記併發控制退化為一句原子 UPDATE，不需要 advisory lock */
    check("quota_within_capacity", sql`${t.taken} >= 0 AND ${t.taken} <= ${t.capacity}`),
  ],
);

// ─────────────────────────────────────────────────────────────
// 玩家與據點
// ─────────────────────────────────────────────────────────────

export const players = pgTable(
  "players",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    /** AI 為 NULL */
    userId: bigint("user_id", { mode: "number" }).references(() => users.id),
    allianceId: bigint("alliance_id", { mode: "number" }),
    faction: smallint("faction").notNull(),
    spawnBand: spawnBandEnum("spawn_band").notNull(),

    /** 核心據點左上角（A 格） */
    baseX: smallint("base_x").notNull(),
    baseY: smallint("base_y").notNull(),
    citadelLevel: smallint("citadel_level").notNull().default(1),

    /** 用於執政官全權代理判定與遺物分配 */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),

    isAi: boolean("is_ai").notNull().default(false),
    aiPersona: aiPersonaEnum("ai_persona"),
    /** ±15% 個體偏移，賽季開始時由 seed 決定後固定 */
    aiVariance: numeric("ai_variance", { precision: 4, scale: 3 }),

    eliminatedAt: timestamp("eliminated_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("players_season_user_uq").on(t.seasonId, t.userId),
    uniqueIndex("players_season_base_uq").on(t.seasonId, t.baseX, t.baseY),
    index("players_ai_idx").on(t.seasonId, t.isAi),
    index("players_faction_idx").on(t.seasonId, t.faction),
    index("players_alliance_idx").on(t.allianceId),
    check("players_faction_range", sql`${t.faction} BETWEEN 1 AND 3`),
  ],
);

/** 核心 2×2 的四個格位；A 恆為 CITADEL */
export const baseSlots = pgTable(
  "base_slots",
  {
    playerId: bigint("player_id", { mode: "number" }).notNull().references(() => players.id),
    slot: char("slot", { length: 1 }).notNull(),
    building: text("building"),
    level: smallint("level").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.slot] })],
);

/** 資源：快照 + 速率。只在速率改變或扣款時寫入。 */
export const playerResources = pgTable("player_resources", {
  playerId: bigint("player_id", { mode: "number" })
    .primaryKey()
    .references(() => players.id),
  grain: numeric("grain", { precision: 14, scale: 3 }).notNull().default("500"),
  timber: numeric("timber", { precision: 14, scale: 3 }).notNull().default("500"),
  stone: numeric("stone", { precision: 14, scale: 3 }).notNull().default("500"),
  iron: numeric("iron", { precision: 14, scale: 3 }).notNull().default("200"),
  relic: numeric("relic", { precision: 14, scale: 3 }).notNull().default("0"),
  grainRate: numeric("grain_rate", { precision: 12, scale: 3 }).notNull().default("0"),
  timberRate: numeric("timber_rate", { precision: 12, scale: 3 }).notNull().default("0"),
  stoneRate: numeric("stone_rate", { precision: 12, scale: 3 }).notNull().default("0"),
  ironRate: numeric("iron_rate", { precision: 12, scale: 3 }).notNull().default("0"),
  capacity: numeric("capacity", { precision: 12, scale: 0 }).notNull().default("2000"),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  /** 資源永不為負 —— 扣款與加值都在同一交易內，DB 層再擋一次 */
  check("resources_non_negative", sql`
    ${t.grain} >= 0 AND ${t.timber} >= 0 AND ${t.stone} >= 0
    AND ${t.iron} >= 0 AND ${t.relic} >= 0`),
]);

/**
 * 人口：與資源相同的快照 + 速率模型。
 * 上限由主堡決定、成長率由領土決定、**陣亡不返還**。
 */
export const playerPopulation = pgTable("player_population", {
  playerId: bigint("player_id", { mode: "number" })
    .primaryKey()
    .references(() => players.id),
  amount: numeric("amount", { precision: 12, scale: 3 }).notNull().default("0"),
  rate: numeric("rate", { precision: 10, scale: 3 }).notNull().default("0"),
  cap: numeric("cap", { precision: 10, scale: 0 }).notNull().default("60"),
  /** 已被部隊佔用（含行軍中） */
  used: numeric("used", { precision: 12, scale: 3 }).notNull().default("0"),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check("population_non_negative", sql`${t.amount} >= 0 AND ${t.used} >= 0`),
]);

// ─────────────────────────────────────────────────────────────
// 執政官
// ─────────────────────────────────────────────────────────────

export const stewards = pgTable("stewards", {
  playerId: bigint("player_id", { mode: "number" })
    .primaryKey()
    .references(() => players.id),
  name: text("name").notNull(),
  avatarSeed: integer("avatar_seed").notNull(),
  /** 拓荒／建設／募兵的開關、參數與資源保留下限 */
  directives: jsonb("directives").notNull().default(sql`'{}'::jsonb`),
  /** 領主接管中 */
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  /** 48h 未登入 → 全權代理（額外獲得防守調度與核心佇列權限） */
  fullProxy: boolean("full_proxy").notNull().default(false),
  lastActedAt: timestamp("last_acted_at", { withTimezone: true }),
});

/** 施政簡報素材。BLOCKED 與行動同等重要 —— 沒做什麼也要說。 */
export const stewardLog = pgTable(
  "steward_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    playerId: bigint("player_id", { mode: "number" }).notNull().references(() => players.id),
    kind: stewardLogKindEnum("kind").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("steward_log_player_idx").on(t.playerId, t.createdAt)],
);

// ─────────────────────────────────────────────────────────────
// 地圖
// ─────────────────────────────────────────────────────────────

/** 地形不入庫：由 seed 決定性生成，以靜態 chunk 檔提供。只有「被誰佔用」需要持久化。 */
export const tiles = pgTable(
  "tiles",
  {
    seasonId: integer("season_id").notNull(),
    x: smallint("x").notNull(),
    y: smallint("y").notNull(),
    kind: tileKindEnum("kind").notNull(),
    playerId: bigint("player_id", { mode: "number" }),
    /** 反正規化，加速地圖著色查詢 */
    allianceId: bigint("alliance_id", { mode: "number" }),
    facility: text("facility"),
    facilityLevel: smallint("facility_level").notNull().default(0),
    /** 佔領時從地圖靜態檔抄下來，整季不變 */
    terrain: terrainEnum("terrain").notNull().default("PLAIN"),
    state: tileStateEnum("state").notNull().default("NORMAL"),
    stateUntil: timestamp("state_until", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.x, t.y] }),
    index("tiles_player_idx").on(t.playerId),
    index("tiles_alliance_idx").on(t.seasonId, t.allianceId),
  ],
);

/** 100 個 50×50 區域。名稱由 seed 生成，讓戰報有地名可用。 */
export const regions = pgTable(
  "regions",
  {
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    regionId: smallint("region_id").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.seasonId, t.regionId] })],
);

/**
 * 每個聯盟在每個區域的容量快取。
 * 季節係數不入庫 —— 讀取時計算，避免季節切換要重寫 100 × N 列。
 */
export const regionCapacity = pgTable(
  "region_capacity",
  {
    seasonId: integer("season_id").notNull(),
    regionId: smallint("region_id").notNull(),
    /** ALLIANCE | PLAYER（無聯盟者） */
    holderKind: text("holder_kind").notNull(),
    holderId: bigint("holder_id", { mode: "number" }).notNull(),
    baseCapacity: numeric("base_capacity", { precision: 10, scale: 0 }).notNull(),
    stationed: numeric("stationed", { precision: 10, scale: 0 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.regionId, t.holderKind, t.holderId] }),
    index("region_cap_holder_idx").on(t.holderKind, t.holderId),
  ],
);

// ─────────────────────────────────────────────────────────────
// 軍事
// ─────────────────────────────────────────────────────────────

export const garrisons = pgTable(
  "garrisons",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull(),
    /** 部隊的所有者（付糧的人） */
    ownerId: bigint("owner_id", { mode: "number" }).notNull().references(() => players.id),
    atX: smallint("at_x").notNull(),
    atY: smallint("at_y").notNull(),
    /** 駐紮地的主人（增援時 ≠ owner） */
    hostId: bigint("host_id", { mode: "number" }),
    units: jsonb("units").notNull(),
  },
  (t) => [
    uniqueIndex("garrisons_owner_at_uq").on(t.seasonId, t.ownerId, t.atX, t.atY),
    index("garrisons_at_idx").on(t.seasonId, t.atX, t.atY),
  ],
);

export const marches = pgTable(
  "marches",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull(),
    ownerId: bigint("owner_id", { mode: "number" }).notNull().references(() => players.id),
    type: marchTypeEnum("type").notNull(),
    fromX: smallint("from_x").notNull(),
    fromY: smallint("from_y").notNull(),
    toX: smallint("to_x").notNull(),
    toY: smallint("to_y").notNull(),
    units: jsonb("units").notNull(),
    /** 返程時攜帶的資源 */
    cargo: jsonb("cargo"),
    /** 投石機指定拆除的核心建築格 */
    targetSlot: char("target_slot", { length: 1 }),
    departedAt: timestamp("departed_at", { withTimezone: true }).notNull(),
    arrivesAt: timestamp("arrives_at", { withTimezone: true }).notNull(),
    status: marchStatusEnum("status").notNull().default("IN_TRANSIT"),
    eventId: bigint("event_id", { mode: "number" }),
  },
  (t) => [
    index("marches_arrival_idx").on(t.arrivesAt),
    index("marches_target_idx").on(t.seasonId, t.toX, t.toY),
    index("marches_owner_idx").on(t.ownerId),
  ],
);

/** snapshot 存完整的戰鬥輸入與輸出，讓玩家看得到「為什麼我輸了」。 */
export const battleReports = pgTable(
  "battle_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull(),
    attackerId: bigint("attacker_id", { mode: "number" }),
    defenderId: bigint("defender_id", { mode: "number" }),
    atX: smallint("at_x").notNull(),
    atY: smallint("at_y").notNull(),
    marchType: marchTypeEnum("march_type").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reports_attacker_idx").on(t.attackerId, t.createdAt),
    index("reports_defender_idx").on(t.defenderId, t.createdAt),
  ],
);

// ─────────────────────────────────────────────────────────────
// 陣營 → 聯盟 → 玩家
// ─────────────────────────────────────────────────────────────

export const alliances = pgTable(
  "alliances",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    /** 聯盟屬於一個陣營，成員必須全部同陣營 */
    faction: smallint("faction").notNull(),
    /** 1–5：該陣營的第幾個名額 */
    slotNo: smallint("slot_no").notNull(),

    name: text("name").notNull(),
    tag: varchar("tag", { length: 5 }).notNull(),
    /** '00'–'FF'，seed 洗牌後配發、賽季內唯一、永不可改 */
    hexCode: char("hex_code", { length: 2 }).notNull(),
    /** 0–14；同陣營 5 色同色系 */
    color: smallint("color").notNull(),

    recruitMode: recruitModeEnum("recruit_mode").notNull().default("APPLY"),
    leaderId: bigint("leader_id", { mode: "number" }).notNull(),
    leaderPendingId: bigint("leader_pending_id", { mode: "number" }),
    leaderTransferAt: timestamp("leader_transfer_at", { withTimezone: true }),

    status: allianceStatusEnum("status").notNull().default("ACTIVE"),
    fallenAt: timestamp("fallen_at", { withTimezone: true }),
    felledByAllianceId: bigint("felled_by_alliance_id", { mode: "number" }),
    finalScore: integer("final_score"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("alliances_name_uq").on(t.seasonId, t.name),
    uniqueIndex("alliances_tag_uq").on(t.seasonId, t.tag),
    uniqueIndex("alliances_hex_uq").on(t.seasonId, t.hexCode),
    uniqueIndex("alliances_color_uq").on(t.seasonId, t.color),
    /** ★ 每陣營最多 5 個「進行中」的聯盟；淪陷會釋出 slot 供同陣營重用 */
    uniqueIndex("alliances_faction_slot_uq")
      .on(t.seasonId, t.faction, t.slotNo)
      .where(sql`status = 'ACTIVE'`),
    check("alliances_faction_range", sql`${t.faction} BETWEEN 1 AND 3`),
    check("alliances_slot_range", sql`${t.slotNo} BETWEEN 1 AND 5`),
  ],
);

export const allianceMembers = pgTable("alliance_members", {
  playerId: bigint("player_id", { mode: "number" })
    .primaryKey()
    .references(() => players.id),
  allianceId: bigint("alliance_id", { mode: "number" }).notNull().references(() => alliances.id),
  rank: allianceRankEnum("rank").notNull().default("MEMBER"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const allianceEvents = pgTable(
  "alliance_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    allianceId: bigint("alliance_id", { mode: "number" }).notNull().references(() => alliances.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alliance_events_idx").on(t.allianceId, t.createdAt)],
);

/** 斬首圍城：打贏盟主守軍 → 圍城 2 小時 → 全聯盟出局 */
export const sieges = pgTable(
  "sieges",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull(),
    targetAllianceId: bigint("target_alliance_id", { mode: "number" })
      .notNull()
      .references(() => alliances.id),
    attackerAllianceId: bigint("attacker_alliance_id", { mode: "number" })
      .notNull()
      .references(() => alliances.id),
    atX: smallint("at_x").notNull(),
    atY: smallint("at_y").notNull(),
    garrisonId: bigint("garrison_id", { mode: "number" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    resolvesAt: timestamp("resolves_at", { withTimezone: true }).notNull(),
    status: siegeStatusEnum("status").notNull().default("ACTIVE"),
    eventId: bigint("event_id", { mode: "number" }),
  },
  (t) => [
    index("sieges_active_idx").on(t.resolvesAt),
    uniqueIndex("sieges_one_per_target_uq")
      .on(t.seasonId, t.targetAllianceId)
      .where(sql`status = 'ACTIVE'`),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    channelType: text("channel_type").notNull(),
    channelId: bigint("channel_id", { mode: "number" }).notNull(),
    playerId: bigint("player_id", { mode: "number" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_channel_idx").on(t.channelType, t.channelId, t.id)],
);

// ─────────────────────────────────────────────────────────────
// 遺跡
// ─────────────────────────────────────────────────────────────

export const ruins = pgTable(
  "ruins",
  {
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    ruinId: smallint("ruin_id").notNull(),
    x: smallint("x").notNull(),
    y: smallint("y").notNull(),
    phase: ruinPhaseEnum("phase").notNull().default("SEALED"),
    /** T + 3 天（夏季首日） */
    unsealsAt: timestamp("unseals_at", { withTimezone: true }).notNull(),

    /** 軍團本體的兵種與數量 */
    guardUnits: jsonb("guard_units").notNull(),
    legionBase: numeric("legion_base", { precision: 10, scale: 0 }).notNull(),
    /** 對應的系統 player（走與真人相同的引擎與驗證路徑） */
    legionPlayerId: bigint("legion_player_id", { mode: "number" }),
    lastSortieAt: timestamp("last_sortie_at", { withTimezone: true }),

    controlAllianceId: bigint("control_alliance_id", { mode: "number" }),
    progress: numeric("progress", { precision: 5, scale: 2 }).notNull().default("0"),
    controlledSince: timestamp("controlled_since", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.seasonId, t.ruinId] })],
);

export const ruinControlLog = pgTable("ruin_control_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  seasonId: integer("season_id").notNull(),
  ruinId: smallint("ruin_id").notNull(),
  allianceId: bigint("alliance_id", { mode: "number" }),
  gainedAt: timestamp("gained_at", { withTimezone: true }).notNull(),
  lostAt: timestamp("lost_at", { withTimezone: true }),
});

// ─────────────────────────────────────────────────────────────
// 事件（結算引擎核心）
// ─────────────────────────────────────────────────────────────

/**
 * 世界狀態 = f(上次結算狀態, 期間內所有已排程事件, 時間)，
 * 而 f 必須是確定性且冪等的。
 *
 * 結算順序：ORDER BY (resolve_at, seq, id)。
 * `seq` 讓同一時刻的事件有確定順序（例如建造完成必須排在戰鬥之前，
 * 確保剛升好的城牆能算進防禦）。
 */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull(),
    type: eventTypeEnum("type").notNull(),
    actorId: bigint("actor_id", { mode: "number" }),
    payload: jsonb("payload").notNull(),
    resolveAt: timestamp("resolve_at", { withTimezone: true }).notNull(),
    /** NULL = 未結算 */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    seq: integer("seq").notNull().default(0),
  },
  (t) => [
    index("events_pending_idx").on(t.resolveAt, t.seq, t.id).where(sql`resolved_at IS NULL`),
    index("events_actor_idx").on(t.actorId, t.resolveAt).where(sql`resolved_at IS NULL`),
  ],
);

// ─────────────────────────────────────────────────────────────
// 集市
// ─────────────────────────────────────────────────────────────

export const listingStatusEnum = pgEnum("listing_status", ["OPEN", "TAKEN", "CANCELLED"]);

/**
 * 交易掛單。**只有同一聯盟的人看得到、接得到**（`docs/03` §5）。
 *
 * 掛單的當下賣方就被扣款，資源進入託管 ——
 * 否則掛十張單再把資源花光，承接的人會全部撲空。
 */
export const marketListings = pgTable(
  "market_listings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    sellerId: bigint("seller_id", { mode: "number" }).notNull().references(() => players.id),
    /** 反正規化：掛單當下的聯盟。查詢時仍要驗賣方**現在**還在不在這個聯盟 */
    allianceId: bigint("alliance_id", { mode: "number" }).notNull(),

    offerResource: text("offer_resource").notNull(),
    offerAmount: numeric("offer_amount", { precision: 14, scale: 3 }).notNull(),
    wantResource: text("want_resource").notNull(),
    wantAmount: numeric("want_amount", { precision: 14, scale: 3 }).notNull(),

    status: listingStatusEnum("status").notNull().default("OPEN"),
    buyerId: bigint("buyer_id", { mode: "number" }).references(() => players.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    index("listings_alliance_idx").on(t.seasonId, t.allianceId).where(sql`status = 'OPEN'`),
    index("listings_seller_idx").on(t.sellerId).where(sql`status = 'OPEN'`),
    check("listing_amounts_positive", sql`${t.offerAmount} > 0 AND ${t.wantAmount} > 0`),
    check("listing_distinct_resources", sql`${t.offerResource} <> ${t.wantResource}`),
  ],
);

/**
 * 每位玩家每個遊戲日的資源轉移量，用來套 `500 × 主堡等級` 的日上限。
 *
 * ★ 「一日」= 一個**遊戲月**，不是遊戲日。一個真實日等於一個遊戲月
 *   （`docs/00` 的賽季設定），而遊戲日只有 48 分鐘 ——
 *   照遊戲日重置的話上限會一天放行 30 次，等於沒有上限。
 *
 * ★ 為什麼是一張表而不是一個欄位：存 `(玩家, 遊戲月)` 就**不需要任何
 *   重置排程**。換月自動換一列，沒有「誰負責在午夜歸零」這個問題，
 *   也不會有排程掛掉導致上限永遠不重置的故障模式。
 */
export const marketTransfers = pgTable(
  "market_transfers",
  {
    playerId: bigint("player_id", { mode: "number" }).notNull().references(() => players.id),
    /** 遊戲月 1–12，等於賽季的第幾個真實日 */
    gameMonth: smallint("game_month").notNull(),
    amount: numeric("amount", { precision: 14, scale: 3 }).notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.gameMonth] })],
);

// ─────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────

export const playersRelations = relations(players, ({ one, many }) => ({
  user: one(users, { fields: [players.userId], references: [users.id] }),
  season: one(seasons, { fields: [players.seasonId], references: [seasons.id] }),
  resources: one(playerResources, {
    fields: [players.id],
    references: [playerResources.playerId],
  }),
  population: one(playerPopulation, {
    fields: [players.id],
    references: [playerPopulation.playerId],
  }),
  steward: one(stewards, { fields: [players.id], references: [stewards.playerId] }),
  slots: many(baseSlots),
}));

export const alliancesRelations = relations(alliances, ({ many, one }) => ({
  members: many(allianceMembers),
  season: one(seasons, { fields: [alliances.seasonId], references: [seasons.id] }),
}));

export const allianceMembersRelations = relations(allianceMembers, ({ one }) => ({
  alliance: one(alliances, {
    fields: [allianceMembers.allianceId],
    references: [alliances.id],
  }),
  player: one(players, { fields: [allianceMembers.playerId], references: [players.id] }),
}));
