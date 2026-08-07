# RuinCity（廢墟之城）

> 像素風格・手機網頁・多人即時戰爭策略遊戲
> ruincity.com

在一張 **500 × 500** 格的廢土地圖上，600 名玩家從各自的 **2×2 核心據點** 開始，
向外蠶食領土、建立軍隊、與其他玩家結盟或開戰。
地圖上散落著 **三座古老遺跡**——同時控制它們，就是這場戰爭的終局。

**一場賽季 12 天，每一天是遊戲裡的一個月。**
春天發育、夏天開戰、秋天是遠征的唯一窗口，
而冬天產出腰斬、糧耗暴漲、前線補給縮水四成——
遠征軍撤回或餓死，戰爭收縮到每個人的家門口。
問題不再是「我能打下哪裡」，是「我撐不撐得到第 12 天」。

沒有新手保護期。限制來自世界如何運作：
**你能在一個地方投入多少兵力，取決於你在那裡有多少基礎建設。**

事先登記、全員同時開賽、每 7 天開新的一場。
你的核心只有 4 格、建造佇列永遠只有 1 條，
想要的永遠比負擔得起的多——**選擇本身就是玩法**。

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
| [`docs/04-military-combat.md`](docs/04-military-combat.md) | 兵種、行軍、戰鬥公式、掠奪、士氣與防守優勢 |
| [`docs/05-ruins-season.md`](docs/05-ruins-season.md) | 三座遺跡、佔領機制、賽季勝利與傳承 |
| [`docs/06-alliance.md`](docs/06-alliance.md) | 聯盟系統（v1 範圍與 v2 規劃） |
| [`docs/07-tech-architecture.md`](docs/07-tech-architecture.md) | Next.js / React 架構、結算引擎、反作弊 |
| [`docs/08-data-model.md`](docs/08-data-model.md) | 資料表設計與關鍵索引 |
| [`docs/09-art-ux.md`](docs/09-art-ux.md) | 像素美術規範、手機 UI/UX、操作設計 |
| [`docs/10-roadmap.md`](docs/10-roadmap.md) | 開發里程碑 M0–M7 |
| [`docs/11-balance-tables.md`](docs/11-balance-tables.md) | 數值表（建築、兵種、成本、時間） |
| [`docs/12-open-questions.md`](docs/12-open-questions.md) | 待決議事項與已定案紀錄 |
| [`docs/13-season-registration.md`](docs/13-season-registration.md) | 賽季登記制、三分天下陣營、出生點批次分配與公平性驗證 |
| [`docs/14-time-and-cadence.md`](docs/14-time-and-cadence.md) | 12 天賽季、遊戲曆法、四季效應、7 天輪替、時間係數 |
| [`docs/15-ai-players.md`](docs/15-ai-players.md) | AI 玩家：補足 600 人、三種性格、固定腳本曲線、離線託管 |
| [`docs/16-supply-and-attrition.md`](docs/16-supply-and-attrition.md) | 補給線、區域軍隊容量、城池防禦——取代新手保護期的有機限制 |

## 技術棧（摘要）

- **前端**：Next.js 15（App Router）+ React 19 + TypeScript + Tailwind CSS v4
- **地圖渲染**：PixiJS v8（WebGL，tile atlas + viewport culling）
- **後端**：Next.js Route Handlers + Server Actions
- **資料庫**：PostgreSQL（Neon）+ Drizzle ORM
- **快取／鎖**：Redis（Upstash）
- **即時推播**：SSE（戰報、聊天）
- **部署**：Vercel + Vercel Cron

詳見 [`docs/07-tech-architecture.md`](docs/07-tech-architecture.md)。
