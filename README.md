# RuinCity · 千年之後

把地球依經緯度切成 0.01° 的區塊，用捐款請 AI 畫出每一塊在**人類離開一千年後**的樣子。從臺北 101 開始。

- 每一塊在完成前**不能進入**，只看得到：預計所需 Token、換算金額、已花費 Token、已花費金額，以及逐項列出算法的預算書
- **畫面必須擬真**：地面是紀實攝影、地圖是航測正射影像、材質是掃描貼圖
- 每一筆捐款可以投票決定由哪一家影像模型來畫（Google / OpenAI），依金額加權；每一張圖開工時才計票，所以施工途中會換模型。Claude 擔任勘查員，寫每一塊的地圖參數
- 一塊的產出：100 張標記座標場景圖、正射地圖底圖、3D 高度圖、8 張材質貼圖
- **永久保存**：完成的塊打包成一個 IPFS 資料夾（圖、座標、渲染規格與無相依的檢視器），由 [Boltchain](https://github.com/Luphia/Boltchain) SwarmStorage 付費委託多個節點保存四年、每個 epoch 抽查。任何人拿到它都能重建一模一樣的場景，不需要這個網站

完整規格：[`docs/00-design.md`](docs/00-design.md)。上線前請先看其中 **§7 風險與待決事項**。

## 開發

```bash
pnpm install
pnpm run initial                # 產生 .env.local（AUTH_SECRET、CRON_SECRET 隨機產生）並建立本機 SQLite 資料庫；--demo 打開示範模式
                                # （忘了跑也沒關係：pnpm dev／pnpm start 發現密鑰缺了會自動隨機產生）
pnpm dev                        # http://localhost:5000
pnpm worker                     # 另一個終端機：施工排程（每 10 秒一輪）
```

不花錢、不連外的示範模式（三家模型與街景換成示範實作、金流按一下就當作付款成功）：

```bash
FAKE_PROVIDERS=1 PAYMENTS=demo MAP_STYLE_URL=/map-style-blank.json pnpm dev
```

```bash
pnpm check        # typecheck + lint + 單元與整合測試（整合測試用暫存的 SQLite 檔）
pnpm test:e2e     # Playwright：示範模式（見 .github/workflows/ci.yml）
pnpm splash:paint                                               # 畫開場圖：從象山俯視荒廢的 101（需要影像模型金鑰）
pnpm scene:verify scene.car --extract ./scene                    # 驗證並解出一塊的場景包
pnpm scene:verify --gateway http://<boltchain 閘道> <委託索引 CID>  # 直接從 Boltchain 取回
pnpm build && pnpm start   # 正式模式：migration → web + worker
```
