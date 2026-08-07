# /scripts

| 檔案 | 用途 | 里程碑 |
| --- | --- | --- |
| `generate-map.ts` | 由 seed 生成地形、放置遺跡、切 chunk、批次分配出生點 | M1 |
| `simulate-season.ts` | 無 UI 跑完整 12 天賽季，驗證八組平衡檢查清單 | M0 起逐步擴充 |
| `seed-season.ts` | 一行指令開一場能真的走進去玩的賽季（建立 → AI 補足 → 封盤 → T=0） | M5b |

```bash
pnpm tsx scripts/seed-season.ts --me you@example.com   # 立刻開賽，並把自己放進去
pnpm tsx scripts/seed-season.ts --phase REGISTRATION   # 只開登記，讓 cron 自己推進
pnpm tsx scripts/seed-season.ts --seed 99991 --band FRONTIER
```

`seed-season.ts` 把登記開放時間往回推，讓 `advanceSeasons` 認為現在就該開賽 ——
走的是**完全相同**的 `lockdownSeason` / `startSeason` 路徑，沒有開發用捷徑。

12 天的賽季讓模擬成本降到原設計（48 天）的四分之一，
而每 7 天輪替一場代表**真實世界的迭代週期也只有 12–14 天** ——
模擬與實測可以緊密接在一起。
