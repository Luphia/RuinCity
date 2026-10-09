# RuinCity · 千年之後

把地球依經緯度切成 0.01° 的區塊，用捐款請 AI 畫出每一塊在**人類離開一千年後**的樣子。從臺北 101 開始。

- 每一塊在完成前**不能進入**，只看得到：預計所需 Token、換算金額、已花費 Token、已花費金額，以及逐項列出算法的預算書
- **畫面必須擬真**：地面是紀實攝影、地圖是航測正射影像、材質是掃描貼圖
- 每一筆捐款可以投票決定由哪一家影像模型來畫（Google / OpenAI），依金額加權；每一張圖開工時才計票，所以施工途中會換模型。Claude 擔任勘查員，寫每一塊的地圖參數
- 一塊的產出：100 張標記座標場景圖、正射地圖底圖、3D 高度圖、8 張材質貼圖

完整規格：[`docs/00-design.md`](docs/00-design.md)。上線前請先看其中 **§7 風險與待決事項**。

## 開發

```bash
pnpm install
cp .env.example .env.local      # 填 DATABASE_URL、AUTH_SECRET
pnpm db:migrate
pnpm dev                        # http://localhost:5000
pnpm worker                     # 另一個終端機：施工排程（每 10 秒一輪）
```

不花錢、不連外的示範模式（三家模型與街景換成示範實作、金流按一下就當作付款成功）：

```bash
FAKE_PROVIDERS=1 PAYMENTS=demo MAP_STYLE_URL=/map-style-blank.json pnpm dev
```

```bash
pnpm check        # typecheck + lint + 單元與整合測試（PGlite，不需要資料庫）
pnpm test:e2e     # Playwright：需要 Postgres 與示範模式（見 .github/workflows/ci.yml）
pnpm build && pnpm start   # 正式模式：migration → web + worker
```
