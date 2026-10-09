/**
 * 世界觀（World Bible）。每一次繪製都會把它放在提示詞最前面。
 *
 * ## ★ 為什麼要有一份「正典」
 *
 * 地圖是幾千次繪製拼起來的，而每一次可能出自不同的模型（捐款人投票決定）。
 * 沒有共同的設定，相鄰兩塊會一塊是熱帶雨林、一塊是沙漠廢土；
 * 臺北 101 在這張圖上斷成兩截，在隔壁那張圖上還完好如初。
 * 正典不能保證每一家模型畫得一樣，但能保證它們**被要求畫同一件事**。
 *
 * 寫成英文：三家影像模型對英文提示的遵從度都明顯較好。
 * 中文摘要給人看（顯示在網站上）。
 *
 * ★ 改正典要 bump `BIBLE_VERSION`。每一個施工步驟都記下它用的版本，
 *   所以「這張圖為什麼和隔壁不一樣」永遠查得到答案。
 */

export const BIBLE_VERSION = "1";

export const BIBLE_SUMMARY_ZH = [
  "人類在一千年前離開了，原因不明。沒有人回來過。",
  "植物收復了一切：榕樹的氣根絞碎混凝土，蕨類與藤蔓蓋滿每一面牆。",
  "高樓只剩被掏空的骨架，玻璃早已不存在，鋼筋鏽成紅褐色的痕跡。",
  "道路變成林間的直線空地或溪流；橋只剩橋墩。低地被水淹沒成沼澤與湖。",
  "畫面裡沒有人、沒有文字、沒有完好的車輛或任何仍在運作的東西。",
  "臺北 101 仍然站著，但上段已經坍塌，只剩巨柱與核心筒，基座被森林吞沒。",
] as const;

/** 所有繪製共用的正典（英文） */
export const BIBLE_CANON = `WORLD CANON — "One Thousand Years After"
Humanity vanished exactly 1,000 years ago, for reasons no one knows. Nobody ever came back.
Nature has fully reclaimed the place:
- Vegetation appropriate to the local climate covers almost everything. In humid subtropical places (like Taipei): banyan trees whose aerial roots split concrete, tree ferns, bamboo, vines and moss.
- Reinforced-concrete buildings have mostly collapsed into overgrown mounds of rubble. The tallest towers survive only as hollow, broken skeletons. No glass remains anywhere. Steel has rusted away to reddish-brown stains.
- Asphalt roads have become straight clearings or shallow streams lined with trees. Bridges are gone except for their piers. Low-lying ground near rivers has flooded into marshes and lakes; sea level is somewhat higher.
- Wildlife is present but unobtrusive (birds, egrets, deer, macaques).
Strict rules:
- No people, no human figures, no text, letters, logos, signs or watermarks.
- No intact vehicles and nothing that still works: no lights, no power, no smoke from chimneys.
- The geography must stay recognizable: the same rivers, coastlines, hills and street grid, now overgrown.`;

/** 只給看得到 101 的那些地方（見 `prompts.ts` 的距離門檻） */
export const BIBLE_TAIPEI_101 = `LANDMARK CANON — Taipei 101: it still stands, but its upper third has collapsed. What remains is the concrete core and the eight mega-columns, stripped of glass and cladding, with the "pagoda" segments broken open. The base is swallowed by forest. If it is visible from this place, draw it this way.`;
