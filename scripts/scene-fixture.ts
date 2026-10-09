/**
 * 寫出一個決定性的範例場景包資料夾，並印出它的根 CID。
 *
 *   pnpm scene:fixture <資料夾>
 *
 * CI 的 `scene-kubo` 工作拿它與真的 Kubo 比對：
 *   ipfs add -r --only-hash --cid-version=1 --raw-leaves --chunker=size-1048576 <資料夾>
 * 兩邊的根 CID 必須相同 —— 這就是「任何人都能用標準 IPFS 工具重算場景包的 CID」的證據。
 * 範例裡有一個超過 1 MiB 的檔案，讓分塊與檔案節點也被比對到。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { packBundle } from "@/lib/ipfs/pack";
import { artifactFiles, buildExtras, type BundleArtifact } from "@/lib/scene/bundle";
import { VIEWER_HTML, VIEWER_JS } from "@/lib/scene/viewer.generated";
import { ORIGIN_BLOCK } from "@/lib/world/grid";

function art(kind: string, kindIndex: number, seed: number, size: number): BundleArtifact {
  const bytes = new Uint8Array(size).map((_, i) => (i * 7 + seed * 13 + ((i >> 9) & 0xff)) & 255);
  return { kind, kindIndex, mime: "image/webp", width: 64, height: 36, label: kind === "TEXTURE" ? `material ${kindIndex}` : null, bytes };
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error("用法：pnpm scene:fixture <資料夾>");
  const artifacts = [
    art("TILE", 0, 1, 2_600_000),
    art("DSM", 0, 2, 300_000),
    ...Array.from({ length: 5 }, (_, i) => art("SCENE", i, 10 + i, 200_000 + i * 1000)),
    ...Array.from({ length: 3 }, (_, i) => art("TEXTURE", i, 20 + i, 150_000)),
  ];
  const { extras } = await buildExtras({
    block: ORIGIN_BLOCK,
    key: "25.03_121.56",
    completedAt: new Date("2026-10-09T00:00:00Z"),
    viewpoints: Array.from({ length: 5 }, (_, i) => ({
      panoId: `p${i}`,
      location: { lat: 25.031 + i * 0.001, lng: 121.561 + i * 0.001 },
      heading: i * 45,
      pitch: 0,
      fov: 90,
      date: "2024-03",
    })),
    params: null,
    artifacts,
    steps: [],
    viewer: { html: VIEWER_HTML, js: VIEWER_JS },
  });
  const files = [...extras, ...artifactFiles(artifacts)];
  const dir = resolve(out);
  for (const f of files) {
    const p = join(dir, ...f.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.bytes);
  }
  console.log((await packBundle(files)).root.toString());
}

void main();
