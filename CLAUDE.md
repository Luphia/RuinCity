# RuinCity — 給協作者（含 AI）的說明

## 這是什麼

像素風格、手機網頁、多人戰爭策略遊戲。500×500 廢土地圖，
600 名領主分屬 3 大陣營、15 個聯盟，一場戰役 12 天。

**先讀 [`docs/00-overview.md`](docs/00-overview.md)。** 那裡有六根體驗支柱、
七條設計原則（P1–P7），以及 A1–A19 的定案決策表。
所有實作決策都應該能追溯到其中一條。

## 開發

```bash
pnpm install
cp .env.example .env.local     # 填入 DATABASE_URL 與 AUTH_SECRET
pnpm dev

pnpm check                     # typecheck + lint + 單元測試 + 整合測試（PGlite）
pnpm test:e2e                  # Playwright（需要 build）
pnpm db:generate               # 改完 schema.ts 一定要跑，CI 會檢查是否同步
```

沙箱環境的 Chromium 版本可能與 Playwright 的 pin 對不上，
設定 `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` 即可。

## 三條不能違反的界線

**1. `/lib/game` 不得有任何 I/O。**
沒有 DB、沒有 fetch、時間一律由參數傳入。
`scripts/simulate-season.ts` 要能在幾秒內跑完 600 人 × 12 天的賽季模擬，
而**數值調整必須先跑模擬再上線**。

**2. 數值只寫在 `/lib/game/balance`，且要先改文件。**
`docs/11-balance-tables.md` 是規格，`/lib/game/balance` 是它的 TypeScript 化。
兩邊不一致時以文件為準。任何影響 PvP 平衡的改動都要 bump `BALANCE_VERSION` ——
賽季在封盤期快照該版本，**進行中的賽季永遠不受新版本影響**。

**3. 伺服器是唯一真相。**
所有計算在後端；客戶端數值僅供顯示，任何提交都重新驗證。
時間一律走 `lib/time.ts` 的 `serverNow()`，不信任客戶端時鐘。
AI 玩家、遺跡軍團、執政官都走**與真人完全相同的 Server Action 驗證路徑**，不開後門。

## 幾個容易踩到的地方

| 事情 | 注意 |
| --- | --- |
| Neon driver | `neon-http` **不支援交易**。M2 的結算路徑要改用 `neon-serverless` 的 WebSocket pool |
| 時間係數 | 數值表的時間是「48 天賽季」基準，實際值要 ÷ `TIME_SCALE`(4)；速率 × 4；單位速度 × `MARCH_SCALE`(2)。成本與戰鬥數值不套用任何係數 |
| React Compiler | render 中不可呼叫 `Date.now()` 等不純函式。這規則與 P1 一致，別繞過它 |
| Migration | 改 `schema.ts` 後務必 `pnpm db:generate`，CI 會擋下不同步的提交 |
| 倒數計時器 | 客戶端一律用 `components/use-server-clock.ts` 的 `useServerClock(serverTime)`，只取客戶端時鐘的**間隔**，不取它的絕對值 |
| 事件 | 新增事件類型時，`lib/game/events.ts` 的 `parsePayload` 與 `resolveEvent` 都要跟上。認不出來的 payload 回 `null` 被跳過 —— 不會炸掉結算，但效果也不會發生 |
| 執政官 | 只在**伺服器端**觸發（結算迴圈 + 2h 安全網），不接在頁面載入上 —— 否則它會搶走玩家正要用的佇列。禁區（核心佇列、軍事、拆除、交易）在回傳型別上就不存在，別加回來 |
| 規劃 vs 執行 | 任何「先規劃、後執行」的路徑，可負擔性判斷只能有一份實作（`maxAffordable`）。兩份遲早分岔，症狀是「系統一直在嘗試一件永遠做不到的事」 |
| 人口 | 拓荒的民兵與招募的兵都在**下單時**就計入 `population.used`，不是完成時。多條佇列各自下滿會超過上限 |
| 整合測試 | `lib/**/*.integration.test.ts` 跑在 PGlite（WASM Postgres）上，`pnpm test` 就會跑。不需要容器或連線字串 |
| 跨玩家事件 | 需要不只一個玩家的鎖的東西（戰鬥）**不屬於 `events` 表**。行軍由結算迴圈直接掃 `marches`，理由見 `docs/11` §19.1 |
| 隨機性 | 結算路徑一律 `mulberry32(deriveSeed(...))`，不用 `Math.random()`。交易會重試，而重試不該變成「再擲一次骰子」 |
| 出生點 | 兩點之間的切比雪夫距離**至少 2**（`HARD_MIN_SPACING`）—— 核心是 2×2，差一格就會疊到同一格 `tiles`。`poissonPick` 會被呼叫很多次，硬性下限只有靠那份跨呼叫的 blocker 才守得住 |
| 沒接上的係數 | 數值表有一個係數、函式簽章有對應參數、而預設值剛好是「沒有效果」—— 這種組合會安靜地失效。加參數的同時就要把呼叫端全部接好（例：`territoryCapacity` 的 `bandBonus`，M0 寫下、M5b 才真的生效） |
| 賽季階段 | 由時間戳推導（`phaseAt`），`seasons.status` 只是那個推導的快取。要判斷「現在是哪個階段」一律問 `phaseOf(season, now)`，不要讀欄位 |

## 目前進度

見 [`docs/10-roadmap.md`](docs/10-roadmap.md)。**M0、M1a、M1b、M2、M2b、M3、M5b 都已完成**，
下一步是 M3b（區域容量與超限損耗）與 M4（聯盟）。

**現在可以真的玩了**：`pnpm seed:season you@example.com`
會開一場賽季、AI 補足到 600、跑封盤、在 T=0 寫入所有人的初始狀態。

戰鬥引擎、行軍、賽季模擬都已完成，數值表也依模擬結果重新配平過四輪
（`BALANCE_VERSION` = `2026.08.07-e`，理由見
[`docs/11`](docs/11-balance-tables.md) §12–§15）。

M2 把 §1–§11 的數值表接上了資料庫，**沒有改任何數值** ——
但過程中補上了幾個文件沒說到的規則，見 `docs/11` §16。
其中兩個值得先知道：

- **事件必須真的改變速率**。`ctx.apply` 是分段積分存在的唯一理由；
  寫成恆等函式的話玩家會花掉資源卻換不到東西（`lib/game/events.ts`）
- **佇列不另存一張表**，它是 `events` 的一個 view（`deriveQueues()`）

M2b 的執政官走**與玩家完全相同的驗證路徑**（`lib/server/base-ops.ts`）——
Server Action 與執政官的差別只在「誰解析出 playerId」。
AI 玩家與遺跡軍團之後也接在這裡。理由見 `docs/11` §17.3。

M3 把 PvP 循環接上了：派兵、抵達結算、掠奪、回程、戰報、來襲預警
（`lib/server/march-ops.ts` 與 `battle-ops.ts`）。結構上的決定見 `docs/11` §19，
其中最重要的一條是 §19.1：**跨玩家的結算不走 per-player 的事件 applier**。

M5b 把賽季生命週期接上了：建立 → 登記 → 封盤（AI 補足 + 地圖生成 + 出生點）
→ T=0 → 階段推進（`lib/game/season.ts` 與 `lib/server/season-ops.ts`，
排程掛在 `/api/cron/settle`）。實作記錄見 `docs/11` §20，
其中 §20.4 是一個從 M1 就存在、只有整合測試照得出來的空間缺陷：
**600 人裡有 20 位的據點核心與鄰居重疊**。

```bash
pnpm tsx scripts/generate-map.ts --seed 99991         # 地圖 + 五項公平性驗證
pnpm tsx scripts/generate-map.ts --seed 99991 --out public/terrain/s1
pnpm tsx scripts/simulate-season.ts --runs 5          # 27 項平衡驗證（含空間項）
pnpm tsx scripts/simulate-season.ts --runs 1 --trace  # 看一位玩家的完整狀態
pnpm tsx scripts/simulate-season.ts --sweep           # 網格搜尋數值組合
pnpm seed:season you@example.com                      # 開一場能真的走進去玩的賽季
pnpm seed:season --phase REGISTRATION                 # 只開登記，讓 cron 自己推進
```

模擬現在跑在**真實地圖**上：真實地形產出、地理領土上限、鄰居與掠奪、
廢土營地（PvE）、科技樹、區域容量與超限損耗、遺跡遠征的行軍限制。
世界生成約 7–20 秒，之後每場賽季約 10 秒。

**改數值之前先跑模擬。** 目前 28/33 通過，`docs/03` §6 的十二個曲線目標
只差月 9 的兵力一項。剩下的成因都寫在 `docs/11` §15.5，
其中「區域超限損兵」要等 M3b 的區域容量才驗得到。

M5b 的出生點下限讓「冬季真的餓死部隊的玩家」從 3% 掉到 2%（目標 3–45%），
六場複驗一致。成因與處置見 `docs/11` §20.5 —— **沒有為此動數值**，
冬季壓力偏弱本來就是 §15.5 的待調項之一，要跟其他三項一起處理。

設計目標是「**80% 的玩家只走得完 80% 發展度**」（`docs/11` §14）——
改任何天花板之前先看那一節，特別是「分母灌水」那個陷阱。
