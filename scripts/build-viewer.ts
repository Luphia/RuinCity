/**
 * 產生場景包的獨立檢視器：`lib/scene/standalone.{ts,html}` → `lib/scene/viewer.generated.ts`。
 *
 *   pnpm scene:viewer            重新產生
 *   pnpm scene:viewer --check    只比對；不一致就失敗（CI 用）
 *
 * ★ 產物提交進 git。這兩個檔案會原封不動地放進每一個場景包，進而決定它的 CID ——
 *   所以它們必須是看得到、審得到、而且從原始碼重建得出一模一樣位元組的東西。
 *   不壓縮（minify）：放進永久保存的程式碼，應該讓人讀得懂。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { build } from "esbuild";

// pnpm 一律在專案根目錄執行腳本
const root = process.cwd();
const out = resolve(root, "lib/scene/viewer.generated.ts");

async function generate(): Promise<string> {
  const r = await build({
    absWorkingDir: root,
    entryPoints: ["lib/scene/standalone.ts"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    charset: "utf8",
    legalComments: "none",
    minify: false,
    sourcemap: false,
    logLevel: "silent",
  });
  const js = r.outputFiles[0]!.text;
  const html = readFileSync(resolve(root, "lib/scene/standalone.html"), "utf8");
  return [
    "/**",
    " * 由 `scripts/build-viewer.ts` 產生 —— 不要手改，改 `standalone.ts` / `standalone.html` 後重跑 `pnpm scene:viewer`。",
    " * 這兩段文字會原封不動地放進每一個場景包（`index.html`、`viewer.js`）。",
    " */",
    "",
    `export const VIEWER_HTML = ${JSON.stringify(html)};`,
    "",
    `export const VIEWER_JS = ${JSON.stringify(js)};`,
    "",
  ].join("\n");
}

async function main() {
  const next = await generate();
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(out, "utf8");
    } catch {}
    if (current !== next) {
      console.error("lib/scene/viewer.generated.ts 與原始碼不同步 —— 請跑 pnpm scene:viewer 並提交");
      process.exit(1);
    }
    console.log("檢視器與原始碼同步。");
  } else {
    writeFileSync(out, next);
    console.log(`已寫入 ${out}（${(next.length / 1024).toFixed(1)} KB）`);
  }
}

void main();
