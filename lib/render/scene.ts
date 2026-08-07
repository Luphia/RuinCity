/**
 * PixiJS v8 場景。**瀏覽器端專用**。
 * 對應 docs/01-world-map.md §6 與 docs/09-art-ux.md §5。
 *
 * 五層，由下而上：
 *
 *   terrain    地形（每 chunk 一個 sprite —— 見 `chunks.ts` 的說明）
 *   territory  領土色塊（同樣一 chunk 一 sprite）
 *   structure  據點、遺跡、營地（sprite 物件池，只在 L1/L2 顯示）
 *   march      行軍箭頭
 *   overlay    區域格線、選取框、名牌
 *
 * 這個檔案只負責「畫」。相機運算在 `viewport.ts`、
 * 資料取得在 `chunk-cache.ts` —— 兩者都是純的、可測的。
 */

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Texture,
  TextureSource,
  BufferImageSource,
} from "pixi.js";

import { MAP, REGION, RUIN_PLACEMENT } from "../game/balance";
import {
  CHUNK_SIZE,
  chunkOrigin,
  chunkToRGBA,
  sortByDistanceToCenter,
  visibleChunks,
  type ChunkId,
} from "./chunks";
import { loadChunk, peekChunk, type ChunkSource } from "./chunk-cache";
import { PALETTE, allianceColor } from "./palette";
import {
  visibleTiles,
  worldToScreen,
  zoomSpecFor,
  type Viewport,
} from "./viewport";

export interface RuinMarker {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

export interface SpawnMarker {
  readonly x: number;
  readonly y: number;
  readonly faction: 1 | 2 | 3;
  readonly alliance?: number;
}

export interface SceneData {
  readonly source: ChunkSource;
  readonly ruins: readonly RuinMarker[];
  readonly spawns: readonly SpawnMarker[];
  /** 玩家自己的據點，會畫上高亮框 */
  readonly home?: { x: number; y: number };
}

export interface SceneStats {
  /** 目前畫面上的 sprite 數 —— 效能的直接指標 */
  spriteCount: number;
  chunksLoaded: number;
  chunksVisible: number;
  /**
   * 過去一秒的平均 FPS。
   *
   * M1b 的驗收條件是「手機上 FPS ≥ 50」，而那只有在真機上量得準 ——
   * headless 的 e2e 量不到。把它顯示在畫面上，開發時隨時看得到。
   */
  fps: number;
}

/**
 * ★ 一個 chunk 的地形貼圖。
 *
 * `BufferImageSource` 讓我們直接把 RGBA 位元組交給 GPU，
 * 不用經過 canvas 或圖片解碼。`scaleMode: "nearest"` 是像素風的前提
 * （`docs/09` §2），少了它放大之後會糊成一團。
 */
function makeChunkTexture(rgba: Uint8Array): Texture {
  const source = new BufferImageSource({
    resource: rgba,
    width: CHUNK_SIZE,
    height: CHUNK_SIZE,
    scaleMode: "nearest",
    alphaMode: "premultiply-alpha-on-upload",
  });
  return new Texture({ source });
}

export class MapScene {
  readonly app: Application;
  private readonly layers = {
    terrain: new Container(),
    territory: new Container(),
    structure: new Container(),
    march: new Container(),
    overlay: new Container(),
  };

  private data: SceneData | null = null;
  private viewport: Viewport | null = null;

  private readonly chunkSprites = new Map<string, Sprite>();
  private readonly chunkTextures = new Map<string, Texture>();
  private readonly requested = new Set<string>();

  /** 結構層的 sprite 物件池 —— 平移時不斷 new Sprite 會造成 GC 卡頓 */
  private readonly structurePool: Graphics[] = [];
  private structureUsed = 0;

  private readonly gridGraphics = new Graphics();
  private readonly selectionGraphics = new Graphics();

  stats: SceneStats = { spriteCount: 0, chunksLoaded: 0, chunksVisible: 0, fps: 0 };

  private frameCount = 0;
  private fpsWindowStart = 0;
  private fps = 0;

  private constructor(app: Application) {
    this.app = app;
    for (const layer of Object.values(this.layers)) {
      layer.eventMode = "none";
      app.stage.addChild(layer);
    }
    this.layers.overlay.addChild(this.gridGraphics);
    this.layers.overlay.addChild(this.selectionGraphics);
  }

  static async create(canvas: HTMLCanvasElement, width: number, height: number) {
    const app = new Application();
    await app.init({
      canvas,
      width,
      height,
      background: PALETTE.darkest,
      antialias: false,
      // 像素風的兩個必要條件（`docs/09` §2）
      roundPixels: true,
      resolution: Math.min(2, globalThis.devicePixelRatio || 1),
      autoDensity: true,
      preference: "webgl",
    });
    TextureSource.defaultOptions.scaleMode = "nearest";
    return new MapScene(app);
  }

  setData(data: SceneData) {
    this.data = data;
  }

  destroy() {
    for (const t of this.chunkTextures.values()) t.destroy(true);
    this.chunkTextures.clear();
    this.chunkSprites.clear();
    this.app.destroy(true, { children: true });
  }

  resize(width: number, height: number) {
    this.app.renderer.resize(width, height);
  }

  /** 每一幀呼叫。相機由外部（React）持有，這裡只負責反映它 */
  render(viewport: Viewport) {
    this.viewport = viewport;
    if (!this.data) return;

    const rect = visibleTiles(viewport);
    const spec = zoomSpecFor(viewport.tilePixels);
    const wanted = visibleChunks(rect);

    this.syncTerrain(wanted, viewport);
    this.drawStructures(viewport, spec.showStructures);
    this.drawGrid(viewport, spec.showRegionGrid);

    this.tickFps();
    this.stats = {
      spriteCount: this.chunkSprites.size + this.structureUsed,
      chunksLoaded: this.chunkTextures.size,
      chunksVisible: wanted.length,
      fps: this.fps,
    };
  }

  private tickFps() {
    const now = performance.now();
    if (this.fpsWindowStart === 0) this.fpsWindowStart = now;
    this.frameCount++;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed);
      this.frameCount = 0;
      this.fpsWindowStart = now;
    }
  }

  // ── 地形層 ────────────────────────────────────────────────

  private syncTerrain(wanted: readonly ChunkId[], v: Viewport) {
    const wantedKeys = new Set(wanted.map((c) => `${c.cx}_${c.cy}`));

    // 離開視野的 sprite 直接移除（貼圖留著 —— 地形不會變，重進視野可以秒畫）
    for (const [key, sprite] of this.chunkSprites) {
      if (!wantedKeys.has(key)) {
        this.layers.terrain.removeChild(sprite);
        sprite.destroy();
        this.chunkSprites.delete(key);
      }
    }

    // 靠近畫面中心的先要
    for (const { cx, cy } of sortByDistanceToCenter(wanted, v.centerX, v.centerY)) {
      const key = `${cx}_${cy}`;
      let texture = this.chunkTextures.get(key);

      if (!texture) {
        const codes = peekChunk(this.data!.source, cx, cy);
        if (codes) {
          texture = makeChunkTexture(chunkToRGBA(codes, cx, cy));
          this.chunkTextures.set(key, texture);
        } else {
          this.requestChunk(cx, cy);
          continue;
        }
      }

      let sprite = this.chunkSprites.get(key);
      if (!sprite) {
        sprite = new Sprite(texture);
        sprite.eventMode = "none";
        this.chunkSprites.set(key, sprite);
        this.layers.terrain.addChild(sprite);
      }

      const origin = chunkOrigin(cx, cy);
      const at = worldToScreen(v, origin.x, origin.y);
      sprite.position.set(at.x, at.y);
      // 一像素 = 一格，所以縮放倍率就是 tilePixels
      sprite.scale.set(v.tilePixels);
    }
  }

  private requestChunk(cx: number, cy: number) {
    const key = `${this.data!.source.seasonId}/${cx}_${cy}`;
    if (this.requested.has(key)) return;
    this.requested.add(key);
    void loadChunk(this.data!.source, cx, cy).catch(() => {
      // 下載失敗就讓它下一幀再試
      this.requested.delete(key);
    });
  }

  // ── 結構層 ────────────────────────────────────────────────

  /**
   * 據點、遺跡、營地。
   *
   * 用**物件池**：每一幀重畫，但 Graphics 實例重複使用。
   * L3（2px/格）不畫結構——一個 2px 的方塊沒有資訊量，
   * 而 600 個據點 × 每幀重畫會直接吃掉 frame budget。
   */
  private drawStructures(v: Viewport, show: boolean) {
    this.structureUsed = 0;
    if (!this.data) return;

    // 據點只在 L1／L2 畫。L3 的 2px 方塊沒有資訊量，
    // 而 600 個據點每幀重畫會直接吃掉 frame budget。
    if (show) {
      const rect = visibleTiles(v);
      for (const spawn of this.data.spawns) {
        if (
          spawn.x < rect.minX ||
          spawn.x > rect.maxX ||
          spawn.y < rect.minY ||
          spawn.y > rect.maxY
        ) {
          continue;
        }
        const g = this.takeStructure();
        const at = worldToScreen(v, spawn.x, spawn.y);
        const size = v.tilePixels * 2; // 核心據點是 2×2
        g.clear();
        g.rect(0, 0, size, size).fill({
          color: allianceColor(spawn.faction, spawn.alliance ?? 0),
          alpha: 0.85,
        });
        g.rect(0, 0, size, size).stroke({ color: PALETTE.darkest, width: 1 });
        g.position.set(at.x, at.y);
        g.visible = true;
      }
    }

    // ★ 遺跡在**所有**縮放層級都要看得見 —— 它是地圖上唯一的金色，
    //   而 `docs/09` §3 說「玩家看到金色就知道那裡有重要的東西」。
    for (const ruin of this.data.ruins) {
      const g = this.takeStructure();
      const at = worldToScreen(v, ruin.x - 1, ruin.y - 1);
      const size = v.tilePixels * RUIN_PLACEMENT.footprint;
      // L3 下 3 格只有 6px，硬撐到看得見
      const s = Math.max(10, size);
      g.clear();
      g.rect(0, 0, s, s).fill({ color: PALETTE.relicGold });
      g.rect(0, 0, s, s).stroke({ color: PALETTE.darkest, width: 2 });
      g.position.set(at.x - (s - size) / 2, at.y - (s - size) / 2);
      g.visible = true;
    }

    // 這一幀沒用到的池物件收起來（不銷毀，下一幀還要用）
    for (let i = this.structureUsed; i < this.structurePool.length; i++) {
      this.structurePool[i]!.visible = false;
    }
  }

  private takeStructure(): Graphics {
    let g = this.structurePool[this.structureUsed];
    if (!g) {
      g = new Graphics();
      g.eventMode = "none";
      this.structurePool.push(g);
      this.layers.structure.addChild(g);
    }
    this.structureUsed++;
    return g;
  }

  // ── 疊加層 ────────────────────────────────────────────────

  private drawGrid(v: Viewport, show: boolean) {
    this.gridGraphics.clear();
    if (!show) return;

    const step = REGION.size * v.tilePixels;
    const origin = worldToScreen(v, 0, 0);
    for (let i = 0; i <= REGION.cols; i++) {
      const x = origin.x + i * step;
      this.gridGraphics.moveTo(x, origin.y).lineTo(x, origin.y + MAP.height * v.tilePixels);
    }
    for (let i = 0; i <= REGION.rows; i++) {
      const y = origin.y + i * step;
      this.gridGraphics.moveTo(origin.x, y).lineTo(origin.x + MAP.width * v.tilePixels, y);
    }
    this.gridGraphics.stroke({ color: PALETTE.mid, width: 1, alpha: 0.5 });
  }

  /** 選取框。點擊格子後由 React 呼叫 */
  setSelection(tile: { x: number; y: number } | null) {
    this.selectionGraphics.clear();
    if (!tile || !this.viewport) return;
    const at = worldToScreen(this.viewport, tile.x, tile.y);
    const size = this.viewport.tilePixels;
    this.selectionGraphics
      .rect(at.x, at.y, size, size)
      .stroke({ color: PALETTE.parchment, width: 2 });
  }
}
