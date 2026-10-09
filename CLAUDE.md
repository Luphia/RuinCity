# RuinCity · 千年之後 —— 給協作者（含 AI）的說明

## 這是什麼

把地球依經緯度切成 0.01° × 0.01° 的區塊，用**捐款**請 AI 畫出每一塊在人類離開一千年後的樣子。
從臺北 101（`25.03_121.56`）開始。每一塊完成前不能進入；捐款人依金額加權投票決定由哪一家模型來畫。

**先讀 [`docs/00-design.md`](docs/00-design.md)。** 那是規格，程式碼與它不一致時以它為準。
上線前必須處理的事在 §7（Google Maps 條款、金流商、稅務名目、價格查核）。

> 這個 repo 曾經是一個戰爭策略遊戲（v0.1.0，在 `main` 上）。2026-10 清空重新設計，
> 只保留登入、資料庫連線、建置與測試的基礎設施。

## 開發

```bash
pnpm install
cp .env.example .env.local     # 填入 DATABASE_URL 與 AUTH_SECRET
pnpm db:migrate
pnpm dev                       # http://localhost:5000（不是 Next 預設的 3000）
pnpm worker                    # 施工排程：每 10 秒打一次 /api/cron/build
pnpm build && pnpm start       # 正式模式：migration → web + worker

pnpm check                     # typecheck + lint + 單元測試 + 整合測試（PGlite）
pnpm test:e2e                  # Playwright（需要 build、Postgres、示範模式）
pnpm db:generate               # 改完 schema.ts 一定要跑，CI 會檢查是否同步
```

示範模式（不花錢、不連外，帳照真的算）：`FAKE_PROVIDERS=1 PAYMENTS=demo MAP_STYLE_URL=/map-style-blank.json`。
沙箱環境的 Chromium 版本可能與 Playwright 的 pin 對不上，設定 `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium`。

## 三條不能違反的界線

**1. `/lib/world` 不得有任何 I/O。**
網格、價格、施工計畫、投票、帳、預算書、提示詞全部是純函式，時間由參數傳入。
捐款人看到的每一個數字都從這裡算出來 —— 它必須能被單元測試完整覆蓋。

**2. 價格與預算參數只寫在一個地方。**
模型費率與型號在 `lib/world/pricing.ts`（改了要 bump `PRICING_VERSION`）；
預算參數的預設值與理由在 `lib/world/budget.ts`，環境變數覆寫在 `lib/server/config.ts`。

**3. 帳是真相，狀態由帳推導。**
區塊狀態（募款中／建設中／已完成）不存欄位，由 `lib/server/blocks.ts` 的 `deriveState` 推導；
只有 `completed_at` 與 `paused_at` 是存下來的事件。**頁面與施工引擎讀的是同一份推導** ——
兩份會分岔成「頁面說建設中、其實在等錢」。

## 容易踩到的地方

| 事情 | 注意 |
| --- | --- |
| 金額 | 一律**微美元整數**（1 USD = 1,000,000）。新台幣只存捐款人付的整數金額與當時的匯率快照 |
| 經緯度與浮點 | `25.03 * 100` 是 `2502.9999…`。比較一律在整數列/欄上做（`grid.ts` 的 `blockOf`），西南角剛好在格線上時才不會被分到隔壁 |
| 完成前不能進入 | 守在**出圖的 API**（`lib/server/artifacts.ts`，未完成回 403），不是只靠頁面不顯示 —— 圖的網址猜得到 |
| 入帳 | 只認金流商 webhook（驗簽後），而且**冪等**。瀏覽器導回頁可以偽造 |
| 投票 | 一筆捐款一張票，權重 = 那一筆的總額。**每一張圖開工時計票**（`vote.pickFor`），所以會換模型。只有 `PAINTERS`（擬真影像模型）能被投；「地圖參數」不投票，歸勘查員（`SURVEYORS` 第一個啟用的，都沒有就用預設參數） |
| 擬真 | 畫面必須擬真。風格規格寫在 `bible.ts` 的 `STYLE_*`（相機、光線、不要的畫風），每一種出圖都要帶。改正典或風格要 bump `BIBLE_VERSION`。**不要**把使用者給的參考截圖存起來或送給模型 —— 把它的特質寫成文字 |
| 預算書 | 各行加總 = 換算金額；**結餘不算進換算金額**（否則捐得愈多「所需」愈高）。預備金只對還沒做的步驟提列 |
| 失敗也要記帳 | 被擋、沒回圖的那一次上游照樣收費。`PainterError` 帶著 usage，`steps` 記一列 FAILED |
| 施工租約 | 一步要呼叫外部 API 幾十秒，**不抱交易鎖**，用 `blocks.lease_until`。`steps` 的部分唯一索引保證同一步只能成功一次 |
| Claude | 勘查員，**只寫地圖參數、不出圖**（不輸出點陣圖，畫不出照片）。開啟 `fallbacks: "default"`，帳記在 `response.model` |
| Google Maps | 只存全景 ID，**不存街景與衛星影像**（條款只允許保存 pano ID）。版型參考是 `maptype=satellite`。條款風險見 design §7 #1 |
| 捐款留言 | 不受信任的輸入。只能經由 `prompts.wishesText` 進提示詞（截斷、去控制字元、標成建議） |
| `server-only` | `lib/server`、`lib/providers` 的伺服器模組 import 了它。Node 腳本 import 會直接丟錯 —— 所以 `pnpm worker` 是打 HTTP 路由，不是直接 import 施工引擎 |
| MapLibre | 它的 CSS 把容器設成 `position: relative`，蓋掉 class 上的 `absolute` → 畫布縮成 300px 高。容器尺寸用 inline style |
| 底圖 | `MAP_STYLE_URL` 在伺服器端讀、當 prop 傳下去（不用 `NEXT_PUBLIC_`，否則 build 時寫死）。載不到時自動退回純色底 |
| Neon driver | `neon-http` **不支援交易**，寫入一律走 `lib/db/tx.ts` 的 `withTransaction`。本機 Postgres 由 `lib/db/driver.ts` 依 host 改用 node-postgres |
| 腳本的環境變數 | `scripts/*.ts` 的**第一個 import** 必須是 `./load-env` |
| React Compiler | render 中不可呼叫 `Date.now()` 等不純函式；effect 本體裡不要同步 `setState` |
| 失敗要看得見 | 每一個 fetch 都要有 catch，而 catch 裡要有 UI。只 `console.error` 不算 |
| 埠 | 預設 5000（`pnpm dev`／`pnpm start`／`AUTH_URL` 要一致）。E2E 用 3100 |
| 本機登入 | 沒設 `EMAIL_SERVER` 時，開發模式會把 magic link 印在終端機上。E2E 直接在資料庫建 session |

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
