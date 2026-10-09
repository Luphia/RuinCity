/**
 * 驗證並重建一個場景包 —— 不需要資料庫、不需要網站，任何人都能跑。
 *
 *   pnpm scene:verify <檔案.car> [--extract <資料夾>]
 *   pnpm scene:verify --gateway http://<boltchain 閘道> <委託索引 CID> [--extract <資料夾>]
 *   pnpm scene:verify <資料夾>
 *
 * CAR 可以是網站下載的（根 = 場景包），也可以是 Boltchain 閘道給的（根 = 委託索引，裡面列著整包）。
 *
 * 檢查：
 *   1. 每個區塊的位元組都雜湊成它的 CID
 *   2. 委託索引（如果有）列出的區塊都在、數量與大小相符
 *   3. 拆出的檔案逐一符合 scene.json 記載的 SHA-256，沒有多也沒有少
 *   4. 把拆出的檔案**重新打包**，得到同一個根 CID —— 證明這份資料夾就是那個 CID
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { CID } from "multiformats/cid";

import { checkBlock, packBundle, readCar, unpackBundle, type BundleFile, type IpldBlock } from "@/lib/ipfs/pack";
import { verifyBundleFiles } from "@/lib/scene/bundle";
import { DAG_CBOR_CODEC, decodeDealGroup, decodeDealIndex } from "@/lib/swarm/deal-index";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function walk(dir: string): BundleFile[] {
  const out: BundleFile[] = [];
  const visit = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.push({ path: relative(dir, p).split(sep).join("/"), bytes: new Uint8Array(readFileSync(p)) });
    }
  };
  visit(dir);
  return out;
}

async function fromCar(bytes: Uint8Array): Promise<{ sceneRoot: CID; files: BundleFile[] }> {
  const { roots, blocks } = readCar(bytes);
  if (roots.length !== 1) fail(`CAR 應該只有一個根，這個有 ${roots.length} 個`);
  let bad = 0;
  for (const b of blocks) if (!(await checkBlock(b))) bad++;
  if (bad) fail(`${bad} 個區塊的內容與 CID 不符`);
  console.log(`✓ ${blocks.length} 個區塊的雜湊都正確`);

  const byCid = new Map(blocks.map((b) => [b.cid.toString(), b]));
  let sceneRoot = roots[0]!;
  let listed: IpldBlock[] = blocks;
  if (sceneRoot.code === DAG_CBOR_CODEC) {
    const idx = decodeDealIndex(byCid.get(sceneRoot.toString())?.bytes ?? new Uint8Array());
    if (!idx || !idx.root) fail("根是 dag-cbor，但不是帶入口的 Boltchain 委託索引");
    const leaves: CID[] = [];
    for (const g of idx.groups) {
      const gb = byCid.get(g.toString());
      if (!gb) fail(`缺少委託索引的分組 ${g.toString()}`);
      leaves.push(...decodeDealGroup(gb.bytes));
    }
    const missing = leaves.filter((c) => !byCid.has(c.toString()));
    if (leaves.length !== idx.count || missing.length) fail(`委託索引列出 ${idx.count} 個區塊，缺 ${missing.length} 個`);
    listed = leaves.map((c) => byCid.get(c.toString())!);
    const size = listed.reduce((s, b) => s + b.bytes.length, 0);
    if (size !== idx.size) fail(`委託索引記載 ${idx.size} 位元組，實際 ${size}`);
    console.log(`✓ Boltchain 委託索引 ${sceneRoot.toString()}：${idx.count} 個區塊、${idx.size} 位元組，全部都在`);
    sceneRoot = idx.root;
  }
  return { sceneRoot, files: await unpackBundle(sceneRoot, listed) };
}

async function main() {
  const args = process.argv.slice(2);
  const take = (flag: string) => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? fail(`${flag} 後面要接一個值`);
  };
  const extract = take("--extract");
  const gateway = take("--gateway");
  const target = args[0] ?? fail("用法：pnpm scene:verify <檔案.car | 資料夾> 或 --gateway <網址> <委託索引 CID>");

  let expected: CID | null = null;
  let files: BundleFile[];
  if (gateway) {
    const url = `${gateway.replace(/\/+$/, "")}/ipfs/${CID.parse(target).toString()}?format=car`;
    console.log(`下載 ${url}`);
    const res = await fetch(url, { headers: { accept: "application/vnd.ipld.car" } });
    if (!res.ok) fail(`閘道回應 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    const r = await fromCar(new Uint8Array(await res.arrayBuffer()));
    expected = r.sceneRoot;
    files = r.files;
  } else if (statSync(target).isDirectory()) {
    files = walk(target);
  } else {
    const r = await fromCar(new Uint8Array(readFileSync(target)));
    expected = r.sceneRoot;
    files = r.files;
  }

  const check = await verifyBundleFiles(files);
  if (!check.ok) fail(`場景包不完整：\n  ${check.problems.join("\n  ")}`);
  console.log(`✓ ${files.length} 個檔案都符合 scene.json（${check.manifest.title}，區塊 ${check.manifest.block.key}）`);

  const repacked = await packBundle(files);
  if (expected && repacked.root.toString() !== expected.toString()) {
    fail(`重新打包得到 ${repacked.root.toString()}，與 ${expected.toString()} 不同`);
  }
  console.log(`✓ 重新打包得到同一個 CID：${repacked.root.toString()}`);

  if (extract) {
    const dir = resolve(extract);
    for (const f of files) {
      const p = join(dir, ...f.path.split("/"));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.bytes);
    }
    console.log(`已解到 ${dir}。開啟：cd ${extract} && python3 -m http.server，然後打開 http://localhost:8000/`);
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
