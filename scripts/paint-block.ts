import "./load-env";

/**
 * 管理員指令：不經捐款，直接把一塊畫起來。
 *
 *   pnpm block:paint 25.03_121.56                    報價 → 確認 → 撥款並施工到完成
 *   pnpm block:paint 25.03_121.56 --painter openai   指定由誰來畫（google 或 openai）
 *   pnpm block:paint 25.03_121.56 --yes              不問，直接開始
 *   pnpm block:paint 25.03_121.56 --resume           解除暫停再繼續（修好金鑰或提示詞之後）
 *   pnpm block:paint 25.03_121.56 --quote            只報價，不撥款
 *   pnpm block:paint 25.03_121.56 --port 5001        伺服器不在 5000 時（也可以用 --url）
 *
 * ★ 要先把網站跑起來（`pnpm dev` 或 `pnpm start`）。這支腳本只打管理員路由
 *   `/api/admin/blocks/<區塊>/paint`，施工邏輯只有一份，在 web 行程裡 —— 和 `pnpm worker` 同一個做法。
 * ★ 錢記成「平台撥款」，不是捐款：帳照算、預算書照列，區塊頁會寫出撥了多少。
 * ★ 沒有設 FAKE_PROVIDERS 時是**真的在花錢**（模型與 Google 地圖的費用，從你的 API 金鑰扣），所以先報價、再確認。
 */

import { createInterface } from "node:readline/promises";

import { MODEL_PROFILES, isPainterId } from "@/lib/world/pricing";

interface Report {
  key: string;
  status: string;
  statusLabel: string;
  done: number;
  total: number;
  next: string | null;
  pauseReason: string | null;
  painter: string | null;
  granted: string;
  grantNeeded: string;
  apiRemaining: string;
  apiSpent: string;
  fake: boolean;
  lastError: { step: string; code: string | null; message: string | null } | null;
  grantedNow?: string | null;
  resumed?: boolean;
  outcomes?: string[];
  error?: string;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function argValue(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

const hhmmss = () => new Date().toISOString().slice(11, 19);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const key = args.find((a, i) => !a.startsWith("--") && !["--painter", "--port", "--url"].includes(args[i - 1] ?? ""));
  if (!key) fail("要指定區塊，例如：pnpm block:paint 25.03_121.56");
  const painter = argValue(args, "--painter");
  if (painter !== null && !isPainterId(painter)) fail(`--painter 只能是 google 或 openai（收到 ${painter}）`);
  const port = argValue(args, "--port") ?? process.env.PORT ?? "5000";
  const base = (argValue(args, "--url") ?? process.env.WORKER_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!secret) fail("沒有 CRON_SECRET。先跑 pnpm run initial（或 pnpm dev）產生 .env.local");

  const url = `${base}/api/admin/blocks/${encodeURIComponent(key)}/paint`;
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

  const call = async (method: "GET" | "POST", body?: object): Promise<Report> => {
    let res: Response;
    try {
      const target = method === "GET" && painter ? `${url}?painter=${painter}` : url;
      res = await fetch(target, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch {
      fail(`連不上 ${base}。先把網站跑起來（pnpm dev 或 pnpm start），或用 --port／--url 指定位置`);
    }
    const json = (await res.json().catch(() => ({}))) as Report;
    if (res.status === 401) fail("CRON_SECRET 與伺服器的不一致（腳本讀的是這個資料夾的 .env.local）");
    if (res.status === 409) return { ...json, status: "COMPLETE" };
    if (!res.ok) fail(json.error ?? `HTTP ${res.status}`);
    return json;
  };

  // ── 報價 ──
  const q = await call("GET");
  console.log(`區塊 ${q.key} · ${q.statusLabel} · 進度 ${q.done} / ${q.total} 步`);
  if (q.status === "COMPLETE") {
    console.log(`✓ 已經完成了：${base}/b/${q.key}`);
    return;
  }
  console.log(`  需要撥款　　 ${q.grantNeeded}（平台撥款，不經金流；已撥 ${q.granted}）`);
  console.log(`  預計 API 費用 ${q.apiRemaining}（還沒做的步驟：模型 token ＋ 街景與地圖靜態圖）`);
  console.log(`  畫師　　　　 ${painter ? MODEL_PROFILES[painter].displayName : (q.painter ?? "平台預設")}`);
  if (q.pauseReason) {
    console.log(`  ⚠ 暫停中：${q.pauseReason}${args.includes("--resume") ? "（會解除暫停）" : "（加 --resume 解除）"}`);
    if (q.lastError) console.log(`    最近一次失敗：${q.lastError.step} · ${q.lastError.code} · ${q.lastError.message ?? "—"}`);
  }
  if (q.fake) console.log("  （示範模式：FAKE_PROVIDERS=1，畫的是示範圖，不花錢）");
  if (args.includes("--quote")) return;

  if (!args.includes("--yes") && !q.fake) {
    if (!process.stdin.isTTY) fail("會花真的錢。確認之後加 --yes 再執行");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question("確定撥款並開始繪製？[y/N] ")).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") fail("取消");
  }

  // ── 撥款 + 施工，直到完成 ──
  console.log("施工中（每一輪最多 45 秒，回報一次進度）…");
  let stuck = 0;
  let lastDone = q.done;
  let first = true;
  for (;;) {
    const r = await call("POST", { painter, resume: first && args.includes("--resume") });
    first = false;
    const extra = [r.grantedNow ? `撥款 ${r.grantedNow}` : null, r.resumed ? "已解除暫停" : null].filter(Boolean).join("、");
    console.log(
      `[${hhmmss()}] ${r.done} / ${r.total} 步 · ${r.statusLabel}${r.next ? ` · 下一步：${r.next}` : ""} · API 已花 ${r.apiSpent}${extra ? ` · ${extra}` : ""}`,
    );
    if (r.status === "COMPLETE") {
      console.log(`✓ 完成：${base}/b/${r.key}（場景包會在下一輪排程打包保存）`);
      return;
    }
    if (r.status === "PAUSED") {
      if (r.lastError) console.error(`  最近一次失敗：${r.lastError.step} · ${r.lastError.code} · ${r.lastError.message ?? "—"}`);
      fail(`施工暫停：${r.pauseReason ?? "連續失敗"}。處理之後加 --resume 再跑一次`);
    }
    if (r.outcomes?.includes("NO_PROVIDER")) fail("沒有可用的畫師：設定 GEMINI_API_KEY 或 OPENAI_API_KEY（或示範模式 FAKE_PROVIDERS=1）");
    if (r.outcomes?.at(-1) === "LOCKED") {
      // 排程（pnpm worker）正在畫這一塊：讓它畫，我們看著
      await sleep(5_000);
      continue;
    }
    if (r.done === lastDone) {
      if (++stuck >= 3) fail(`連續三輪沒有進度（${r.outcomes?.join("、") ?? "—"}）。看伺服器的輸出`);
      await sleep(3_000);
    } else {
      stuck = 0;
    }
    lastDone = r.done;
  }
}

await main();
