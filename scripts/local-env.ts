/**
 * `.env.local` 的讀寫：產生、補上缺的密鑰。`pnpm run initial`、`pnpm dev`、`pnpm start` 共用。
 *
 * ★ AUTH_SECRET 與 CRON_SECRET **一律隨機產生**（crypto.randomBytes），不給預設值、不共用：
 *   每台機器、每次產生都不同。已經有值的不動 —— 換掉 AUTH_SECRET 會讓所有人被登出。
 */

import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mergeExisting, renderFromTemplate, type Change, type Secrets } from "./env-file";

/** AUTH_SECRET：32 位元組（base64）；CRON_SECRET：24 位元組（hex，放進 HTTP 標頭不必跳脫） */
export function newSecrets(): Secrets {
  return {
    authSecret: randomBytes(32).toString("base64"),
    cronSecret: randomBytes(24).toString("hex"),
  };
}

export const REQUIRED_SECRETS = ["AUTH_SECRET", "CRON_SECRET"] as const;

export interface EnsureResult {
  readonly path: string;
  readonly created: boolean;
  readonly backup: string | null;
  readonly changes: readonly Change[];
}

function write(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600); // 已存在的檔案 writeFileSync 不會改權限
}

export function ensureLocalEnv(opts: { root?: string; demo?: boolean; force?: boolean } = {}): EnsureResult {
  const root = opts.root ?? process.cwd();
  const path = join(root, ".env.local");
  const secrets = newSecrets();
  if (!existsSync(path) || opts.force) {
    let backup: string | null = null;
    if (existsSync(path)) {
      backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(path, backup);
    }
    write(path, renderFromTemplate(readFileSync(join(root, ".env.example"), "utf8"), secrets, { demo: !!opts.demo }));
    return {
      path,
      created: true,
      backup,
      changes: REQUIRED_SECRETS.map((key) => ({ key, action: "added" as const })),
    };
  }
  const { text, changes } = mergeExisting(readFileSync(path, "utf8"), secrets, {
    demo: !!opts.demo,
    today: new Date().toISOString().slice(0, 10),
  });
  write(path, text);
  return { path, created: false, backup: null, changes };
}

/**
 * `pnpm dev`／`pnpm start` 啟動前呼叫：密鑰缺了就補（隨機產生、寫進 .env.local、放進目前的環境）。
 * 兩個都已經有（來自 .env.local 或真的環境變數，例如 Docker、CI）就什麼都不做。
 * serverless 平台不寫檔 —— 那裡的密鑰要設在平台的環境變數裡。
 */
export function ensureSecretsForRun(log: (line: string) => void = console.log): void {
  if (REQUIRED_SECRETS.every((k) => process.env[k])) return;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY) return;
  const r = ensureLocalEnv();
  const text = readFileSync(r.path, "utf8");
  for (const key of REQUIRED_SECRETS) {
    const m = new RegExp(`^${key}="?([^"\\n]*)"?$`, "m").exec(text);
    if (m?.[1] && !process.env[key]) process.env[key] = m[1];
  }
  const added = r.changes.filter((c) => c.action === "added").map((c) => c.key);
  if (added.length) log(`${r.created ? "已產生 .env.local" : "已補上 .env.local"}：${added.join("、")} 隨機產生（之後沿用同一組）`);
}
