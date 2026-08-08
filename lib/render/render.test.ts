import { describe, expect, it } from "vitest";

import { MAP, TERRAINS } from "../game/balance";
import { TERRAIN_CODE } from "../game/map/terrain";
import {
  CHUNK_COUNT,
  CHUNK_SIZE,
  chunkOfTile,
  chunkToRGBA,
  sortByDistanceToCenter,
  territoryToRGBA,
  visibleChunks,
} from "./chunks";
import { ALLIANCE_COLORS, TERRAIN_COLOR, allianceColor, rgb, toCss } from "./palette";
import {
  MAX_TILE_PX,
  MIN_TILE_PX,
  ZOOM_LEVELS,
  centerOn,
  clampViewport,
  panBy,
  screenToWorld,
  snapTilePixels,
  stepZoom,
  visibleTiles,
  worldToScreen,
  zoomAt,
  zoomSpecFor,
  type Viewport,
} from "./viewport";

/** 一支典型的手機（iPhone 14 的 CSS 像素） */
const phone = (over: Partial<Viewport> = {}): Viewport => ({
  centerX: MAP.width / 2,
  centerY: MAP.height / 2,
  tilePixels: 8,
  screenWidth: 390,
  screenHeight: 844,
  ...over,
});

describe("調色盤", () => {
  it("每個地形都有兩個明度，且互不相同", () => {
    for (const t of TERRAINS) {
      const [a, b] = TERRAIN_COLOR[t];
      expect(a).not.toBe(b);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(0xffffff);
    }
  });

  it("三陣營各 5 色，全 15 色互不重複（docs/09 §3）", () => {
    const all = [1, 2, 3].flatMap((f) => ALLIANCE_COLORS[f as 1 | 2 | 3]);
    expect(all).toHaveLength(15);
    expect(new Set(all).size).toBe(15);
  });

  it("聯盟色索引會繞回去，不會回傳 undefined", () => {
    expect(allianceColor(1, 0)).toBe(ALLIANCE_COLORS[1][0]);
    expect(allianceColor(1, 5)).toBe(ALLIANCE_COLORS[1][0]);
  });

  it("rgb 與 toCss 互相對得上", () => {
    expect(rgb(0xb8a07e)).toEqual([0xb8, 0xa0, 0x7e]);
    expect(toCss(0x1a1614)).toBe("#1a1614");
    expect(toCss(0x000f00)).toBe("#000f00");
  });
});

describe("縮放層級", () => {
  it("三級對應 docs/01 §6 的 2 / 8 / 32 px", () => {
    expect(ZOOM_LEVELS.map((z) => z.tilePixels)).toEqual([2, 8, 32]);
    expect(MIN_TILE_PX).toBe(2);
    expect(MAX_TILE_PX).toBe(32);
  });

  it("只有 L1 顯示名牌，只有 L2/L3 顯示區域格線", () => {
    const byLevel = new Map(ZOOM_LEVELS.map((z) => [z.level, z]));
    expect(byLevel.get("L1")!.showNameplates).toBe(true);
    expect(byLevel.get("L3")!.showNameplates).toBe(false);
    expect(byLevel.get("L3")!.showStructures).toBe(false);
    expect(byLevel.get("L1")!.showRegionGrid).toBe(false);
  });

  it("zoomSpecFor 取不超過目前縮放的最大級", () => {
    expect(zoomSpecFor(2).level).toBe("L3");
    expect(zoomSpecFor(7).level).toBe("L3");
    expect(zoomSpecFor(8).level).toBe("L2");
    expect(zoomSpecFor(31).level).toBe("L2");
    expect(zoomSpecFor(32).level).toBe("L1");
    expect(zoomSpecFor(999).level).toBe("L1");
  });

  it("★ 吸附用對數距離 —— 線性中點會嚴重偏向大的那一級", () => {
    // 2 與 8 的線性中點是 5，但幾何中點是 4
    expect(snapTilePixels(3.9)).toBe(2);
    expect(snapTilePixels(4.1)).toBe(8);
    // 若用線性距離，5 會吸到 2（|5-2|=3 < |5-8|=3 平手偏小），手感是錯的
    expect(snapTilePixels(5)).toBe(8);
    expect(snapTilePixels(15)).toBe(8);
    expect(snapTilePixels(17)).toBe(32);
  });

  it("stepZoom 在兩端不會越界", () => {
    expect(stepZoom(2, -1)).toBe(2);
    expect(stepZoom(2, 1)).toBe(8);
    expect(stepZoom(32, 1)).toBe(32);
    expect(stepZoom(32, -1)).toBe(8);
  });
});

describe("相機邊界", () => {
  it("★ 拖不出地圖外", () => {
    const v = clampViewport(phone({ centerX: -500, centerY: 9999 }));
    const halfW = v.screenWidth / 2 / v.tilePixels;
    const halfH = v.screenHeight / 2 / v.tilePixels;
    expect(v.centerX).toBeGreaterThanOrEqual(halfW);
    expect(v.centerY).toBeLessThanOrEqual(MAP.height - halfH);
  });

  it("★ 地圖比畫面小的時候鎖在正中央", () => {
    // L3 全圖 1800×1800 px 仍比視窗大，所以這裡刻意把每格縮到 1px 以下的等效情境：
    // 用一個比整張圖還寬的視窗（tilePixels 2 → 需要 > 1800px 才裝得下）
    const v = clampViewport(
      phone({
        tilePixels: 2,
        screenWidth: MAP.width * 2 + 100,
        screenHeight: MAP.height * 2 + 100,
        centerX: 10,
      }),
    );
    expect(v.centerX).toBe(MAP.width / 2);
    expect(v.centerY).toBe(MAP.height / 2);
  });

  it("panBy 之後仍在界內，且方向正確（拖曳向右 = 看到左邊）", () => {
    const before = phone();
    const after = panBy(before, 80, 0);
    expect(after.centerX).toBeLessThan(before.centerX);
    expect(clampViewport(after)).toEqual(after);
  });

  it("centerOn 對準格子中心", () => {
    const v = centerOn(phone(), 100, 200);
    expect(v.centerX).toBe(100.5);
    expect(v.centerY).toBe(200.5);
  });
});

describe("座標轉換", () => {
  it("world → screen → world 來回一致", () => {
    const v = phone();
    for (const [tx, ty] of [
      [Math.floor(MAP.width / 2), Math.floor(MAP.height / 2)],
      [0, 0],
      [MAP.width - 1, MAP.height - 1],
    ] as const) {
      const s = worldToScreen(v, tx, ty);
      // 加半格避免落在邊界上被 floor 到前一格
      const back = screenToWorld(v, s.x + v.tilePixels / 2, s.y + v.tilePixels / 2);
      expect(back).toEqual({ x: tx, y: ty });
    }
  });

  it("畫面正中央對應相機中心那一格", () => {
    const v = phone({ centerX: 123.5, centerY: 456.5 });
    expect(screenToWorld(v, v.screenWidth / 2, v.screenHeight / 2)).toEqual({ x: 123, y: 456 });
  });
});

describe("以錨點縮放", () => {
  it("★ 錨點下的世界座標在縮放前後不變 —— 否則想放大的東西會滑走", () => {
    const v = phone({ tilePixels: 8 });
    const anchorX = 90;
    const anchorY = 700;
    const before = screenToWorld(v, anchorX, anchorY);
    const after = screenToWorld(zoomAt(v, 32, anchorX, anchorY), anchorX, anchorY);
    // clamp 可能微調，允許一格誤差
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  });

  it("縮放被夾在 2–32 之間", () => {
    const v = phone();
    expect(zoomAt(v, 0.1, 0, 0).tilePixels).toBe(MIN_TILE_PX);
    expect(zoomAt(v, 9999, 0, 0).tilePixels).toBe(MAX_TILE_PX);
  });
});

describe("視野剔除", () => {
  it("L1 時可見格數是小的，L3 時是整張圖", () => {
    const l1 = visibleTiles(phone({ tilePixels: 32 }));
    const tilesL1 = (l1.maxX - l1.minX + 1) * (l1.maxY - l1.minY + 1);
    expect(tilesL1).toBeLessThan(1000);

    // 每格 2px 時整張圖是 1800×1800 —— 視窗給滿才看得到全圖
    const l3 = visibleTiles(
      phone({ tilePixels: 2, screenWidth: MAP.width * 2, screenHeight: MAP.height * 2 }),
    );
    expect(l3.minX).toBe(0);
    expect(l3.maxX).toBe(MAP.width - 1);
  });

  it("★ 不論縮放到哪一級，chunk 數都遠小於整張地圖的格數", () => {
    // 這正是「一格一 sprite 不可行、一 chunk 一 sprite 可行」的量化證據
    for (const tilePixels of [2, 8, 32]) {
      const chunks = visibleChunks(visibleTiles(phone({ tilePixels })));
      expect(chunks.length).toBeLessThanOrEqual(CHUNK_COUNT);
      expect(chunks.length).toBeGreaterThan(0);
    }
    // 全圖的 chunk 數由地圖尺寸決定（900×900 → 15×15 = 225），
    // 而格數是 810,000 —— 差了三個數量級，這就是分 chunk 的全部理由
    expect(CHUNK_COUNT).toBe(Math.ceil(MAP.width / CHUNK_SIZE) * Math.ceil(MAP.height / CHUNK_SIZE));
    expect(CHUNK_COUNT * 1000).toBeLessThan(MAP.width * MAP.height);
  });

  it("L1 在手機上只需要 1–4 個 chunk", () => {
    const chunks = visibleChunks(visibleTiles(phone({ tilePixels: 32 })));
    expect(chunks.length).toBeLessThanOrEqual(4);
  });

  it("chunkOfTile 對得上邊界", () => {
    expect(chunkOfTile(0, 0)).toEqual({ cx: 0, cy: 0 });
    expect(chunkOfTile(63, 63)).toEqual({ cx: 0, cy: 0 });
    expect(chunkOfTile(64, 64)).toEqual({ cx: 1, cy: 1 });
    expect(chunkOfTile(MAP.width - 1, MAP.height - 1)).toEqual({
      cx: Math.floor((MAP.width - 1) / CHUNK_SIZE),
      cy: Math.floor((MAP.height - 1) / CHUNK_SIZE),
    });
  });

  it("靠近畫面中心的 chunk 排在前面（先載入重要的）", () => {
    const all = visibleChunks({ minX: 0, minY: 0, maxX: MAP.width - 1, maxY: MAP.height - 1 });
    const sorted = sortByDistanceToCenter(all, 32, 32);
    expect(sorted[0]).toEqual({ cx: 0, cy: 0 });
  });
});

describe("chunk 貼圖", () => {
  it("一格一像素，RGBA 四通道", () => {
    const codes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(TERRAIN_CODE.PLAIN);
    const rgba = chunkToRGBA(codes, 0, 0);
    expect(rgba.length).toBe(CHUNK_SIZE * CHUNK_SIZE * 4);
    expect(rgba[3]).toBe(255);
  });

  it("★ 同一種地形也用兩個明度棋盤交錯 —— 純色塊在 32px 下像佔位符", () => {
    const codes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(TERRAIN_CODE.PLAIN);
    const rgba = chunkToRGBA(codes, 0, 0);
    const first = [rgba[0], rgba[1], rgba[2]];
    const second = [rgba[4], rgba[5], rgba[6]];
    expect(first).not.toEqual(second);
    // (0,0) 與 (1,1) 同色
    const diag = (1 * CHUNK_SIZE + 1) * 4;
    expect([rgba[diag], rgba[diag + 1], rgba[diag + 2]]).toEqual(first);
  });

  it("超出地圖的部分是全透明（邊界是深淵）", () => {
    // 最後一欄的 chunk 有一部分在界外（900 / 64 = 14.06 → cx = 14 只有 4 格在界內）
    const last = Math.floor((MAP.width - 1) / CHUNK_SIZE);
    const insideSpan = MAP.width - last * CHUNK_SIZE; // 界內還剩幾格
    expect(insideSpan).toBeLessThan(CHUNK_SIZE); // 否則這個 case 沒有意義
    const codes = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE).fill(TERRAIN_CODE.PLAIN);
    const rgba = chunkToRGBA(codes, last, 0);
    const inside = (0 * CHUNK_SIZE + insideSpan - 1) * 4;
    expect(rgba[inside + 3]).toBe(255);
    const outside = (0 * CHUNK_SIZE + insideSpan) * 4;
    expect(rgba[outside + 3]).toBe(0);
  });

  it("領土層：無主為透明，有主塗上聯盟色", () => {
    const owners = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE);
    owners[0] = 1;
    const rgba = territoryToRGBA(owners, [0xc4442f]);
    expect(rgba[0]).toBe(0xc4);
    expect(rgba[1]).toBe(0x44);
    expect(rgba[2]).toBe(0x2f);
    expect(rgba[3]).toBe(150);
    // 第二格無主
    expect(rgba[7]).toBe(0);
  });
});
