/**
 * 獨立檢視器（打包成場景包裡的 `viewer.js`）。
 *
 * 只讀同一個資料夾裡的檔案：`scene.json` 與它列出的圖。不連任何外部服務、不載入任何函式庫
 * （`index.html` 的 CSP 也只允許同源）。3D 用的是和網站相同的 `terrain-gl.ts`。
 *
 * 載入時逐一核對每個檔案的 SHA-256 並把結果顯示在畫面上 ——
 * 從哪個閘道、哪個節點拿到的都一樣，對得上就是當初那一份。
 *
 * ★ 改這個檔案之後要跑 `pnpm scene:viewer` 重新產生 `viewer.generated.ts`；
 *   已發布的場景包不受影響，它們帶著自己那一版的檢視器。
 */

import { MANIFEST_PATH, isSceneManifest, markerPosition, type SceneManifest } from "./format";
import { mountTerrain, type TerrainHandle } from "./terrain-gl";

type Child = Node | string | null | false | undefined;

function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

function nodes(...xs: Child[]): (Node | string)[] {
  return xs.filter((x): x is Node | string => Boolean(x));
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verify(m: SceneManifest, line: HTMLElement) {
  if (!globalThis.crypto?.subtle) {
    line.textContent = "這個連線不是安全來源（https 或 localhost），瀏覽器不提供雜湊運算，無法在這裡驗證。";
    return;
  }
  const entries = Object.entries(m.files);
  let bad = 0;
  let done = 0;
  await Promise.all(
    entries.map(async ([path, f]) => {
      try {
        const res = await fetch(path);
        const digest = hex(await crypto.subtle.digest("SHA-256", await res.arrayBuffer()));
        if (!res.ok || digest !== f.sha256) bad++;
      } catch {
        bad++;
      }
      done++;
      line.textContent = `驗證中… ${done} / ${entries.length}`;
    }),
  );
  line.className = bad ? "bad" : "ok";
  line.textContent = bad
    ? `✗ ${bad} 個檔案與 scene.json 記載的 SHA-256 不符 —— 這不是原本的那一份`
    : `✓ 全部 ${entries.length} 個檔案的 SHA-256 都與 scene.json 相符`;
}

function render(app: HTMLElement, m: SceneManifest) {
  let selected = m.scenes.length ? 0 : -1;
  let terrain: TerrainHandle | null = null;
  const integrity = h("p", { class: "muted", text: "驗證中…" });

  const sceneBox = h("div", { class: "scene" });
  const showScene = () => {
    sceneBox.replaceChildren();
    const s = m.scenes[selected];
    if (!s) {
      sceneBox.append(h("p", { class: "muted", text: "這一塊沒有街景可取，只有俯視的地圖、3D 與材質。" }));
    } else {
      sceneBox.append(
        ...nodes(
        h("img", { src: s.file, alt: s.caption ?? "" }),
        h("p", { text: `標記 #${s.index + 1} · 朝向 ${Math.round(s.heading)}° · ${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}` }),
        s.caption ? h("p", { class: "muted", text: s.caption }) : null,
        ),
      );
    }
    for (const el of app.querySelectorAll<HTMLElement>("[data-scene]")) {
      el.setAttribute("aria-pressed", String(Number(el.dataset.scene) === selected));
    }
  };
  const pick = (i: number) => {
    selected = i;
    showScene();
  };

  const view = h("div");
  const mapTab = h("button", { type: "button", "aria-pressed": "true", text: "地圖" });
  const terrainTab = h("button", { type: "button", "aria-pressed": "false", text: "3D" });
  const showMap = () => {
    terrain?.dispose();
    terrain = null;
    mapTab.setAttribute("aria-pressed", "true");
    terrainTab.setAttribute("aria-pressed", "false");
    if (!m.map) {
      view.replaceChildren(h("p", { class: "muted", text: "沒有底圖。" }));
      return;
    }
    const box = h("div", { class: "map", style: `aspect-ratio:${m.map.width} / ${m.map.height}` }, h("img", { src: m.map.file, alt: `${m.title} 的正射地圖` }));
    for (const s of m.scenes) {
      const p = markerPosition(m.block.bounds, s.lat, s.lng);
      const dot = h("button", {
        type: "button",
        class: "dot",
        title: s.caption ?? `標記 ${s.index + 1}`,
        "data-scene": String(s.index),
        "aria-pressed": String(s.index === selected),
        style: `left:${p.left}%;top:${p.top}%`,
      });
      dot.addEventListener("click", () => pick(s.index));
      box.append(dot);
    }
    view.replaceChildren(box);
  };
  const showTerrain = () => {
    if (!m.map || !m.terrain) return;
    mapTab.setAttribute("aria-pressed", "false");
    terrainTab.setAttribute("aria-pressed", "true");
    const host = h("div", { class: "terrain" });
    const err = h("p", { class: "bad" });
    view.replaceChildren(host, err);
    terrain?.dispose();
    terrain = mountTerrain(host, {
      tileUrl: m.map.file,
      dsmUrl: m.terrain.file,
      aspect: m.map.height / m.map.width,
      render: m.render,
      onError: (msg) => (err.textContent = msg),
    });
  };
  mapTab.addEventListener("click", showMap);
  terrainTab.addEventListener("click", showTerrain);

  const thumbs = h("div", { class: "thumbs" });
  for (const s of m.scenes) {
    const b = h("button", { type: "button", "data-scene": String(s.index), "aria-pressed": String(s.index === selected) }, h("img", { src: s.file, alt: s.caption ?? "", loading: "lazy" }));
    b.addEventListener("click", () => pick(s.index));
    thumbs.append(b);
  }
  const textures = h("div", { class: "tex" });
  for (const t of m.textures) {
    textures.append(h("figure", { style: "margin:0" }, h("img", { src: t.file, alt: t.material ?? "", loading: "lazy" }), h("figcaption", { class: "deep", text: t.material ?? "" })));
  }

  app.replaceChildren(
    ...nodes(
    h(
      "header",
      {},
      h("h1", { text: `${m.title} · 人類離開一千年後` }),
      h("p", { class: "muted", text: `${m.world.name} · 區塊 ${m.block.key} · 完成於 ${m.completedAt.slice(0, 10)}` }),
      integrity,
    ),
    h(
      "section",
      { class: "grid2" },
      h("div", {}, h("div", { class: "tabs" }, mapTab, m.terrain && m.map ? terrainTab : null), view),
      h(
        "div",
        {},
        sceneBox,
        m.fieldNote ? h("blockquote", { text: m.fieldNote }) : null,
        h("p", { class: "deep", text: `繪製：${m.credits.map((c) => `${c.company} ${c.model} ${c.steps} 步`).join("、") || "—"}` }),
      ),
    ),
    m.scenes.length > 1 ? h("section", {}, h("h2", { text: `場景圖 · ${m.scenes.length} 張` }), thumbs) : null,
    m.textures.length ? h("section", {}, h("h2", { text: "材質貼圖" }), textures) : null,
    h(
      "footer",
      { class: "deep" },
      h("p", {}, "這個資料夾是完整的場景包：圖、座標、渲染規格與檢視器都在裡面，不需要原本的網站。細節見 ", h("a", { href: MANIFEST_PATH, text: "scene.json" }), " 與 ", h("a", { href: "README.txt", text: "README.txt" }), "。"),
    ),
    ),
  );
  showMap();
  showScene();
  void verify(m, integrity);
}

async function main() {
  const app = document.getElementById("app")!;
  try {
    const res = await fetch(MANIFEST_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const m: unknown = await res.json();
    if (!isSceneManifest(m)) throw new Error("scene.json 的格式認不出來");
    document.title = `${m.title} · RuinCity`;
    render(app, m);
  } catch (e) {
    app.replaceChildren(
      h("p", { class: "bad", text: `讀不到 scene.json：${e instanceof Error ? e.message : String(e)}` }),
      h("p", { class: "muted", text: "瀏覽器不允許 file:// 頁面讀取同資料夾的檔案。請用 IPFS 閘道開啟，或在這個資料夾執行 python3 -m http.server 後開 http://localhost:8000/" }),
    );
  }
}

void main();
