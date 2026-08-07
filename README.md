# RuinCity（廢墟之城）

> 像素風格・手機網頁・多人即時戰爭策略遊戲
> ruincity.com

在一張 **500 × 500** 格的廢土地圖上，600 名玩家從各自的 **2×2 核心據點** 開始，
向外蠶食領土、建立軍隊、與其他玩家結盟或開戰。
地圖上散落著 **三座古老遺跡**——同時控制它們，就是這場戰爭的終局。

**一場賽季 12 天，每一天是遊戲裡的一個月。**
春天發育、夏天拆炸彈，而**用兵高峰在秋冬**——
秋天是大會戰與圍城的黃金窗口，
冬天產出腰斬、糧耗暴漲，你養不起一支不打仗的軍隊。

三座遺跡不會安靜地等你。**它們的軍團隨時間成長，
秋天開始吃你的領土，冬天每四小時就來砸你家一次。**
你在夏天沒拆掉的炸彈，冬天會自己找上門。

三大陣營各由 **5 個聯盟**組成，每盟最多 40 人。
陣營不是同盟——同陣營的 5 個聯盟彼此廝殺爭奪自家遺跡，
但誰拿到，另外 4 盟都還能分到一半的增益。
**寧願是死對頭拿到，也不要落到外族手裡。**

而每個聯盟都有一個看得見的弱點：**盟主的主旗。
被圍城兩小時，全聯盟出局。**

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
| [`docs/06-alliance.md`](docs/06-alliance.md) | 陣營／聯盟三層結構、斬首機制、HEX 代碼 |
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
| [`docs/17-ruin-legions.md`](docs/17-ruin-legions.md) | 遺跡軍團：隨時間成長、秋季擴張、冬季征伐 |

> **3 陣營 × 5 聯盟 × 40 玩家 = 600 人**（真人不足由 AI 補足）、
> 賽季 **12 天**、每 **7 天**開新的一場。

## 技術棧（摘要）

- **前端**：Next.js 15（App Router）+ React 19 + TypeScript + Tailwind CSS v4
- **地圖渲染**：PixiJS v8（WebGL，tile atlas + viewport culling）
- **後端**：Next.js Route Handlers + Server Actions
- **資料庫**：PostgreSQL（Neon）+ Drizzle ORM
- **快取／鎖**：Redis（Upstash）
- **即時推播**：SSE（戰報、聊天）
- **部署**：Vercel + Vercel Cron

詳見 [`docs/07-tech-architecture.md`](docs/07-tech-architecture.md)。
