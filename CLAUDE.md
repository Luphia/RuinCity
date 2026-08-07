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

pnpm check                     # typecheck + lint + unit test
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

## 目前進度

見 [`docs/10-roadmap.md`](docs/10-roadmap.md)。**M0、M1a、M1b、M2、M2b 都已完成**，
下一步是 M3（軍隊、行軍、戰鬥）。

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

```bash
pnpm tsx scripts/generate-map.ts --seed 99991         # 地圖 + 五項公平性驗證
pnpm tsx scripts/generate-map.ts --seed 99991 --out public/terrain/s1
pnpm tsx scripts/simulate-season.ts --runs 5          # 27 項平衡驗證（含空間項）
pnpm tsx scripts/simulate-season.ts --runs 1 --trace  # 看一位玩家的完整狀態
pnpm tsx scripts/simulate-season.ts --sweep           # 網格搜尋數值組合
```

模擬現在跑在**真實地圖**上：真實地形產出、地理領土上限、鄰居與掠奪、
廢土營地（PvE）、科技樹、區域容量與超限損耗、遺跡遠征的行軍限制。
世界生成約 7–20 秒，之後每場賽季約 10 秒。

**改數值之前先跑模擬。** 目前 27/31 通過，`docs/03` §6 的十二個曲線目標
只差月 9 的兵力一項。剩下四項的成因都寫在 `docs/11` §15.5，
其中「區域超限損兵」要等 M3 的聯盟協同行動才驗得到。

設計目標是「**80% 的玩家只走得完 80% 發展度**」（`docs/11` §14）——
改任何天花板之前先看那一節，特別是「分母灌水」那個陷阱。
