# 08 · 資料模型

PostgreSQL + Drizzle ORM。以下為概念 schema，實作時以 `/lib/db/schema.ts` 為準。

## 1. 全域

```sql
-- 賽季：所有遊戲資料都掛在賽季下，賽季結束後整批歸檔
CREATE TABLE seasons (
  id            SERIAL PRIMARY KEY,
  seed          BIGINT      NOT NULL,       -- 地圖生成種子
  status        TEXT        NOT NULL,       -- PREPARING | RUNNING | ENDING | ARCHIVED
  started_at    TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,                -- 保底 8 週
  victory_alliance_id BIGINT,
  victory_countdown_started_at TIMESTAMPTZ, -- 三遺跡同控起始時間
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT UNIQUE,
  provider      TEXT,                       -- google | email | guest
  display_name  TEXT NOT NULL,
  legacy_points INT  NOT NULL DEFAULT 0,    -- 跨賽季傳承
  titles        JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ
);
```

## 2. 玩家與據點

```sql
-- 一位 user 在一個賽季有一個 player
CREATE TABLE players (
  id             BIGSERIAL PRIMARY KEY,
  season_id      INT    NOT NULL REFERENCES seasons(id),
  user_id        BIGINT NOT NULL REFERENCES users(id),
  alliance_id    BIGINT REFERENCES alliances(id),
  base_x         SMALLINT NOT NULL,          -- 核心據點左上角 (A 格)
  base_y         SMALLINT NOT NULL,
  citadel_level  SMALLINT NOT NULL DEFAULT 1,
  newbie_until   TIMESTAMPTZ NOT NULL,
  settled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_id, user_id),
  UNIQUE (season_id, base_x, base_y)
);

-- 核心 2×2 的四個格位
CREATE TABLE base_slots (
  player_id  BIGINT NOT NULL REFERENCES players(id),
  slot       CHAR(1) NOT NULL,               -- A | B | C | D
  building   TEXT,                           -- NULL = 空地；A 恆為 CITADEL
  level      SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, slot)
);
```

### 資源：快照 + 速率（惰性結算）

```sql
CREATE TABLE player_resources (
  player_id    BIGINT PRIMARY KEY REFERENCES players(id),
  grain        NUMERIC(14,3) NOT NULL DEFAULT 500 CHECK (grain  >= 0),
  timber       NUMERIC(14,3) NOT NULL DEFAULT 500 CHECK (timber >= 0),
  stone        NUMERIC(14,3) NOT NULL DEFAULT 500 CHECK (stone  >= 0),
  iron         NUMERIC(14,3) NOT NULL DEFAULT 200 CHECK (iron   >= 0),
  relic        NUMERIC(14,3) NOT NULL DEFAULT 0   CHECK (relic  >= 0),
  grain_rate   NUMERIC(12,3) NOT NULL DEFAULT 0,  -- 每小時，可為負（養兵）
  timber_rate  NUMERIC(12,3) NOT NULL DEFAULT 0,
  stone_rate   NUMERIC(12,3) NOT NULL DEFAULT 0,
  iron_rate    NUMERIC(12,3) NOT NULL DEFAULT 0,
  capacity     NUMERIC(12,0) NOT NULL DEFAULT 2000,
  settled_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
```

> 只在「速率改變」或「扣款」時寫入。讀取時線性推算，詳見 `03-economy.md` §2.2。

## 3. 地圖

```sql
-- 地形不入庫：由 seed 決定性生成，以靜態 chunk 檔提供。
-- 只有「被誰佔用」需要持久化。
CREATE TABLE tiles (
  season_id  INT      NOT NULL,
  x          SMALLINT NOT NULL,
  y          SMALLINT NOT NULL,
  kind       TEXT     NOT NULL,     -- BASE_CORE | TERRITORY | RUIN | CAMP
  player_id  BIGINT   REFERENCES players(id),
  alliance_id BIGINT  REFERENCES alliances(id),   -- 反正規化，加速地圖著色查詢
  facility   TEXT,                  -- FARM | SAWMILL | QUARRY | MINE |
                                    -- WATCHTOWER | OUTPOST | MARKET
  facility_level SMALLINT NOT NULL DEFAULT 0,
  state      TEXT NOT NULL DEFAULT 'NORMAL',  -- NORMAL | CONTESTED | ISOLATED | CLAIMING
  state_until TIMESTAMPTZ,
  PRIMARY KEY (season_id, x, y)
);

CREATE INDEX tiles_viewport_idx ON tiles (season_id, x, y) INCLUDE (kind, alliance_id);
CREATE INDEX tiles_player_idx   ON tiles (player_id) WHERE player_id IS NOT NULL;
```

**設計說明**：
`tiles` 只存**已被佔用**的格子，不是全部 250,000 列。
賽季高峰約 3,000 玩家 × 平均 60 格 ≈ **180,000 列**，加上營地與遺跡約 19 萬列，
在 Postgres 上是很小的表，viewport range query 走索引在 5ms 內完成。

`alliance_id` 是反正規化欄位（可由 `player_id → players.alliance_id` 推出），
但地圖著色是最高頻查詢，值得用一個 trigger 或應用層同步維護來換取效能。

### 領土連通性

不建圖結構，改在需要時做 BFS：

```
玩家平均 60 格、最多 120 格 → BFS 成本可忽略。
觸發時機：任一領土格易主時，對受影響玩家跑一次 BFS，
標記所有無法回到核心的格子為 ISOLATED，並排程 ISOLATION_EXPIRE 事件（+24h）。
```

## 4. 軍事

```sql
-- 玩家在「某個位置」的駐軍。位置可以是自己核心、前哨營、遺跡、或增援中的盟友據點
CREATE TABLE garrisons (
  id          BIGSERIAL PRIMARY KEY,
  season_id   INT      NOT NULL,
  owner_id    BIGINT   NOT NULL REFERENCES players(id),  -- 部隊的所有者（付糧的人）
  at_x        SMALLINT NOT NULL,
  at_y        SMALLINT NOT NULL,
  host_id     BIGINT   REFERENCES players(id),           -- 駐紮地的主人（增援時 ≠ owner）
  units       JSONB    NOT NULL,   -- { "SWORDSMAN": 320, "ARCHER": 150, ... }
  UNIQUE (season_id, owner_id, at_x, at_y)
);

CREATE INDEX garrisons_at_idx ON garrisons (season_id, at_x, at_y);

CREATE TABLE marches (
  id          BIGSERIAL PRIMARY KEY,
  season_id   INT      NOT NULL,
  owner_id    BIGINT   NOT NULL REFERENCES players(id),
  type        TEXT     NOT NULL,   -- RAID | ATTACK | SCOUT | CLAIM |
                                   -- REINFORCE | GARRISON | RETURN
  from_x      SMALLINT NOT NULL,
  from_y      SMALLINT NOT NULL,
  to_x        SMALLINT NOT NULL,
  to_y        SMALLINT NOT NULL,
  units       JSONB    NOT NULL,
  cargo       JSONB,               -- 返程時攜帶的資源
  target_slot CHAR(1),             -- 投石機指定拆除的建築格
  departed_at TIMESTAMPTZ NOT NULL,
  arrives_at  TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'IN_TRANSIT', -- IN_TRANSIT | ARRIVED | RECALLED
  event_id    BIGINT REFERENCES events(id)
);

CREATE INDEX marches_arrival_idx ON marches (arrives_at) WHERE status = 'IN_TRANSIT';
CREATE INDEX marches_target_idx  ON marches (season_id, to_x, to_y) WHERE status = 'IN_TRANSIT';

CREATE TABLE battle_reports (
  id           BIGSERIAL PRIMARY KEY,
  season_id    INT NOT NULL,
  attacker_id  BIGINT REFERENCES players(id),
  defender_id  BIGINT REFERENCES players(id),
  at_x         SMALLINT NOT NULL,
  at_y         SMALLINT NOT NULL,
  march_type   TEXT   NOT NULL,
  snapshot     JSONB  NOT NULL,  -- 雙方出戰兵力、戰力值、士氣、存活率、掠奪、建築破壞
  outcome      TEXT   NOT NULL,  -- ATTACKER_WIN | DEFENDER_WIN
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reports_attacker_idx ON battle_reports (attacker_id, created_at DESC);
CREATE INDEX reports_defender_idx ON battle_reports (defender_id, created_at DESC);
```

`snapshot` 存完整的戰鬥輸入與輸出，讓戰報頁面可以完整重現計算過程
（玩家看得到「為什麼我輸了」）。這對這類遊戲的社群信任至關重要。

### 招兵佇列 / 建造佇列

不建獨立表，統一用 `events`：

```
TRAIN_DONE  payload: { playerId, unitType, qty }
BUILD_DONE  payload: { playerId, slot | tileXY, targetLevel }
```

佇列 UI 直接查 `events WHERE actor_id = ? AND resolved_at IS NULL ORDER BY resolve_at`。

## 5. 聯盟

```sql
CREATE TABLE alliances (
  id           BIGSERIAL PRIMARY KEY,
  season_id    INT  NOT NULL,
  name         TEXT NOT NULL,
  tag          VARCHAR(5) NOT NULL,
  color        SMALLINT   NOT NULL,     -- 0–11，賽季內唯一
  recruit_mode TEXT NOT NULL DEFAULT 'APPLY', -- OPEN | APPLY | INVITE
  leader_id    BIGINT NOT NULL REFERENCES players(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_id, name),
  UNIQUE (season_id, tag),
  UNIQUE (season_id, color)
);

CREATE TABLE alliance_members (
  alliance_id BIGINT NOT NULL REFERENCES alliances(id),
  player_id   BIGINT PRIMARY KEY REFERENCES players(id),
  rank        TEXT   NOT NULL DEFAULT 'MEMBER',  -- LEADER | OFFICER | MEMBER
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id           BIGSERIAL PRIMARY KEY,
  channel_type TEXT   NOT NULL,   -- ALLIANCE | GLOBAL | DIRECT
  channel_id   BIGINT NOT NULL,
  player_id    BIGINT REFERENCES players(id),
  body         TEXT   NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_channel_idx ON chat_messages (channel_type, channel_id, id DESC);
```

## 6. 遺跡

```sql
CREATE TABLE ruins (
  id            SMALLINT NOT NULL,       -- 1 | 2 | 3
  season_id     INT      NOT NULL,
  x             SMALLINT NOT NULL,       -- 中心格
  y             SMALLINT NOT NULL,
  phase         TEXT     NOT NULL DEFAULT 'DORMANT', -- DORMANT | AWAKENED |
                                                     -- CONTESTED | CONTROLLED
  guard_units   JSONB    NOT NULL,       -- 剩餘 PvE 守衛
  control_alliance_id BIGINT REFERENCES alliances(id),
  progress      NUMERIC(5,2) NOT NULL DEFAULT 0,     -- 0–100
  controlled_since TIMESTAMPTZ,
  PRIMARY KEY (season_id, id)
);

CREATE TABLE ruin_control_log (
  id           BIGSERIAL PRIMARY KEY,
  season_id    INT      NOT NULL,
  ruin_id      SMALLINT NOT NULL,
  alliance_id  BIGINT,
  gained_at    TIMESTAMPTZ NOT NULL,
  lost_at      TIMESTAMPTZ
);
```

`ruin_control_log` 用來計算賽季積分中的「遺跡控制總時數」，
也提供遺跡詳情頁的歷史時間軸。

## 7. 事件（結算引擎核心）

```sql
CREATE TYPE event_type AS ENUM (
  'BUILD_DONE', 'DEMOLISH_DONE', 'TRAIN_DONE',
  'MARCH_ARRIVE', 'CLAIM_DONE', 'ISOLATION_EXPIRE',
  'CONTEST_EXPIRE', 'RUIN_TICK', 'CAMP_RESPAWN',
  'SEASON_VICTORY_CHECK', 'NEWBIE_EXPIRE'
);

CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  season_id   INT NOT NULL,
  type        event_type NOT NULL,
  actor_id    BIGINT,
  payload     JSONB NOT NULL,
  resolve_at  TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  seq         INT NOT NULL DEFAULT 0
);

CREATE INDEX events_pending_idx ON events (resolve_at, seq, id) WHERE resolved_at IS NULL;
CREATE INDEX events_actor_idx   ON events (actor_id, resolve_at) WHERE resolved_at IS NULL;
```

**結算順序保證**：`ORDER BY (resolve_at, seq, id)`。
`seq` 讓同一時刻的事件有確定順序（例如：建造完成 → 再結算戰鬥，
確保剛升好的城牆能算進防禦）。這是可重現性的關鍵。

## 8. 資料量估算（賽季高峰）

| 表 | 列數 | 說明 |
| --- | --- | --- |
| `players` | 3,000 | |
| `player_resources` | 3,000 | |
| `base_slots` | 12,000 | 4 × 玩家數 |
| `tiles` | ~190,000 | 領土 + 據點 + 營地 + 遺跡 |
| `garrisons` | ~15,000 | 含增援與前哨駐軍 |
| `marches`（進行中） | ~3,000 | |
| `events`（未結算） | ~20,000 | |
| `events`（累計 8 週） | ~8,000,000 | 按月分割表，賽季結束歸檔 |
| `battle_reports` | ~2,000,000 | 90 天後歸檔至冷儲存 |
| `chat_messages` | ~5,000,000 | 30 天滾動刪除 |

`events` 與 `battle_reports` 用 **PostgreSQL 宣告式分割（按週）**，
賽季結束時整批 `DETACH PARTITION` 歸檔，不影響線上效能。

## 9. 歸檔

賽季結束後產生**靜態快照**供 `/seasons/{id}` 永久瀏覽：

- 最終地圖點陣圖（PNG，每格 1px，500×500）
- 聯盟排行榜 JSON
- 遺跡控制時間軸 JSON
- 重大戰役 top 100 戰報

活躍資料表則清空並準備下一賽季。玩家的 `users.legacy_points` 與 `titles` 保留。
