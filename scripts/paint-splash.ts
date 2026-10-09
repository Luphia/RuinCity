import "./load-env";

/**
 * 畫開場畫面：從象山山頂俯視荒廢的臺北 101。
 *
 *   pnpm splash:paint                     用平台預設的畫師（DEFAULT_PROVIDER）
 *   pnpm splash:paint --provider openai   指定 google 或 openai
 *   pnpm splash:paint --no-reference      不附街景（沒有 GOOGLE_MAPS_API_KEY 時自動如此）
 *
 * 用的是與區塊相同的正典、擬真規格與畫師（`lib/world/prompts.ts` 的 `splashJob`），
 * 寫出 `public/splash/xiangshan-<雜湊>.webp` 與 `lib/splash.generated.ts`。兩個都要提交。
 *
 * ★ 這張圖由平台付費（約一張場景圖的價錢），不從任何一塊的捐款扣。
 * ★ 示範模式畫不出擬真的圖，所以拒絕執行 —— 開場畫面寧可只有標題，也不放一張假圖。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";

import { normalizeImage } from "@/lib/providers/image";
import type { ResolvedPart } from "@/lib/providers/painter";
import { defaultProvider, enabledProviders, painterFor, referenceSource, usingFakeProviders } from "@/lib/providers/registry";
import { BIBLE_VERSION } from "@/lib/world/bible";
import { MODEL_PROFILES, isPainterId, usageCostMicros, type PainterId } from "@/lib/world/pricing";
import { XIANGSHAN_VIEWPOINT, splashJob, splashViewpoint } from "@/lib/world/prompts";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf("--provider");
  const wanted = i >= 0 ? args[i + 1] : defaultProvider();
  if (!isPainterId(wanted)) fail(`--provider 只能是 google 或 openai（收到 ${wanted}）`);
  const provider: PainterId = wanted;
  if (usingFakeProviders()) fail("示範模式（FAKE_PROVIDERS=1）畫不出擬真的開場圖。請設定真的模型金鑰再跑。");
  if (!enabledProviders().includes(provider)) {
    fail(`${MODEL_PROFILES[provider].displayName} 沒有金鑰（${provider === "google" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"}）`);
  }

  // ── 參考：象山山頂的街景（有地圖金鑰、而且那裡有全景才附） ──
  let reference: ResolvedPart | null = null;
  let referenceDate: string | null = null;
  const src = args.includes("--no-reference") ? null : referenceSource();
  if (src) {
    const pano = await src.nearestPano(XIANGSHAN_VIEWPOINT, 80);
    if (pano) {
      const img = await src.streetView({ ...splashViewpoint(), panoId: pano.panoId, location: pano.location, date: pano.date });
      reference = { kind: "image", image: img };
      referenceDate = pano.date;
      console.log(`參考街景：${pano.panoId}（${pano.date ?? "日期不明"}）`);
    } else {
      console.log("象山山頂附近沒有街景，只用文字描述構圖。");
    }
  }

  const job = splashJob({ withReference: reference !== null, referenceDate });
  const parts: ResolvedPart[] = job.parts.map((p) => (p.kind === "text" ? p : reference!));
  const painter = painterFor(provider);
  console.log(`請 ${MODEL_PROFILES[provider].displayName} 作畫…`);
  const result = await painter.paint({ kind: job.kind, output: job.output, aspect: job.aspect, parts });
  if (result.output !== "image") fail("模型沒有回傳圖片");
  const cost = usageCostMicros(MODEL_PROFILES[provider].rates, result.usage);

  const { webp } = await normalizeImage(result.image, "16:9");
  const meta = await sharp(Buffer.from(webp)).metadata();
  const hash = createHash("sha256").update(webp).digest("hex").slice(0, 10);
  const dir = join(process.cwd(), "public", "splash");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.startsWith("xiangshan-")) rmSync(join(dir, f));
  const file = `xiangshan-${hash}.webp`;
  writeFileSync(join(dir, file), webp);

  const splash = {
    src: `/splash/${file}`,
    width: meta.width ?? 1536,
    height: meta.height ?? 864,
    focusX: 0.45,
    provider,
    model: result.model,
    paintedAt: new Date().toISOString(),
    bibleVersion: BIBLE_VERSION,
    referenceDate,
    license: "CC0-1.0" as const,
  };
  writeFileSync(
    join(process.cwd(), "lib", "splash.generated.ts"),
    [
      "/**",
      " * 由 `pnpm splash:paint` 產生 —— 不要手改。",
      " */",
      "",
      'import type { SplashImage } from "./splash";',
      "",
      `export const SPLASH: SplashImage | null = ${JSON.stringify(splash, null, 2)};`,
      "",
    ].join("\n"),
  );
  console.log(`✓ public/splash/${file}（${splash.width}×${splash.height}，約 US$${(cost / 1e6).toFixed(3)}）`);
  console.log("  請檢查畫面是否擬真，再提交 public/splash/ 與 lib/splash.generated.ts。");
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
