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

import { MAP, REGION, RUIN_PLACEMENT, WILDS } from "../game/balance";
import { CODE_TERRAIN } from "../game/map/terrain";
import { wildLevelAt } from "../game/wilds";
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
import { edgeSegment, outlineEdges, type OutlineEdge } from "./territory";
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

export interface BattleMarker {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** true = 觀戰窗口內（脈動紅 ✕ 可點觀戰）；false = 近期戰場（暗色殘跡） */
  readonly fresh: boolean;
}

export interface MineMarch {
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly departedAt: number;
  readonly arrivesAt: number;
}

/** 個人圖層：我的據點、領土與行軍（`app/actions/map.ts` 給的） */
export interface MineOverlay {
  readonly serverTime: number;
  readonly base: { readonly x: number; readonly y: number };
  readonly tiles: readonly { readonly x: number; readonly y: number }[];
  readonly marches: readonly MineMarch[];
}

export interface SceneData {
  readonly source: ChunkSource;
  readonly ruins: readonly RuinMarker[];
  readonly spawns: readonly SpawnMarker[];
  /** 交戰地點：fresh = 脈動紅 ✕（可觀戰），否則是暗色殘跡 */
  readonly battles?: readonly BattleMarker[];
  /** 個人圖層。沒登入就沒有 */
  readonly mine?: MineOverlay;
  /** 世界 seed —— 野地等級的資源標示由它決定性推導（與伺服器同一個函式） */
  readonly seed?: number;
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
  /** 個人圖層：領土外框與行軍路徑（territory 層，只在視角變動時重建）、
      我的據點框與行軍中的部隊點（march 層，每幀重畫 —— 它們在動或要壓在結構上面） */
  private readonly territoryGraphics = new Graphics();
  private readonly marchGraphics = new Graphics();
  private mineEdges: readonly OutlineEdge[] = [];
  /** 行軍進度的時間基準：伺服器時間 + 客戶端流逝的間隔（不信任絕對值） */
  private mineEpoch: { server: number; perf: number } | null = null;
  /** 靜態個人圖層的重建判準：視角沒變就不重建 Graphics（省電，docs/09 §7） */
  private mineViewKey = "";
  /**
   * 所有玩家據點 —— 一張 Graphics、只在視角變動時重建。
   * ★ 600 個據點走每幀重建的物件池會吃掉 frame budget（M1b 的教訓），
   *   但**看不到其他玩家的地圖是一張死圖** —— 快取重建兩者兼得，
   *   連 L3 都畫得起（勢力分布一眼可見）。
   */
  private readonly spawnsGraphics = new Graphics();
  private spawnsViewKey = "";
  /** 野地資源標示（等級 pips）—— 同樣視角快取；chunk 陸續載入時要跟著補 */
  private readonly wildsGraphics = new Graphics();
  private wildsViewKey = "";
  /** 目前選取的格子。存世界座標，每幀重畫 —— 縮放平移後選取框才跟得上 */
  private selection: { x: number; y: number } | null = null;

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
    this.layers.territory.addChild(this.territoryGraphics);
    this.layers.march.addChild(this.marchGraphics);
    this.layers.structure.addChild(this.spawnsGraphics);
    this.layers.territory.addChild(this.wildsGraphics);
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
    // 外框只在資料變的時候算一次；每幀只做座標換算
    this.mineEdges = data.mine ? outlineEdges(data.mine.tiles) : [];
    this.mineEpoch = data.mine
      ? { server: data.mine.serverTime, perf: performance.now() }
      : null;
    this.mineViewKey = ""; // 資料換了，靜態圖層一定要重建
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
    this.drawMine(viewport);
    this.drawGrid(viewport, spec.showRegionGrid);
    this.drawSelection();

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

    /**
     * ★ 所有玩家的據點在**每一個縮放層級**都看得見 ——
     *   「其他玩家在哪裡」是地圖的第一資訊。一張視角快取的 Graphics
     *   畫 600 個據點（L3 是 4px 的勢力色點、L1/L2 是帶框的 2×2），
     *   視角沒動就零成本 —— M1b「每幀重畫 600 個」的教訓不再擋路。
     */
    const spawnsKey = `${v.centerX},${v.centerY},${v.tilePixels},${v.screenWidth},${v.screenHeight}`;
    if (spawnsKey !== this.spawnsViewKey) {
      this.spawnsViewKey = spawnsKey;
      this.spawnsGraphics.clear();
      const rect = visibleTiles(v);
      for (const spawn of this.data.spawns) {
        if (
          spawn.x < rect.minX - 2 ||
          spawn.x > rect.maxX + 2 ||
          spawn.y < rect.minY - 2 ||
          spawn.y > rect.maxY + 2
        ) {
          continue;
        }
        const at = worldToScreen(v, spawn.x, spawn.y);
        const size = Math.max(4, v.tilePixels * 2); // 核心據點是 2×2；L3 最少 4px
        this.spawnsGraphics.rect(at.x, at.y, size, size).fill({
          color: allianceColor(spawn.faction, spawn.alliance ?? 0),
          alpha: show ? 0.9 : 0.75,
        });
        if (show) {
          // 放大時給輪廓與「屋頂」—— 看得出是據點，不是色塊
          this.spawnsGraphics.rect(at.x, at.y, size, size).stroke({ color: PALETTE.darkest, width: 1 });
          this.spawnsGraphics
            .rect(at.x + size / 4, at.y - size / 6, size / 2, size / 6)
            .fill({ color: PALETTE.darkest, alpha: 0.9 });
        }
      }
    }

    this.drawWilds(v);

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

    /**
     * ★ 交戰標示:所有縮放層級都要看得見(與遺跡同級的醒目度)。
     *   觀戰窗口內 = 脈動的紅色 ✕（點下那一格 → 展開 → 觀戰）;
     *   窗口過了 = 暗色的戰場殘跡 —— 「這附近最近打過」本身就是情報。
     */
    if (this.data.battles?.length) {
      const pulse = 0.5 + 0.5 * Math.abs(Math.sin(performance.now() / 350));
      for (const b of this.data.battles) {
        const g = this.takeStructure();
        const at = worldToScreen(v, b.x, b.y);
        const cx = at.x + v.tilePixels / 2;
        const cy = at.y + v.tilePixels / 2;
        const h = Math.max(6, v.tilePixels); // L3 下也要有 12px 的標示
        const color = b.fresh ? PALETTE.alert : PALETTE.rustDark;
        const alpha = b.fresh ? pulse : 0.7;
        g.clear();
        g.moveTo(cx - h, cy - h)
          .lineTo(cx + h, cy + h)
          .moveTo(cx + h, cy - h)
          .lineTo(cx - h, cy + h)
          .stroke({ color: PALETTE.darkest, width: 5, alpha });
        g.moveTo(cx - h, cy - h)
          .lineTo(cx + h, cy + h)
          .moveTo(cx + h, cy - h)
          .lineTo(cx - h, cy + h)
          .stroke({ color, width: 3, alpha });
        g.position.set(0, 0);
        g.visible = true;
      }
    }

    // 這一幀沒用到的池物件收起來（不銷毀，下一幀還要用）
    for (let i = this.structureUsed; i < this.structurePool.length; i++) {
      this.structurePool[i]!.visible = false;
    }
  }

  /**
   * 野地資源標示：在資源格上畫「等級 pips」。
   *
   * ★「哪些位置是資源地」光靠地形色塊讀不出來 —— 色塊只說了地形，
   *   沒說**值不值得打**。等級由 `wildLevelAt(seed,x,y,terrain)` 決定性推導
   *   （與伺服器同一個函式，`docs/02` §2.5），所以客戶端不用多拉一筆資料。
   *
   * 密度控制：L1（32px/格）畫 lv≥2 的 pip 排（要打才佔得到的格子）、
   * L2（8px/格）只把 lv5 畫成一顆點 —— 「值得專程跑一趟的在哪」，
   * L3 不畫。★ 第一版 L2 畫 lv≥4 的 pip 排：礦脈有 +1 加成，
   * 近兩成的格子都亮起來、而且 13px 的 pip 排溢出 8px 的格子 ——
   * 整片變成雜訊。全圖 25 萬格都是重點就沒有一格是重點。
   *
   * 快取鍵包含「視野內已載入的 chunk 數」：chunk 是陸續到的，
   * 只看視角的話，第一批 pips 畫完之後才到的地形永遠不會補畫。
   */
  private drawWilds(v: Viewport) {
    const seed = this.data?.seed;
    if (seed === undefined || v.tilePixels < 8) {
      this.wildsGraphics.clear();
      this.wildsViewKey = "";
      return;
    }

    const rect = visibleTiles(v);
    let loaded = 0;
    for (const { cx, cy } of visibleChunks(rect)) {
      if (peekChunk(this.data!.source, cx, cy)) loaded++;
    }
    const key = `${v.centerX},${v.centerY},${v.tilePixels},${v.screenWidth},${v.screenHeight},${loaded}`;
    if (key === this.wildsViewKey) return;
    this.wildsViewKey = key;
    this.wildsGraphics.clear();

    const detailed = v.tilePixels >= 32;
    const minLevel = detailed ? WILDS.guardedFromLevel : WILDS.maxLevel;
    for (let y = rect.minY; y <= rect.maxY; y++) {
      for (let x = rect.minX; x <= rect.maxX; x++) {
        const codes = peekChunk(
          this.data!.source,
          Math.floor(x / CHUNK_SIZE),
          Math.floor(y / CHUNK_SIZE),
        );
        if (!codes) continue;
        const terrain =
          CODE_TERRAIN[codes[(y % CHUNK_SIZE) * CHUNK_SIZE + (x % CHUNK_SIZE)] ?? 0];
        if (!terrain || terrain === "WASTE" || terrain === "MOUNTAIN") continue;
        const level = wildLevelAt(seed, x, y, terrain);
        if (level < minLevel) continue;

        const at = worldToScreen(v, x, y);
        const t = v.tilePixels;
        if (!detailed) {
          // L2：一顆點就好 —— 位置本身就是資訊
          this.wildsGraphics
            .rect(at.x + t / 2 - 2, at.y + t / 2 - 2, 5, 5)
            .fill({ color: PALETTE.darkest, alpha: 0.7 });
          this.wildsGraphics
            .rect(at.x + t / 2 - 1, at.y + t / 2 - 1, 3, 3)
            .fill({ color: PALETTE.parchment, alpha: 0.95 });
          continue;
        }
        // L1：pips 排在格子下緣，黑底 + 羊皮紙點，等級幾就幾顆
        const pip = Math.max(2, Math.floor(t / 10));
        const gap = pip + 1;
        const width = level * gap + 1;
        const px = at.x + (t - width) / 2;
        const py = at.y + t - pip - 3;
        this.wildsGraphics
          .rect(px - 1, py - 1, width + 1, pip + 2)
          .fill({ color: PALETTE.darkest, alpha: 0.7 });
        for (let i = 0; i < level; i++) {
          this.wildsGraphics
            .rect(px + 1 + i * gap, py, pip, pip)
            .fill({ color: PALETTE.parchment, alpha: 0.95 });
        }
      }
    }
  }

  /**
   * 個人圖層：我的領土外框、我的據點、我在路上的部隊。
   *
   * ★ 參照同類作品（docs/09 §12）：領土沿邊界描一圈而不是塗滿格子、
   *   行軍畫成「沿虛線路徑移動的點」。地圖因此從「看的地方」
   *   變成「遊戲發生的地方」—— 你看得到自己的疆界在長大、部隊在路上。
   *
   * ★ 行軍進度是時間的函數（伺服器給 departedAt/arrivesAt，
   *   客戶端只量流逝的間隔）。畫面上的點位置只供顯示，
   *   抵達與戰鬥永遠由伺服器結算。
   */
  private drawMine(v: Viewport) {
    const mine = this.data?.mine;
    if (!mine) {
      this.territoryGraphics.clear();
      this.marchGraphics.clear();
      return;
    }

    /**
     * 靜態的部分（領土外框、行軍虛線）只在視角變動時重建 ——
     * SwiftShader／低階手機上每幀重建 Graphics 是白白燒掉的幀。
     */
    const key = `${v.centerX},${v.centerY},${v.tilePixels},${v.screenWidth},${v.screenHeight}`;
    if (key !== this.mineViewKey) {
      this.mineViewKey = key;
      this.territoryGraphics.clear();

      // ── 領土外框（生機藍 —— 整張廢土地圖上「活的」顏色）──
      for (const e of this.mineEdges) {
        const [x1, y1, x2, y2] = edgeSegment(e);
        const a = worldToScreen(v, x1, y1);
        const b = worldToScreen(v, x2, y2);
        this.territoryGraphics.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      this.territoryGraphics.stroke({ color: PALETTE.vitalBlue, width: 2, alpha: 0.9 });

      // ── 行軍的虛線路徑 ──
      for (const m of mine.marches) {
        const from = worldToScreen(v, m.fromX + 0.5, m.fromY + 0.5);
        const to = worldToScreen(v, m.toX + 0.5, m.toY + 0.5);
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        if (dist < 1) continue;
        const dots = Math.min(80, Math.max(2, Math.floor(dist / 14)));
        for (let i = 0; i <= dots; i++) {
          const k = i / dots;
          this.territoryGraphics
            .rect(from.x + (to.x - from.x) * k - 1, from.y + (to.y - from.y) * k - 1, 3, 3)
            .fill({ color: PALETTE.parchment, alpha: 0.7 });
        }
      }
    }

    // ── 每幀重畫的部分：據點信標（要壓在結構上面）與移動中的部隊點 ──
    this.marchGraphics.clear();
    /**
     * ★「我在哪裡」是地圖的第零資訊 —— 2px 的金框在 L3 上是找不到的。
     *   信標 = 呼吸的金色雙框 + 底下一顆定位點，最小 14px，
     *   任何縮放層級掃一眼就找得到自己。
     */
    const home = worldToScreen(v, mine.base.x, mine.base.y);
    const core = v.tilePixels * 2;
    const beacon = Math.max(14, core);
    const bx = home.x - (beacon - core) / 2;
    const by = home.y - (beacon - core) / 2;
    const breath = 2 + 2 * Math.abs(Math.sin(performance.now() / 600));
    this.marchGraphics
      .rect(bx - breath, by - breath, beacon + breath * 2, beacon + breath * 2)
      .stroke({ color: PALETTE.relicGold, width: 2, alpha: 0.55 });
    this.marchGraphics
      .rect(bx, by, beacon, beacon)
      .stroke({ color: PALETTE.relicGold, width: 3 });
    this.marchGraphics
      .rect(bx + beacon / 2 - 2, by + beacon / 2 - 2, 4, 4)
      .fill({ color: PALETTE.relicGold });

    if (mine.marches.length > 0 && this.mineEpoch) {
      const serverNowMs = this.mineEpoch.server + (performance.now() - this.mineEpoch.perf);
      for (const m of mine.marches) {
        const from = worldToScreen(v, m.fromX + 0.5, m.fromY + 0.5);
        const to = worldToScreen(v, m.toX + 0.5, m.toY + 0.5);
        const k = Math.min(
          1,
          Math.max(0, (serverNowMs - m.departedAt) / Math.max(1, m.arrivesAt - m.departedAt)),
        );
        const px = from.x + (to.x - from.x) * k;
        const py = from.y + (to.y - from.y) * k;
        // 部隊點要在任何底色上都認得出來：黑框、鏽紅身、羊皮紙心
        this.marchGraphics.rect(px - 5, py - 5, 10, 10).fill({ color: PALETTE.darkest });
        this.marchGraphics.rect(px - 4, py - 4, 8, 8).fill({ color: PALETTE.rust });
        this.marchGraphics.rect(px - 1, py - 1, 2, 2).fill({ color: PALETTE.parchment });
      }
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

  /** 選取框。點擊格子後由 React 呼叫；每幀依當下視角重畫，
      縮放平移之後框才會跟著格子走（★ 之前畫一次就不管，雙擊放大後
      框會停在舊縮放的位置與尺寸） */
  setSelection(tile: { x: number; y: number } | null) {
    this.selection = tile;
    this.drawSelection();
  }

  private drawSelection() {
    this.selectionGraphics.clear();
    if (!this.selection || !this.viewport) return;
    const at = worldToScreen(this.viewport, this.selection.x, this.selection.y);
    const size = this.viewport.tilePixels;
    this.selectionGraphics
      .rect(at.x, at.y, size, size)
      .stroke({ color: PALETTE.parchment, width: 2 });
  }
}
