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

export const BIBLE_VERSION = "2";

export const BIBLE_SUMMARY_ZH = [
  "人類在一千年前離開了，原因不明。沒有人回來過。",
  "植物收復了一切：榕樹的氣根絞碎混凝土，蕨類與藤蔓蓋滿每一面牆，街道長成草原與幼林。",
  "大樓多半還站著，只剩風化的混凝土外殼：沒有一片玻璃，窗口全是黑洞，外牆爬滿植物；矮房子大多已經塌成長滿樹的土丘。",
  "天際線因此還認得出來。積水在低處成了水塘與沼澤，野生動物在原本的馬路上走動。",
  "畫面裡沒有人、沒有可讀的文字、沒有任何仍在運作的東西。",
  "臺北 101 仍然站著，玻璃帷幕全部脫落，露出巨柱與核心筒，頂端的塔尖已經斷落，基座被森林吞沒。",
  "★ 畫面必須擬真：看起來要像在現場拍的照片，不是插畫、不是繪畫、不是遊戲畫面。",
] as const;

/** 所有繪製共用的正典（英文） */
export const BIBLE_CANON = `WORLD CANON — "One Thousand Years After"
Humanity vanished exactly 1,000 years ago, for reasons no one knows. Nobody ever came back.
Nature has reclaimed the place, but the bones of the city are still there:
- Vegetation appropriate to the local climate covers almost everything. In humid subtropical places (like Taipei): banyan trees whose aerial roots grip and split concrete, tree ferns, bamboo, vines and moss. Streets and plazas have become tall-grass meadows and young forest.
- Large reinforced-concrete buildings mostly still stand as weathered shells: every window is an empty dark opening, no glass remains anywhere, facades are stained dark grey and rust-brown, streaked by a millennium of rain, with plants growing out of ledges and broken floors. Some have partly collapsed. Small and low buildings have mostly fallen into tree-covered mounds of rubble. The skyline must stay recognisable.
- Steel has rusted to brittle brown stains. Roads are cracked, buried under soil, grass and saplings. Rainwater pools in low ground; low-lying land near rivers has become marsh and shallow lakes; sea level is somewhat higher. Bridges survive only as piers or broken spans.
- Wildlife lives here and is shown naturally and to scale: birds, egrets, deer, macaques, boar; large grazing animals are possible.
Strict rules:
- No people, no human figures, no legible text, letters, logos, signs or watermarks.
- No intact vehicles and nothing that still works: no lights, no power, no smoke from chimneys.
- The geography must stay recognisable: the same rivers, coastlines, hills and street grid, now overgrown.`;

/**
 * ★ 擬真的風格規格。
 *
 * 「Photorealistic」一個字不夠：模型對它的理解從照片一路滑到「很精緻的概念圖」。
 * 所以這裡寫的是**相機與光線**（照片才有、插畫沒有的東西），
 * 再明確列出不要的那些樣子。三種產出各有一份，因為它們是三種不同的照片：
 * 地面上的紀實攝影、航測正射影像、掃描材質。
 */
export const STYLE_PHOTO = `VISUAL STYLE — this must be indistinguishable from a real, unedited photograph taken on location. Physically plausible light, scale, materials and weathering; real optical behaviour (natural depth of field, atmospheric haze over distance, true-to-life colour).`;

export const STYLE_SCENE = `CAMERA — documentary photograph from a full-frame camera with a 24–35 mm lens at human eye height, level horizon, natural perspective. Soft natural daylight, typically an overcast or hazy sky, with gentle shadows; humid air with light haze softening distant towers. Muted, natural colours: deep and varied greens, wet grey concrete, rust-brown stains. Fine real detail: individual leaves and blades of grass, water reflections, moss, cracks, stains.`;

export const STYLE_TILE = `CAMERA — a true orthophoto from an aerial survey camera, about 0.5 m per pixel: straight down, north up, no perspective tilt, uniform midday illumination, no clouds and no cloud shadows, no map symbols, labels, lines or overlays. It must look exactly like real satellite or aerial imagery of a wild, overgrown landscape.`;

export const STYLE_TEXTURE = `CAMERA — a photogrammetry-scanned PBR albedo texture of a real surface, about 2 m × 2 m, photographed straight down under flat diffuse light: no cast shadows, no specular highlights, no vignette, no lens distortion. Real material detail at true scale.`;

export const STYLE_NEGATIVE = `AVOID — painting, illustration, digital art, concept art, matte painting, anime, cartoon, video-game or 3D-render look, stylised or fantasy elements, oversaturated or HDR colours, glowing light, dramatic god rays, lens flares, vignettes, frames, text or watermarks.`;

/** 只給看得到 101 的那些地方（見 `prompts.ts` 的距離門檻） */
export const BIBLE_TAIPEI_101 = `LANDMARK CANON — Taipei 101: it still stands at full height except for its spire, which has fallen. All glass curtain walls are gone, exposing the eight mega-columns, the concrete core and the stacked "pagoda" segments as a dark weathered frame, with vines and small trees growing on its setbacks. The base is swallowed by forest. If it is visible from this place, show it this way.`;
