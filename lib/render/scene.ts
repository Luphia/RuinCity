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

import { MAP, REGION, RUIN_PLACEMENT, TILE_RESOURCE, WILDS } from "../game/balance";
import { CODE_TERRAIN } from "../game/map/terrain";
import type { IconShapeOf } from "../game/icon-shape";
import { keepIconShapes, type KeepTier, type KeepTone } from "../game/keep-icon";
import {
  iconScaleFor,
  tileIconShapes,
  type IconTone,
  type TileResource,
} from "../game/map-icon";
import { warIconShapes, type WarTone } from "../game/war-icon";
import { wildLevelAt } from "../game/wilds";
import {
  CHUNK_SIZE,
  chunkOrigin,
  chunkToRGBA,
  sortByDistanceToCenter,
  visibleChunks,
  type ChunkId,
} from "./chunks";
import { isBattleLive, type BattleMarker } from "./battles";
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
  /**
   * 城牆（RAMPART）的三段（`lib/game/keep-icon.ts`）。
   * 沒給就當第 1 段 —— 開發地圖的出生點沒有玩家，也就沒有城牆。
   */
  readonly wallTier?: KeepTier;
}

export type { BattleMarker };

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
  /**
   * 伺服器時間（毫秒）。交戰動畫的下架時刻要跟它比，
   * **不信任客戶端時鐘的絕對值**（`lib/time.ts` 的同一條規矩）——
   * 客戶端只提供「過了多久」。
   */
  readonly serverTime?: number;
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

/**
 * 資源地貌圖示的語意色 → 調色盤（`docs/09` §3）。
 *
 * ★ `lib/game/map-icon.ts` 只吐 token，色碼在這裡對 ——
 *   `/lib/game` 不該知道任何一個 hex。
 */
const ICON_TONE: Record<IconTone, number> = {
  shadow: PALETTE.darkest,
  dark: PALETTE.darkest,
  leaf: PALETTE.mossLight,
  leafDark: PALETTE.mossDark,
  wood: PALETTE.woodDark,
  crop: PALETTE.sandLight,
  field: PALETTE.mossLight,
  water: PALETTE.vitalBlue,
  rock: PALETTE.stoneLight,
  rockDark: PALETTE.stoneDark,
  metal: PALETTE.metalBright,
  hole: PALETTE.darkest,
};

/**
 * 主城圖示的語意色。
 *
 * ★ `banner` 不在這裡 —— 它是**聯盟色**，由 `allianceColor()` 當場代入。
 *   `/lib/game/keep-icon.ts` 不知道有 15 個聯盟，也不該知道。
 */
const KEEP_TONE: Record<Exclude<KeepTone, "banner">, number> = {
  shadow: PALETTE.darkest,
  dark: PALETTE.darkest,
  wood: PALETTE.wood,
  woodDark: PALETTE.woodDark,
  stone: PALETTE.stoneLight,
  stoneDark: PALETTE.stoneDark,
  metal: PALETTE.metalBright,
  metalDark: PALETTE.metal,
  roof: PALETTE.rust,
  roofDark: PALETTE.rustDark,
  light: PALETTE.parchment,
};

/** 交戰動畫的語意色。火花走警示紅 —— 地圖上紅色一直都是戰鬥的顏色 */
const WAR_TONE: Record<WarTone, number> = {
  shadow: PALETTE.darkest,
  blade: PALETTE.metalBright,
  bladeDark: PALETTE.metal,
  edge: PALETTE.parchment,
  guard: PALETTE.wood,
  grip: PALETTE.woodDark,
  spark: PALETTE.alert,
  sparkCore: PALETTE.parchment,
};

/** PixiJS 用數字色，canvas 2D 用字串 —— 這裡是那個轉換 */
function hexOf(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/**
 * 單位座標的形狀 → canvas 2D。烘貼圖用（主城）。
 */
function paintShapes<Tone extends string>(
  ctx: CanvasRenderingContext2D,
  shapes: readonly IconShapeOf<Tone>[],
  colorOf: (tone: Tone) => number,
  px: number,
) {
  for (const shape of shapes) {
    ctx.fillStyle = hexOf(colorOf(shape.tone));
    if (shape.kind === "rect") {
      ctx.fillRect(shape.x * px, shape.y * px, shape.w * px, shape.h * px);
    } else {
      const pts = shape.points;
      ctx.beginPath();
      ctx.moveTo(pts[0]! * px, pts[1]! * px);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]! * px, pts[i + 1]! * px);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** 遠景那顆點用哪個色 —— 顏色是這個距離下唯一還說得出「哪一種」的訊號 */
const RESOURCE_DOT: Record<"grain" | "timber" | "stone" | "iron", IconTone> = {
  grain: "crop",
  timber: "leaf",
  stone: "rock",
  iron: "metal",
};

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
  /**
   * ★ 主城圖示走**貼圖 + sprite 池**，與資源地貌同一招（理由見下面的說明）。
   *   貼圖依「城牆段 × 聯盟色 × 實際像素尺寸」快取，而尺寸**量化成 8 的倍數**
   *   —— 雙指縮放是連續的，不量化的話捏一下就會烘出幾十張只差一像素的貼圖。
   */
  private readonly keepSprites: Sprite[] = [];
  private keepSpritesUsed = 0;
  /** 上一次重建時擺出去的 sprite 數 —— 視角沒動時 stats 才不會歸零說謊 */
  private keepVisibleCount = 0;
  private readonly keepTextures = new Map<string, Texture>();
  /**
   * 交戰中的兩把刀。**每幀重畫**（它在動，快取沒有意義），
   * 但只畫視野內的那幾格 —— 全賽季最多 200 場交戰，
   * 而畫面上通常只有零到幾場。
   */
  private readonly warGraphics = new Graphics();
  /** 伺服器時間的基準：伺服器給的絕對值 + 客戶端量到的**間隔** */
  private clockEpoch: { server: number; perf: number } | null = null;
  /** 交戰標示 —— 與 `data` 分開存，因為它會被輪詢單獨換掉（見 `setBattles`） */
  private battles: readonly BattleMarker[] = [];
  /** 野地資源標示（地貌圖示）—— 同樣視角快取；chunk 陸續載入時要跟著補 */
  private readonly wildsGraphics = new Graphics();
  private wildsViewKey = "";
  /**
   * ★ 圖示走**貼圖 + sprite 池**，不是一張大 Graphics。
   *
   *   幾百個圖示、每個十幾個多邊形，塞進同一張 Graphics 就是幾千個圖元；
   *   sprite 則會被批次成一次 draw call（與地形 chunk 同一招）。
   *
   *   ★ 誠實記帳：這個選擇是**架構上的**，不是量出來的。
   *   開發沙箱沒有 GPU（軟體 WebGL），最大縮放下的幀率被地形的
   *   軟體光柵化主導 —— 兩種做法都是 13–15 fps，而不畫圖示的基準是
   *   16–17 fps。也就是說在這台機器上分不出高下，真機才分得出。
   *   選 sprite 是因為「每幀重新處理幾千個圖元」在有 GPU 的裝置上
   *   是已知的成本，而 sprite 沒有這個成本。
   *
   *   貼圖依「資源 × 實際像素尺寸」快取：每一個尺寸各烘一張，
   *   所以放大縮小都是**銳利**的，不靠縮放取樣。
   */
  private readonly wildSprites: Sprite[] = [];
  private wildSpritesUsed = 0;
  private readonly iconTextures = new Map<string, Texture>();
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
    // ★ 交戰要壓在據點上面：正在打的那一格是全圖最該被看到的東西
    this.layers.march.addChild(this.warGraphics);
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
    this.spawnsViewKey = "";
    /**
     * ★ 沒帶烽火就**不要動**現有的那一份。
     *   `data` 一場賽季換一次、烽火十五秒換一次（`setBattles`）——
     *   在這裡無條件覆蓋成空陣列的話，任何一次 `setData`
     *   都會把畫面上正在打的仗抹掉，直到下一次輪詢才回來。
     */
    if (data.battles) this.setBattles(data.battles, data.serverTime ?? data.mine?.serverTime);
    else if (data.serverTime !== undefined || data.mine) {
      this.clockEpoch = {
        server: data.serverTime ?? data.mine!.serverTime,
        perf: performance.now(),
      };
    }
  }

  /**
   * 只換交戰標示。
   *
   * ★ 為什麼要有這一支：交戰是**十幾秒輪詢一次**的東西，
   *   而 `setData` 會連帶重建個人圖層、重設視角快取，
   *   在 React 那一端還會重新對焦到出生點（`MapCanvas` 的 focus effect）。
   *   「地圖每十秒自己跳回家」就是那樣來的。輪詢只該碰它自己那一份資料。
   */
  setBattles(battles: readonly BattleMarker[], serverTime?: number) {
    this.battles = battles;
    if (serverTime !== undefined) {
      this.clockEpoch = { server: serverTime, perf: performance.now() };
    }
  }

  /**
   * 現在幾點（伺服器的鐘）。只取客戶端時鐘的**間隔**，不取絕對值。
   * 還沒拿到伺服器時間就退回本機時鐘 —— 沒有基準時，會動的動畫
   * 比停住的動畫誠實（停住的那一格看起來像「已經打完」）。
   */
  private serverNowMs(): number {
    if (!this.clockEpoch) return Date.now();
    return this.clockEpoch.server + (performance.now() - this.clockEpoch.perf);
  }

  destroy() {
    for (const t of this.chunkTextures.values()) t.destroy(true);
    this.chunkTextures.clear();
    for (const t of this.iconTextures.values()) t.destroy(true);
    this.iconTextures.clear();
    for (const t of this.keepTextures.values()) t.destroy(true);
    this.keepTextures.clear();
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
      /**
       * ★ 資源圖示也要算進來。這個數字是 frame budget 的直接指標
       *   （M1b 的教訓），少算了幾百個 sprite 的話它就在說謊 ——
       *   而說謊的儀表比沒有儀表更糟。
       */
      spriteCount:
        this.chunkSprites.size +
        this.structureUsed +
        this.wildSpritesUsed +
        this.keepSpritesUsed,
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

    this.drawSpawns(v, show);
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

    this.drawBattles(v);

    // 這一幀沒用到的池物件收起來（不銷毀，下一幀還要用）
    for (let i = this.structureUsed; i < this.structurePool.length; i++) {
      this.structurePool[i]!.visible = false;
    }
  }

  /**
   * 所有玩家的據點。
   *
   * ★ 「其他玩家在哪裡」是地圖的第一資訊，所以**每一個縮放層級**都畫，
   *   只是畫法不同：
   *
   * | 縮放 | 畫什麼 | 為什麼 |
   * | --- | --- | --- |
   * | ≥16px | **主城圖示**（2×2，依城牆分三段） | 這個距離是在挑目標，「那座好不好打」該看得出來 |
   * | 8px | 帶框與屋頂的 2×2 聯盟色塊 | 16px 的城只剩一團輪廓，色塊反而讀得快 |
   * | 2px | 4px 的勢力色點 | 戰略視圖看的是勢力分布 |
   *
   *   兩種畫法都吃**視角快取**：視角沒動就零成本，
   *   M1b「每幀重畫 600 個會吃掉 frame budget」的教訓不再擋路。
   */
  private drawSpawns(v: Viewport, show: boolean) {
    this.keepSpritesUsed = 0;
    if (!this.data) return;

    /** 主城圖示要 32px 以上才讀得出三段的差別（2×2 → 每格 16px） */
    const detailed = show && v.tilePixels >= 16;
    const key = `${v.centerX},${v.centerY},${v.tilePixels},${v.screenWidth},${v.screenHeight},${detailed}`;
    const stale = key !== this.spawnsViewKey;
    if (stale) {
      this.spawnsViewKey = key;
      this.spawnsGraphics.clear();
    } else if (detailed) {
      // sprite 留在原位，只要把「這一幀用了幾個」補回來即可
      this.keepSpritesUsed = this.keepVisibleCount;
      return;
    } else {
      return;
    }

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
      const color = allianceColor(spawn.faction, spawn.alliance ?? 0);
      const footprint = v.tilePixels * 2; // 核心據點恆為 2×2（`docs/02` §1）

      if (detailed) {
        /**
         * ★ 量化成 8 的倍數，而且**無條件捨去** ——
         *   捨去保證圖示不會比那 2×2 大，捏縮放時也不會烘出一大堆
         *   只差一像素的貼圖。烘幾張就用幾張的原尺寸畫，不縮放：
         *   全域 `scaleMode` 是 `nearest`，縮放會碎（與地貌圖示同一條）。
         */
        const px = Math.max(16, Math.floor(footprint / 8) * 8);
        const sprite = this.takeKeepSprite();
        sprite.texture = this.keepTexture(spawn.wallTier ?? 1, color, px);
        sprite.width = px;
        sprite.height = px;
        sprite.position.set(
          Math.round(at.x + (footprint - px) / 2),
          Math.round(at.y + (footprint - px) / 2),
        );
        sprite.visible = true;
        continue;
      }

      const size = Math.max(4, footprint); // L3 最少 4px
      this.spawnsGraphics.rect(at.x, at.y, size, size).fill({ color, alpha: show ? 0.9 : 0.75 });
      if (show) {
        // 放大時給輪廓與「屋頂」—— 看得出是據點，不是色塊
        this.spawnsGraphics
          .rect(at.x, at.y, size, size)
          .stroke({ color: PALETTE.darkest, width: 1 });
        this.spawnsGraphics
          .rect(at.x + size / 4, at.y - size / 6, size / 2, size / 6)
          .fill({ color: PALETTE.darkest, alpha: 0.9 });
      }
    }

    this.keepVisibleCount = this.keepSpritesUsed;
    for (let i = this.keepSpritesUsed; i < this.keepSprites.length; i++) {
      this.keepSprites[i]!.visible = false;
    }
  }

  private takeKeepSprite(): Sprite {
    let sp = this.keepSprites[this.keepSpritesUsed];
    if (!sp) {
      sp = new Sprite();
      sp.eventMode = "none";
      this.keepSprites.push(sp);
      this.layers.structure.addChild(sp);
    }
    this.keepSpritesUsed++;
    return sp;
  }

  /**
   * 把一座主城烘成指定像素尺寸的貼圖。
   *
   * 快取鍵是「城牆段 × 聯盟色 × 尺寸」。聯盟色進鍵是因為旗子的顏色
   * 是**這座城屬於誰**的答案，而 tint 會把整張圖一起染色。
   */
  private keepTexture(tier: KeepTier, banner: number, px: number): Texture {
    const key = `${tier}:${banner}:${px}`;
    const hit = this.keepTextures.get(key);
    if (hit) return hit;

    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d")!;

    // 地面暗影：地形色有淺有深，少了它石造的城畫在礫石上會消失
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = hexOf(PALETTE.darkest);
    ctx.beginPath();
    ctx.ellipse(px / 2, px * 0.9, px * 0.48, px * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    paintShapes<KeepTone>(
      ctx,
      keepIconShapes(tier),
      (tone) => (tone === "banner" ? banner : KEEP_TONE[tone]),
      px,
    );

    const texture = Texture.from(canvas);
    this.keepTextures.set(key, texture);
    return texture;
  }

  /**
   * 交戰標示。三種狀態，而且**必須分得開**（`docs/09` §12.5）：
   *
   * | 狀態 | 畫什麼 |
   * | --- | --- |
   * | 正在打（≥16px/格） | **兩把互砍的刀**，嚴格在那 1×1 格裡 |
   * | 正在打（更遠） | 脈動紅 ✕ + 一圈白環 |
   * | 觀戰窗口內 | 脈動紅 ✕ |
   * | 窗口過了 | 暗色殘跡（再留 6 小時） |
   *
   * ★ 「正在打」的判準是 `endsAt`，不是伺服器那一次回答的 `live`。
   *   交戰只有兩分鐘而輪詢是十幾秒一次 —— 只信 `live` 的話，
   *   打完的仗還會在地圖上砍十幾秒，而那段時間點進去沒有現場。
   *   時間到就退回紅 ✕（那一格仍在觀戰窗口內），動畫立刻收掉。
   */
  private drawBattles(v: Viewport) {
    this.warGraphics.clear();
    if (!this.battles.length) return;

    const now = this.serverNowMs();
    const rect = visibleTiles(v);
    const pulse = 0.5 + 0.5 * Math.abs(Math.sin(performance.now() / 350));
    /** 刀在 16px 以下只是一團會抖的雜點 —— 那個距離交給紅 ✕ */
    const animate = v.tilePixels >= 16;

    for (const b of this.battles) {
      // ★ 只畫視野內的。全賽季最多 200 場，畫面上通常是零到幾場
      if (b.x < rect.minX - 1 || b.x > rect.maxX + 1) continue;
      if (b.y < rect.minY - 1 || b.y > rect.maxY + 1) continue;

      const live = isBattleLive(b, now);
      const at = worldToScreen(v, b.x, b.y);

      if (live && animate) {
        const t = v.tilePixels;
        for (const shape of warIconShapes(now)) {
          const pts = shape.points;
          this.warGraphics.moveTo(at.x + pts[0]! * t, at.y + pts[1]! * t);
          for (let i = 2; i < pts.length; i += 2) {
            this.warGraphics.lineTo(at.x + pts[i]! * t, at.y + pts[i + 1]! * t);
          }
          this.warGraphics.fill({ color: WAR_TONE[shape.tone] });
        }
        continue;
      }

      const g = this.takeStructure();
      const cx = at.x + v.tilePixels / 2;
      const cy = at.y + v.tilePixels / 2;
      const h = Math.max(6, v.tilePixels); // L3 下也要有 12px 的標示
      const color = b.fresh || live ? PALETTE.alert : PALETTE.rustDark;
      const alpha = b.fresh || live ? pulse : 0.7;
      g.clear();
      /**
       * ★ 進行中的交戰多一圈脈動的環 —— 遠遠就看得出「那裡還打得到」。
       *   金色是遺跡專用（`palette.ts`），所以這裡用羊皮紙白，
       *   紅 ✕ 仍然是戰鬥的顏色。
       */
      if (live) {
        g.circle(cx, cy, h * 1.6).stroke({ color: PALETTE.parchment, width: 2, alpha });
      }
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

  /**
   * 野地資源標示：在資源格上畫**那種資源的地貌**，大小隨等級。
   *
   * ★ 第一版畫的是「等級幾就幾顆點」。它回答得了「這一格幾級」，
   *   答不出**那是什麼資源** —— 而玩家在地圖上找的從來不是等級，
   *   是「哪裡有木頭」。四種點長得一模一樣，要知道是哪一種只能點下去。
   *
   * 現在：稻田／森林／山洞／礦坑（`lib/game/map-icon.ts`），
   * 荒地與山脈不畫。**等級用面積表示**：lv1 佔 38%、lv5 佔 92%，
   * 於是強弱一眼可比，而密度自己收斂 —— 低階的讀起來像地表紋理，
   * 高階的自己跳出來。
   *
   * 密度／成本控制（`docs/09` §12.5 的教訓還在，只是換了手段）：
   *
   * | 縮放 | 畫什麼 | 為什麼 |
   * | --- | --- | --- |
   * | 32px | 全部等級的圖示 | 這個距離就是在挑目標 |
   * | 16px | lv≥2 的圖示 | 全畫等於一次重建一萬多個圖元，平移會頓 |
   * | 8px  | lv5 一顆**帶顏色**的點 | 7px 的圖示只是一團糊；顏色仍然說得出是哪一種 |
   * | ≤4px | 不畫 | 戰略視圖看的是勢力，不是格子 |
   *
   * 快取鍵包含「視野內已載入的 chunk 數」：chunk 是陸續到的，
   * 只看視角的話，第一批圖示畫完之後才到的地形永遠不會補畫。
   */
  private drawWilds(v: Viewport) {
    const seed = this.data?.seed;
    if (seed === undefined || v.tilePixels < 8) {
      this.wildsGraphics.clear();
      for (const sp of this.wildSprites) sp.visible = false;
      this.wildSpritesUsed = 0;
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
    this.wildSpritesUsed = 0;

    const t = v.tilePixels;
    const minLevel = t >= 32 ? 1 : t >= 16 ? WILDS.guardedFromLevel : WILDS.maxLevel;
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
        if (!terrain) continue;
        // 荒地與山脈沒有產出（`TILE_RESOURCE`）—— 沒有圖示就是它的意思
        const res = TILE_RESOURCE[terrain];
        if (!res) continue;
        const level = wildLevelAt(seed, x, y, terrain);
        if (level < minLevel) continue;

        const at = worldToScreen(v, x, y);
        if (t < 16) {
          // 遠景：一顆點，但**帶著資源的顏色** —— 位置與種類都還在
          this.wildsGraphics
            .rect(at.x + t / 2 - 2, at.y + t / 2 - 2, 5, 5)
            .fill({ color: PALETTE.darkest, alpha: 0.75 });
          this.wildsGraphics
            .rect(at.x + t / 2 - 1, at.y + t / 2 - 1, 3, 3)
            .fill({ color: ICON_TONE[RESOURCE_DOT[res.resource]], alpha: 0.95 });
          continue;
        }

        const size = t * iconScaleFor(level);
        const px = Math.max(6, Math.round(size));
        const sprite = this.takeWildSprite();
        sprite.texture = this.iconTexture(res.resource, px);
        sprite.width = px;
        sprite.height = px;
        sprite.position.set(
          Math.round(at.x + (t - px) / 2),
          Math.round(at.y + (t - px) / 2),
        );
        sprite.visible = true;
      }
    }

    // 這一次沒用到的收起來（留著，下一次視角變動還要用）
    for (let i = this.wildSpritesUsed; i < this.wildSprites.length; i++) {
      this.wildSprites[i]!.visible = false;
    }
  }

  private takeWildSprite(): Sprite {
    let sp = this.wildSprites[this.wildSpritesUsed];
    if (!sp) {
      sp = new Sprite();
      sp.eventMode = "none";
      this.wildSprites.push(sp);
      this.layers.territory.addChild(sp);
    }
    this.wildSpritesUsed++;
    return sp;
  }

  /**
   * 把一個資源地貌烘成**指定像素尺寸**的貼圖。
   *
   * ★ 每個尺寸各烘一張，而不是烘一張大的再縮放：
   *   全域的 `scaleMode` 是 `nearest`（像素風的前提），
   *   拿 64px 的圖縮到 11px 會碎成雜訊。實際用到的尺寸只有十來種
   *   （兩個縮放層級 × 五個等級），快取綽綽有餘。
   */
  private iconTexture(resource: TileResource, px: number): Texture {
    const key = `${resource}:${px}`;
    const hit = this.iconTextures.get(key);
    if (hit) return hit;

    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d")!;

    /**
     * ★ 先鋪一層暗影。地形色塊有淺有深 ——
     *   少了它，森林畫在苔綠上會整個消失。
     */
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = hexOf(PALETTE.darkest);
    ctx.beginPath();
    ctx.ellipse(px / 2, px * 0.9, px * 0.42, px * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    paintShapes<IconTone>(ctx, tileIconShapes(resource), (tone) => ICON_TONE[tone], px);

    const texture = Texture.from(canvas);
    this.iconTextures.set(key, texture);
    return texture;
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
