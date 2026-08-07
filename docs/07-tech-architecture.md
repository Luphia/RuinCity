# 07 · 技術架構

## 1. 技術選型

| 層 | 選擇 | 理由 |
| --- | --- | --- |
| 框架 | **Next.js 16.3**（App Router、Turbopack） | Server Components 減少 JS bundle；Route Handlers 直接當 API |
| UI | **React 19.2** + TypeScript（strict） | React Compiler 自動 memo；其 purity lint 會擋下 render 中的 `Date.now()`，正好與「時間權威來自伺服器」一致 |
| 樣式 | **Tailwind CSS v4** | HUD／面板用；地圖不走 DOM |
| 地圖渲染 | **PixiJS v8**（WebGL） | 批次渲染 + texture atlas，手機上 60fps 渲染數千 sprite |
| 客戶端狀態 | **Zustand** | 輕量，適合遊戲狀態；避免 Redux 樣板 |
| 伺服器狀態 | **TanStack Query v5** | 快取、背景重新驗證、樂觀更新 |
| 資料庫 | **PostgreSQL**（Neon serverless） | 需要交易與 row lock 保證結算正確性。**注意**：Auth 與唯讀查詢用 `neon-http`，但結算路徑需交易，必須改用 `neon-serverless` 的 WebSocket pool |
| ORM | **Drizzle ORM** | 型別安全、產生的 SQL 可預測、無執行期反射開銷 |
| 快取／鎖 | **Redis**（Upstash） | 分散式鎖、rate limit、地圖動態層快取 |
| 認證 | **Auth.js v5** | Google OAuth + Email OTP。**不做訪客帳號** |
| 即時推播 | **SSE**（Server-Sent Events） | 單向推播就夠（戰報、聊天、警報）；比 WebSocket 省資源 |
| 排程 | **Vercel Cron** + **Upstash QStash** | Cron 掃描到期事件；QStash 做精確時點觸發 |
| 部署 | **Vercel** | Edge 靜態地形 + Node runtime 遊戲邏輯 |
| 監控 | Sentry + Vercel Analytics | |

### 為什麼不用 WebSocket 全即時

行軍計時制的所有狀態變化都是**可預測的**：
派兵時就已知抵達時間，建造時就已知完成時間。
客戶端只需要「當前狀態 + 未來事件時間表」，就能自己跑倒數計時器，
不需要伺服器每秒推送。SSE 只在**非預期事件**（被攻擊、收到聊天）時推播。

這讓一台伺服器能服務的玩家數提高一個數量級，也讓手機省電。

## 2. 核心設計：確定性結算引擎

整個遊戲的正確性建立在一個原則上：

> **世界狀態 = f(上次結算狀態, 期間內所有已排程事件, 時間)**
> 而 f 必須是**確定性**且**冪等**的。

### 2.1 事件表

所有有時間性的動作都寫入 `events` 表：

```sql
CREATE TABLE events (
  id           BIGSERIAL PRIMARY KEY,
  season_id    INT NOT NULL,
  type         event_type NOT NULL,   -- MARCH_ARRIVE, BUILD_DONE, CLAIM_DONE,
                                      -- TRAIN_DONE, RUIN_TICK, ISOLATION_EXPIRE …
  actor_id     BIGINT,                -- 玩家或聯盟
  payload      JSONB NOT NULL,
  resolve_at   TIMESTAMPTZ NOT NULL,
  resolved_at  TIMESTAMPTZ,           -- NULL = 未結算
  seq          INT NOT NULL DEFAULT 0 -- 同一時刻的結算順序（tie-break）
);

CREATE INDEX ON events (resolve_at) WHERE resolved_at IS NULL;
CREATE INDEX ON events (actor_id, resolve_at) WHERE resolved_at IS NULL;
```

### 2.2 雙軌結算

```
軌道 A：Pull（玩家請求時）
  玩家發任何 API 請求
    → settlePlayer(playerId, now)
        取出該玩家所有 resolve_at <= now 且未結算的事件
        依 (resolve_at, seq, id) 排序，在單一交易內逐一結算
    → 才處理該請求本身

軌道 B：Push（Cron 每 60 秒）
  掃描所有 resolve_at <= now 且未結算，且 type 屬於
  「會影響他人」的事件（MARCH_ARRIVE / RUIN_TICK / ISOLATION_EXPIRE）
    → 結算並透過 SSE 推播給受影響玩家
```

**為什麼需要兩軌**：
軌道 A 讓玩家自己的建造、招兵可以零延遲結算，不需等 cron。
軌道 B 保證**守方即使離線也會被結算**——不能因為守方沒登入，攻方的行軍就卡住。

### 2.3 冪等與併發

```
每次結算單一事件時：
BEGIN;
  SELECT * FROM events WHERE id = $1 AND resolved_at IS NULL FOR UPDATE SKIP LOCKED;
  -- 若無列回傳，代表已被其他 worker 結算 → 直接跳過
  ... 執行結算邏輯 ...
  UPDATE events SET resolved_at = now() WHERE id = $1;
COMMIT;
```

- `FOR UPDATE SKIP LOCKED` 讓多個 cron 實例可以安全並行，不會重複結算。
- 涉及兩位玩家的事件（戰鬥）：**依 player_id 由小到大依序鎖定**，避免死鎖。
- 所有結算邏輯是純函式 `resolve(event, worldSlice) → mutations[]`，
  可以在測試中重放整個賽季的事件序列並驗證結果一致。

### 2.4 時間權威

所有時間以**伺服器 `now()`** 為準，客戶端時間完全不信任。
API 回應一律附帶 `serverTime`，客戶端計算 `offset = serverTime − clientTime`
並用它校正所有倒數計時器顯示。

## 3. 地圖資料傳輸

500×500 = 250,000 格。全量傳輸不可行。分層處理：

### 3.1 靜態地形層（賽季內不變）

- 賽季開始時預先產生 64 個 chunk（每個 64×64 格）
- 每格 1 byte 地形碼 → 4 KB/chunk，gzip 後約 800 bytes
- 存 CDN：`/terrain/{seasonId}/{cx}_{cy}.bin`，`Cache-Control: immutable, max-age=31536000`
- 前端 IndexedDB 快取，第二次載入零網路請求

### 3.2 動態層（歸屬、據點、遺跡）

```
GET /api/map?x=120&y=340&w=40&h=60&z=1
→ {
    serverTime,
    bases:      [{ x, y, playerId, name, allianceId, citadelLv, isNewbie }],
    territories:[{ x, y, playerId, allianceId, facility, facilityLv, state }],
    ruins:      [{ x, y, id, controlAllianceId, progress, phase }],
    camps:      [{ x, y, level }],
    marches:    [{ fromX, fromY, toX, toY, eta, type, visible }]  // 只含可見的
  }
```

- 查詢用 `WHERE x BETWEEN … AND y BETWEEN …`，複合索引 `(season_id, x, y)`
- 回應快取 **10 秒**（`s-maxage=10, stale-while-revalidate=30`）——
  地圖不需要秒級精確，10 秒的陳舊完全可接受，卻能擋掉 90% 的 DB 查詢
- L3 戰略視圖用另一個端點 `/api/map/overview`，
  回傳 500×500 每格 1 byte 的「聯盟 ID」點陣圖（250 KB → gzip 約 15 KB），
  快取 60 秒。整張圖的政治版圖用一次請求就能畫出來。

### 3.3 前端渲染

```
PixiJS 場景圖
├─ terrainLayer   （靜態貼圖，只在 chunk 進出視野時增刪 sprite）
├─ territoryLayer （半透明聯盟色塊，用 ParticleContainer 批次渲染）
├─ structureLayer （據點、設施、遺跡）
├─ marchLayer     （行軍箭頭，每幀依 eta 插值位置）
└─ uiOverlayLayer （選取框、格線、標籤）
```

- **視野剔除**：只建立可見範圍 + 1 格 padding 的 sprite；
  離開視野的 sprite 回收到物件池（避免 GC 抖動）
- **Texture Atlas**：所有地形與建築貼圖打包成單張 2048×2048 圖集 → 一次 draw call
- **整數像素對齊**：`roundPixels: true` + 只允許 1× / 2× / 4× / 8× / 16× 縮放，
  確保像素不會被插值糊掉
- **省電**：無互動 5 秒後降到 15fps；分頁隱藏時 `ticker.stop()`

## 4. API 設計

### 4.1 分層

```
Server Components  → 首屏資料直出（據點概況、資源、佇列）
Server Actions     → 玩家指令（升級建築、招兵、派兵）— 有 CSRF 保護
Route Handlers     → 地圖查詢、SSE 串流、輪詢端點
```

### 4.2 指令端點（全部走 Server Action）

| Action | 說明 |
| --- | --- |
| `upgradeBuilding(slot)` | 核心建築升級 |
| `buildFacility(x, y, type)` | 領土設施建造 |
| `demolish(slot)` | 拆除核心建築 |
| `trainUnits(unitType, qty)` | 招兵 |
| `dispatchMarch(targetX, targetY, units, marchType, options)` | 派遣行軍 |
| `recallMarch(marchId)` | 召回 |
| `claimTile(x, y)` | 派遣拓荒隊 |
| `createAlliance / joinAlliance / …` | 聯盟操作 |

**每個 action 的執行順序固定為**：

```
1. auth 檢查
2. rate limit（Redis, sliding window）
3. settlePlayer(playerId, now)     ← 先結算，再驗證
4. 驗證前置條件（資源夠嗎？人口夠嗎？距離合法嗎？）
5. 在單一交易中：扣款 + 寫入 events + 更新速率
6. revalidateTag(...) 讓 Next.js 快取失效
```

第 3 步在第 4 步之前是絕對不能搞錯的順序——
否則玩家會用「剛好完成的建造」之外的舊資源狀態通過驗證。

### 4.3 SSE 推播

```
GET /api/stream  (text/event-stream, 保持連線)

事件類型：
  battle_report   戰報產生
  incoming_attack 來襲警報（30 分鐘前）
  chat            聯盟聊天
  ruin_update     遺跡控制權變化
  season_alert    賽季倒數
```

- 連線上限：每帳號 2 條（多分頁）
- 心跳：每 25 秒送 `:ping`（避開多數 proxy 的 30 秒逾時）
- 斷線重連：客戶端用 `Last-Event-ID` 補送遺漏事件（伺服器保留 5 分鐘）
- 分頁隱藏 > 5 分鐘自動斷線，回到前景重連（省手機電量）

## 5. 反作弊

| 風險 | 對策 |
| --- | --- |
| 竄改客戶端數值 | 所有計算在伺服器；客戶端數值僅供顯示，任何提交都重新驗證 |
| 重放攻擊 | Server Action 內建 CSRF token；關鍵操作附 idempotency key |
| 加速器／改時間 | 所有時間用伺服器 `now()`；客戶端時間只用於顯示校正 |
| 腳本掛機 | Rate limit（每玩家 60 req/min）；異常操作頻率標記人工審核 |
| 資源複製 | 所有扣款與加值在同一 DB 交易內；資源欄位加 `CHECK (amount >= 0)` |
| 併發雙花 | 玩家層級的 advisory lock：`pg_advisory_xact_lock(player_id)` |
| 多開小號 | 裝置指紋 + IP 群集偵測 → 標記；資源轉移日上限（見 `06` §4） |

## 6. 效能預算

| 指標 | 目標 |
| --- | --- |
| 首次載入 JS（gzip） | < 180 KB |
| 首屏可互動（4G 手機） | < 3 秒 |
| 地圖平移 FPS（中階 Android） | ≥ 50 |
| API p95 延遲 | < 200 ms |
| Cron 單次結算（1,000 事件） | < 10 秒 |
| 每玩家每日 DB 寫入 | < 50 次 |

## 7. 專案結構（規劃）

```
/app
  /(game)/                  遊戲主介面（需登入）
    base/                   據點畫面
    map/                    地圖畫面
    army/                   軍隊與行軍
    alliance/               聯盟
    reports/                戰報
  /(marketing)/             首頁、賽季歸檔頁
    signin/                 登入（Google OAuth + Email OTP，不做訪客）
  /api/
    map/route.ts
    map/overview/route.ts
    stream/route.ts
    cron/settle/route.ts
/lib
  env.ts                    環境變數（延遲驗證，build 不因缺 env 失敗）
  time.ts                   ★ 時間權威：serverNow() / withServerTime()
  /game/                    ★ 純函式遊戲邏輯（無 I/O，可單元測試）
    combat.ts               戰鬥公式
    march.ts                行軍時間
    economy.ts              資源結算
    territory.ts            連通性檢查、佔領規則
    ruins.ts                遺跡進度
    calendar.ts             遊戲曆法與四季係數
    steward.ts              執政官決策
    supply.ts               區域軍隊容量
    balance/                ★ 所有數值表（單一真相來源）
  /engine/
    settle.ts               結算引擎
    events.ts               事件排程
  /db/                      Drizzle schema 與 queries
    schema.ts               遊戲表（24 張）
    auth-schema.ts          Auth.js 表（4 張，與遊戲 users 表以 email 對應）
  /render/                  PixiJS 場景與圖層
/scripts
  generate-map.ts           賽季地圖生成 CLI
  simulate-season.ts        平衡性模擬（無 UI 跑完整賽季）
```

`/lib/game` 完全無 I/O 是刻意的：
它讓 `scripts/simulate-season.ts` 可以在幾秒內模擬 600 名玩家跑完 12 天賽季，
用來驗證數值平衡。**數值調整必須先跑模擬再上線。**

12 天賽季讓模擬成本降到原設計（48 天）的四分之一，
而每 7 天輪替一場代表**真實世界的迭代週期也只有 12–14 天**——
模擬與實測可以緊密接在一起。

## 8. 測試策略

| 層級 | 範圍 |
| --- | --- |
| 單元測試（Vitest） | `/lib/game` 全部純函式，特別是戰鬥公式的邊界值 |
| 事件重放測試 | 給定事件序列，驗證世界狀態最終一致；同一序列跑兩次結果相同（冪等） |
| 併發測試 | 同時對同一玩家發 100 個請求，驗證資源不會變負或複製 |
| 賽季模擬 | 每次調整數值後跑 10 次完整賽季模擬，檢查勝利時間落在遊戲月 9–12（D8–D12），且無任何一場在夏季前結束 |
| AI 模擬 | 全 AI 賽季（600 AI）能自然演進 12 天且遺跡軍團不被清空（見 `15` §8） |
| E2E（Playwright） | 註冊 → 建造 → 招兵 → 派兵 → 戰報 的完整主線 |
