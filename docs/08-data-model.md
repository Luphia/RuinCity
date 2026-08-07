# 08 · 資料模型

PostgreSQL + Drizzle ORM。以下為概念 schema，實作時以 `/lib/db/schema.ts` 為準。

## 1. 全域

```sql
-- 賽季：所有遊戲資料都掛在賽季下，賽季結束後整批歸檔
CREATE TABLE seasons (
  id            SERIAL PRIMARY KEY,
  seed          BIGINT      NOT NULL,       -- 地圖生成種子（可能在封盤期被換掉多次）
  status        TEXT        NOT NULL,       -- REGISTRATION | SEALED | RUNNING |
                                            -- ENDING | ARCHIVED
  registration_opens_at  TIMESTAMPTZ,       -- 登記期開始（開賽前 3.5 天）
  registration_closes_at TIMESTAMPTZ,       -- 封盤（開賽前 12 小時）
  started_at    TIMESTAMPTZ,                -- T = 0，600 人同時進入
  ends_at       TIMESTAMPTZ,                -- T + 12 天（期滿結算）
  balance_version TEXT NOT NULL,            -- ★ 數值表版本快照，封盤時固定。
                                            -- 進行中的賽季永不受新版本影響（見 12 B16）
  human_count   INT NOT NULL DEFAULT 0,     -- 真人數（公開）
  ai_count      INT NOT NULL DEFAULT 0,     -- AI 數（公開），human + ai = 600
  ruin_positions JSONB,                     -- 封盤期產生
  fairness_report JSONB,                    -- 五項驗證的實際數值（公開給玩家）
  victory_alliance_id BIGINT,
  victory_countdown_started_at TIMESTAMPTZ, -- 三遺跡同控起始時間
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 賽季登記：在 players 之前存在，封盤期才轉換為 players
CREATE TABLE season_registrations (
  id           BIGSERIAL PRIMARY KEY,
  season_id    INT    NOT NULL REFERENCES seasons(id),
  user_id      BIGINT NOT NULL REFERENCES users(id),
  faction      SMALLINT NOT NULL,           -- 1 | 2 | 3，對應三座遺跡
  spawn_band   TEXT     NOT NULL,           -- VANGUARD | HEARTLAND | FRONTIER
  squad_code   VARCHAR(12),                 -- 同行小隊代碼，最多 8 人共用
  assigned_x   SMALLINT,                    -- 封盤期分配後寫入
  assigned_y   SMALLINT,
  player_id    BIGINT REFERENCES players(id),  -- T=0 建立 player 後回填
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_id, user_id)
);

-- 名額控制：每場固定 600 人 → 容量是常數，不需動態計算。
-- 陣營 200 / 陣營；出生帶 前線 40 / 中原 100 / 邊陲 60。
CREATE TABLE season_quotas (
  season_id  INT      NOT NULL REFERENCES seasons(id),
  faction    SMALLINT NOT NULL,          -- 1 | 2 | 3
  spawn_band TEXT     NOT NULL,          -- VANGUARD | HEARTLAND | FRONTIER
  capacity   INT      NOT NULL,          -- 40 | 100 | 60
  taken      INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (season_id, faction, spawn_band),
  CHECK (taken >= 0 AND taken <= capacity)
);

CREATE INDEX reg_squad_idx ON season_registrations (season_id, squad_code)
  WHERE squad_code IS NOT NULL;
```

### 登記的併發控制

固定 600 人讓這件事變得非常單純——容量是常數，
`CHECK (taken <= capacity)` 直接在資料庫層擋住超賣，
不需要 advisory lock 或應用層的容量計算：

```sql
BEGIN;
  -- 單一原子遞增；超出容量時 CHECK 約束會讓這句失敗
  UPDATE season_quotas
     SET taken = taken + 1
   WHERE season_id = $seasonId AND faction = $f AND spawn_band = $b
     AND taken < capacity
  RETURNING taken;
  -- 0 rows → 名額已滿，ROLLBACK 並回傳友善訊息

  INSERT INTO season_registrations (...) VALUES (...);
  UPDATE seasons SET human_count = human_count + 1 WHERE id = $seasonId;
COMMIT;
```

> 上一版因為採用「隨總登記數動態成長」的容量，
> 需要賽季層級的 advisory lock 把整個登記流程序列化。
> **固定 600 人的決策讓這套機制整個消失了** —— 這是規格簡化帶來的實作簡化。

### AI 補足（封盤期）

```sql
-- 封盤時，對每個 (faction, spawn_band) 補足 capacity - taken 個 AI
-- AI 直接建立 players（user_id = NULL），不經過 season_registrations
INSERT INTO players (season_id, user_id, is_ai, ai_persona, ai_variance, ...)
SELECT $seasonId, NULL, true, pick_persona(i), 0.85 + random_from_seed(i) * 0.30, ...
  FROM generate_series(1, $shortfall) AS i;
```

性格配比 Settler 50% / Warden 35% / Warlord 15%，
`ai_variance` 由賽季 seed 決定性產生（不用 `random()`，保持可重現）。

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
  user_id        BIGINT REFERENCES users(id),  -- AI 為 NULL
  alliance_id    BIGINT REFERENCES alliances(id),
  faction        SMALLINT NOT NULL,          -- 1 | 2 | 3
  spawn_band     TEXT     NOT NULL,          -- VANGUARD | HEARTLAND | FRONTIER
  base_x         SMALLINT NOT NULL,          -- 核心據點左上角 (A 格)
  base_y         SMALLINT NOT NULL,
  citadel_level  SMALLINT NOT NULL DEFAULT 1,
  newbie_until   TIMESTAMPTZ NOT NULL,
  last_seen_at   TIMESTAMPTZ,                -- 用於 AI 託管判定與遺物分配
  settled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- AI 欄位（見 15-ai-players.md §7.3）
  is_ai          BOOLEAN NOT NULL DEFAULT false,
  ai_persona     TEXT,                       -- SETTLER | WARDEN | WARLORD
  ai_variance    NUMERIC(4,3),               -- ±15% 個體偏移，賽季開始時決定
  ai_takeover_at TIMESTAMPTZ,                -- 非 NULL = 託管中的真人帳號
  UNIQUE (season_id, user_id),
  UNIQUE (season_id, base_x, base_y)
);

CREATE INDEX players_ai_idx      ON players (season_id, is_ai);
CREATE INDEX players_faction_idx ON players (season_id, faction);
-- 一位使用者同時只能在一場「進行中」的賽季（見 12 B1），於應用層驗證

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
賽季高峰約 600 玩家 × 平均 60 格 ≈ **36,000 列**，加上營地與遺跡約 4.8 萬列，
在 Postgres 上小到幾乎不需要優化，viewport range query 走索引在 2ms 內完成。

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
  phase         TEXT     NOT NULL DEFAULT 'SEALED',  -- SEALED | DORMANT | AWAKENED |
                                                     -- CONTESTED | CONTROLLED
  unseals_at    TIMESTAMPTZ NOT NULL,      -- T + 3 天（夏季首日）
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
  'CONTEST_EXPIRE', 'RUIN_TICK', 'RUIN_UNSEAL', 'CAMP_RESPAWN',
  'SEASON_VICTORY_CHECK', 'SEASON_EXPIRE', 'NEWBIE_EXPIRE',
  'SEASON_CHANGE',      -- 四季切換（每 3 真實日）與切換前 6 小時預警
  'AI_TICK',            -- 每遊戲月邊界的 AI 決策（見 15 §7.1）
  'AI_RETALIATE',       -- AI 反擊（被攻擊後 1–4 小時）
  'AI_TAKEOVER'         -- 離線真人轉 AI 託管
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

**單場賽季**（600 人、12 天）：

| 表 | 列數 | 說明 |
| --- | --- | --- |
| `players` | 600 | 真人 + AI |
| `player_resources` | 600 | |
| `base_slots` | 2,400 | 4 × 玩家數 |
| `tiles` | ~48,000 | 領土（600 × ~60）+ 據點 + 營地 + 遺跡 |
| `garrisons` | ~4,000 | 含增援與前哨駐軍 |
| `marches`（進行中） | ~800 | |
| `events`（未結算） | ~6,000 | |
| `events`（累計 12 天） | ~900,000 | 賽季結束歸檔 |
| `battle_reports` | ~250,000 | |
| `chat_messages` | ~400,000 | |

**同時兩場並行**：以上數字 ×2。

> **短賽季反而讓伺服器成本大幅下降。**
> 原設計（單場 3,000 人 × 8 週）的 `events` 累計約 800 萬列；
> 現在兩場並行合計不到 200 萬列，且每 12 天整批歸檔一次。
> 分割表的粒度也從「按週」簡化為「按賽季」——
> 一場結束就 `DETACH PARTITION`，乾淨俐落。

`events` 與 `battle_reports` 以 **`season_id` 做宣告式分割**，
賽季結束時整批 `DETACH PARTITION` 歸檔，不影響另一場進行中的賽季。

## 9. 歸檔

賽季結束後產生**靜態快照**供 `/seasons/{id}` 永久瀏覽：

- 最終地圖點陣圖（PNG，每格 1px，500×500）
- 聯盟排行榜 JSON
- 遺跡控制時間軸 JSON
- 重大戰役 top 100 戰報

活躍資料表則清空並準備下一賽季。玩家的 `users.legacy_points` 與 `titles` 保留。
