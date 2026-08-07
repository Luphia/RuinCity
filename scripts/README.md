# /scripts

| 檔案 | 用途 | 里程碑 |
| --- | --- | --- |
| `generate-map.ts` | 由 seed 生成地形、放置遺跡、切 chunk、批次分配出生點 | M1 |
| `simulate-season.ts` | 無 UI 跑完整 12 天賽季，驗證八組平衡檢查清單 | M0 起逐步擴充 |
| `seed-season.ts` | 一行指令開一場能真的走進去玩的賽季（建立 → AI 補足 → 封盤 → T=0） | M5b |
| `migrate.ts` | `pnpm db:migrate`。取代 `drizzle-kit migrate`，因為**它把錯誤吞掉了** | M5b |

```bash
pnpm seed:season you@example.com                       # 立刻開賽，並把自己放進去
pnpm seed:season --phase REGISTRATION                  # 只開登記，讓 cron 自己推進
pnpm seed:season --me you@example.com --band FRONTIER
```

`drizzle-kit migrate` 失敗時只會印 `[⣷] applying migrations...` 然後 exit 1 ——
連不上、密碼錯、SQL 撞到既有物件全都長一樣。`scripts/migrate.ts` 用
`drizzle-orm` 的 migrator 做同一件事（同一個 `drizzle/` 資料夾、
同一張紀錄表，與 `drizzle-kit generate` 完全相容），但錯誤照實印出來。

★ 走 `pnpm seed:season`，不要 `pnpm tsx scripts/seed-season.ts` ——
這支腳本會 import `lib/server/*`，而那裡的 `import "server-only"`
是 Next.js 的建置期哨兵，在 Node 底下解不開（Next 是用內建 alias 解掉的）。
`seed:season` 帶了 `--tsconfig tsconfig.scripts.json` 把它指到替身，
並且會讀 `.env.local`（tsx 不像 `next dev` 會自動讀）。

`seed-season.ts` 把登記開放時間往回推，讓 `advanceSeasons` 認為現在就該開賽 ——
走的是**完全相同**的 `lockdownSeason` / `startSeason` 路徑，沒有開發用捷徑。

12 天的賽季讓模擬成本降到原設計（48 天）的四分之一，
而每 7 天輪替一場代表**真實世界的迭代週期也只有 12–14 天** ——
模擬與實測可以緊密接在一起。
