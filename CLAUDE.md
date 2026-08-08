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
pnpm worker                    # 本機的結算迴圈（執政官、行軍、賽季推進）。
                               # production 由 Vercel Cron 扮演這個角色；
                               # 本機不開它的話，只剩打開頁面那一刻的惰性結算
pnpm build && pnpm start       # 自架/本機的正式模式:先跑 migration 初始化,
                               # 再同時啟動 web + worker（任一個死掉就整組收掉）。
                               # 沒設 DATABASE_URL 時只跑 web 並講出來

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
| Neon driver | `neon-http` **不支援交易**，寫入路徑一律走 `lib/db/tx.ts` 的 `withTransaction` |
| 本機 Postgres | `@neondatabase/serverless` 只對 Neon 端點說話，指向本機的 Postgres 會連不上（而且錯誤看起來像網路問題）。`lib/db/driver.ts` 依 URL 的 host 自動改用 node-postgres —— 兩邊都支援交易，`withTransaction` 的保證不變 |
| 腳本的環境變數 | `scripts/*.ts` 的**第一個 import** 必須是 `./load-env`。import 會先於任何語句求值，所以「先呼叫 dotenv 再 import lib/db」是錯的 —— `lib/db` 會拿到 placeholder，然後在第一次查詢時炸成 `ENOTFOUND unset.invalid` |
| 賽季輪替 | `ensureNextSeason` 的判準是**上一場的 `nextOpensAt`**，不是「現在有沒有人在收登記」。登記第 3 天就截止、下一場第 7 天才開，中間四天的空窗是刻意的 |
| 時間係數 | 數值表的時間是「48 天賽季」基準，實際值要 ÷ `TIME_SCALE`(4)；速率 × 4；單位速度 × `MARCH_SCALE`(3.6 = 賽季壓縮 2 × 地圖 900×900 的 1.8)。成本與戰鬥數值不套用任何係數 |
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
| 出局 | **打爆主城 = 那位領主出局**（`players.eliminated_at`，原因寫在 `exit_reason`；自願放棄走同一條路），整季不再回來：領地釋放、駐軍清空、在途行軍取消、**未結算事件刪除**（不刪的話 cron 每分鐘記一筆看不出原因的 failure）。守門在 `settleWithin`，`defenderAt` 也要濾掉 —— 否則可以對著廢墟刷戰報 |
| 交戰 | 行軍抵達不是「當場算完」，是**進場**：一格上開一場交戰，兩分鐘後 cron 一起結算（`docs/04` §3d）。容量 5 對 5，主城 10 對 10，**守方駐軍佔掉守方的一席**（豁免它就變成 5 對 6）。中立地的攻方名額對所有人開放，存活最多的拿走那塊地。`RAID` 是例外，仍然抵達即結算 |
| 交戰的順序 | cron 一定要**先 `resolveArrivals` 再 `resolveEngagements`** —— 這一分鐘抵達的援軍必須趕得上這一分鐘結束的仗。反過來的症狀是「明明到了卻沒參戰」 |
| 交戰的畫面 | 進行中的動畫 `losses` 是**空的**（死亡配額 0，沒有人倒下）。戰報還不存在，畫面就沒有資格讓任何人倒下 —— 提前演等於第二個戰鬥引擎 |
| 十分鐘窗口 | 建物耐久十分鐘**線性回滿**（按滿血比例，不是固定速率）→ 攻城是一次攻勢，不是跨天消耗；傷兵十分鐘歸隊，**條件是站在自己的據點或要塞**，陣亡的永遠回不來 |
| 領地建物 | 每格中央有旗（300）／要塞石塔（600+600×Lv）／主城（400×Lv）。**打掉即佔領**（主城除外）。順序不能顛倒：守軍還有活口就碰不到建物。一般部隊對建物 **1 點／人**，只有 RAM(40)、CATAPULT(60) 算攻城 —— 這條規則是要塞存在的全部理由。見 `docs/02` §2.6 |
| 要塞路網 | 起訖**都**在自己的路網上 → 速度 ×4。節點 = 主城周圍 8 格（＝`PLAYER_MIN_SPACING`，那一圈保證只有你）+ 每座要塞那一格。只要一端在網上就加速的話那不是驛道，是全域加速 |
| 野地等級 | 無主格的等級（1–5）由 `wildLevelAt(seed,x,y,terrain)` 決定性推導，**不入庫**；佔領時抄進 `tiles.level`（與 terrain 同模式）。lv≥2 有野生守衛：立旗回 `GUARDED_TILE`，要走 CLAIM 行軍（PvE、`skipMorale`）。執政官的候選清單已濾掉有守衛的格子 —— 不濾它會永遠嘗試一件做不到的事 |
| 出生間距 | **全服任兩位領主 ≥ 8 格**（切比雪夫，`PLAYER_MIN_SPACING`），真人與 AI 一視同仁；小隊成員彼此豁免（自願聚落）。這是 900×900 換來的 —— 500 地圖塞不下（`docs/11` §22.1、§23.2 的算術）|
| 出生點 | 兩點之間的切比雪夫距離**至少 2**（`HARD_MIN_SPACING`）—— 核心是 2×2，差一格就會疊到同一格 `tiles`。`poissonPick` 會被呼叫很多次，硬性下限只有靠那份跨呼叫的 blocker 才守得住 |
| 沒接上的係數 | 數值表有一個係數、函式簽章有對應參數、而預設值剛好是「沒有效果」—— 這種組合會安靜地失效。加參數的同時就要把呼叫端全部接好（例：`territoryCapacity` 的 `bandBonus`，M0 寫下、M5b 才真的生效） |
| 地圖是哪一場 | `/api/map/overview` 的判準是**觀看者在哪一場**（`pickMapSeason`），不是「最新的一場」。下一場第 7 天就開登記，而登記中的賽季**沒有地形檔** —— 取最新的話，每一場走到第 7 天，所有人的地圖會同時換成 `s0`（沒有 `s0` 的部署直接 404 →「地圖載入失敗」）|
| 放棄賽季 | 玩家隨時可以退出目前這一場、立刻報名另一場（`docs/13` §8）。拆除與**主城被打爆共用一份實作**（`lib/server/leave-season.ts`），差別只有 `players.exit_reason`。三個易漏：登記列**只標記 `withdrawn_at` 不刪**、「還在別場嗎」與封盤分配都要濾掉它、退出登記期的賽季後要能**復用那一列**再報名 |
| 賽季階段 | 由時間戳推導（`phaseAt`），`seasons.status` 只是那個推導的快取。要判斷「現在是哪個階段」一律問 `phaseOf(season, now)`，不要讀欄位。而整條時間軸**只由 `registrationOpensAt` 推出來**（`scheduleOf`）—— 想改變階段就改那個時間戳，只 UPDATE `status` 會被下一次 `advanceSeasons` 推回去（`pnpm end:season` 就是這樣做的）|
| 失敗要看得見 | 每一個 `void (async () => {})()` 都要有 catch，而 catch 裡要有 UI。只 `console.error` 不算 —— 使用者看不到 console。這個毛病在 M5b 出現三次（登入失敗、地圖場景、賽季狀態），症狀都是「按了沒反應」 |
| useEffect 依賴 | 會高頻重繪的元件之間，props 依賴一律用**基本型別**（`focus?.x`），不要用物件 —— 每次 render 的新物件字面量會讓 effect 每次都重跑。症狀跟成因看起來毫無關係（「地圖自己跳回出生點」vs「stats 的計時器」），見 `docs/11` §20.23 |
| 地圖 | `/api/map/overview` 依資料庫解析「現在是哪一場」。地形的**真相在 `terrain_files` 表**（封盤時與 SEALED 同交易入庫）—— 磁碟只是快取，會跟著容器蒸發。啟動時 `ensureLatestTerrain`（`instrumentation.ts` 與 `pnpm worker`）補磁碟、缺庫就以 seed 重新生成；磁碟沒有時 chunk 走 `/api/terrain`。退回 `s0` 開發地圖時 `isFallback` 會是 true，畫面要講出來 |
| 本機登入 | 沒設 `EMAIL_SERVER` 時，開發模式會把 magic link 印在終端機上（`usesDevMailbox()`）。token 仍是 Auth.js 發的、只能用一次、會過期 —— 換掉的只有投遞管道。production 一律關閉 |

## 目前進度

見 [`docs/10-roadmap.md`](docs/10-roadmap.md)。**M0、M1a、M1b、M2、M2b、M3、M5b、M5c 都已完成**，
下一步是 M3b（區域容量與超限損耗）與 M4（聯盟）。
M5c 是對照同類作品的介面修正（常駐 HUD、狀態疊在場景上、地圖個人圖層），
取捨記錄在 `docs/09` §12 —— 特別是**不採用**任務鏈的理由。

**現在可以真的玩了。** 玩家的正式路徑是 **web 介面**：`/seasons` 登記、
封盤後進 `/base`；不想玩了就在 `/seasons` 放棄，然後立刻報名另一場（`docs/13` §8）。

`pnpm seed:season you@example.com` 是**開發工具**，不是玩家路徑 ——
它會開一場賽季、AI 補足到 600、跑封盤、在 T=0 寫入所有人的初始狀態，
方便本機一秒進到「可以打」的狀態。不要拿它當作「幫某個人加入賽季」的手段：
那個人已經在別場的話它只會失敗，並留下一場半開的賽季。

戰鬥引擎、行軍、賽季模擬都已完成，數值表也依模擬結果重新配平過四輪
（`BALANCE_VERSION` = `2026.08.08-a`，理由見
[`docs/11`](docs/11-balance-tables.md) §12–§15、§22）。
野地征服（等級、守衛、CLAIM 行軍、產出加成）見 `docs/02` §2.5 ——
模擬尚未建模 lv≥2 的征服經濟，缺口記在 `docs/11` §22.5。

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
pnpm end:season --dry                                 # 強制結束：先看會發生什麼
pnpm end:season                                       # → ENDING（凍結）
pnpm end:season --archive --next                      # → ARCHIVED，並開下一場登記
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
