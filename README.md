# RuinCity（廢墟之城）

> 像素風格・手機網頁・多人即時戰爭策略遊戲
> ruincity.com

在一張 **500 × 500** 格的廢土地圖上，每位玩家從一座 **2×2 的核心據點** 開始，
向外蠶食領土、建立軍隊、與其他玩家結盟或開戰。
地圖上散落著 **三座古老遺跡**——同時控制它們，就是這個賽季的終局。

---

## 專案狀態

| 項目 | 狀態 |
| --- | --- |
| 遊戲企劃 | ✅ 已完成（見 `docs/`） |
| 技術選型 | ✅ 已確認 |
| 專案骨架 | ⬜ 未開始 |
| M1 地圖渲染 | ⬜ 未開始 |

## 企劃文件索引

| 文件 | 內容 |
| --- | --- |
| [`docs/00-overview.md`](docs/00-overview.md) | 遊戲總覽、核心體驗、設計原則、核心循環 |
| [`docs/01-world-map.md`](docs/01-world-map.md) | 500×500 世界、地形、出生點、地圖生成 |
| [`docs/02-base-territory.md`](docs/02-base-territory.md) | 2×2 核心據點、建築、領土佔領與連通性 |
| [`docs/03-economy.md`](docs/03-economy.md) | 五種資源、產出與消耗、倉庫與掠奪保護 |
| [`docs/04-military-combat.md`](docs/04-military-combat.md) | 兵種、行軍、戰鬥公式、掠奪、新手保護 |
| [`docs/05-ruins-season.md`](docs/05-ruins-season.md) | 三座遺跡、佔領機制、賽季勝利與傳承 |
| [`docs/06-alliance.md`](docs/06-alliance.md) | 聯盟系統（v1 範圍與 v2 規劃） |
| [`docs/07-tech-architecture.md`](docs/07-tech-architecture.md) | Next.js / React 架構、結算引擎、反作弊 |
| [`docs/08-data-model.md`](docs/08-data-model.md) | 資料表設計與關鍵索引 |
| [`docs/09-art-ux.md`](docs/09-art-ux.md) | 像素美術規範、手機 UI/UX、操作設計 |
| [`docs/10-roadmap.md`](docs/10-roadmap.md) | 開發里程碑 M0–M7 |
| [`docs/11-balance-tables.md`](docs/11-balance-tables.md) | 數值表（建築、兵種、成本、時間） |
| [`docs/12-open-questions.md`](docs/12-open-questions.md) | 待決議事項與已定案紀錄 |

## 技術棧（摘要）

- **前端**：Next.js 15（App Router）+ React 19 + TypeScript + Tailwind CSS v4
- **地圖渲染**：PixiJS v8（WebGL，tile atlas + viewport culling）
- **後端**：Next.js Route Handlers + Server Actions
- **資料庫**：PostgreSQL（Neon）+ Drizzle ORM
- **快取／鎖**：Redis（Upstash）
- **即時推播**：SSE（戰報、聊天）
- **部署**：Vercel + Vercel Cron

詳見 [`docs/07-tech-architecture.md`](docs/07-tech-architecture.md)。
