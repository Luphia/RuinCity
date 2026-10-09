/**
 * `.env.local` 的產生與合併。純函式，無 I/O（`scripts/initial.ts` 負責讀寫檔案）。
 *
 * 規則：
 *   - 從 `.env.example` 產生：填入兩個隨機密鑰；`--demo` 時打開示範模式那兩行
 *   - 已經有 `.env.local`：**不動使用者填過的值**，只補上缺的密鑰與要求的示範設定
 *   - 已經不能用的舊設定（Postgres 的 DATABASE_URL）改成註解並說明，而不是刪掉 ——
 *     值留在檔案裡，使用者看得到發生了什麼
 */

export interface Secrets {
  readonly authSecret: string;
  readonly cronSecret: string;
}

export interface Change {
  readonly key: string;
  readonly action: "added" | "kept" | "commented";
  readonly note?: string;
}

const LINE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;

/** `"值" # 註解`、`'值'`、`值 # 註解` → 值 */
function unquote(v: string): string {
  const t = v.trim();
  const q = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(t);
  if (q) return q[2]!;
  return t.replace(/\s+#.*$/, "");
}

/** 檔案裡**生效中**的設定（註解掉的不算） */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) out.set(m[1]!, unquote(m[2]!));
  }
  return out;
}

const DEMO = ["FAKE_PROVIDERS=1", "PAYMENTS=demo"] as const;

/** 第一次：用範本產生 */
export function renderFromTemplate(template: string, secrets: Secrets, opts: { demo: boolean }): string {
  let s = template
    .replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET="${secrets.authSecret}"`)
    .replace(/^CRON_SECRET=.*$/m, `CRON_SECRET="${secrets.cronSecret}"`);
  if (opts.demo) for (const d of DEMO) s = s.replace(new RegExp(`^# ${d}$`, "m"), d);
  return s.endsWith("\n") ? s : `${s}\n`;
}

/** 已有 `.env.local`：補上缺的，不改使用者的值 */
export function mergeExisting(
  existing: string,
  secrets: Secrets,
  opts: { demo: boolean; today: string },
): { text: string; changes: Change[] } {
  const changes: Change[] = [];
  let lines = existing.split(/\r?\n/);
  if (lines.at(-1) === "") lines = lines.slice(0, -1);
  const current = parseEnv(existing);

  const set = (key: string, value: string, quoted = true) => {
    const v = quoted ? `"${value}"` : value;
    const i = lines.findIndex((l) => LINE.exec(l)?.[1] === key);
    if (i >= 0) lines[i] = `${key}=${v}`;
    else lines.push(`${key}=${v}`);
    changes.push({ key, action: "added" });
  };

  for (const [key, value] of [
    ["AUTH_SECRET", secrets.authSecret],
    ["CRON_SECRET", secrets.cronSecret],
  ] as const) {
    if (current.get(key)) changes.push({ key, action: "kept" });
    else set(key, value);
  }
  if (opts.demo) {
    if (current.get("FAKE_PROVIDERS") !== "1") set("FAKE_PROVIDERS", "1", false);
    if (current.get("PAYMENTS") !== "demo") set("PAYMENTS", "demo", false);
  }

  // 已經不能用的舊設定
  const db = current.get("DATABASE_URL");
  if (db && /^postgres(ql)?:\/\//i.test(db)) {
    const i = lines.findIndex((l) => LINE.exec(l)?.[1] === "DATABASE_URL");
    lines.splice(i, 1, `# ${opts.today} pnpm run initial：資料庫已改用 SQLite，Postgres 連線不再支援（舊值留在下一行）`, `# ${lines[i]}`);
    changes.push({ key: "DATABASE_URL", action: "commented", note: "Postgres 不再支援，改用預設的 ./data/ruincity.db" });
  }
  if (current.has("AUTH_URL")) {
    changes.push({
      key: "AUTH_URL",
      action: "kept",
      note: "不再需要（網址由請求推得）。留著的話，它必須與實際的埠一致，否則登入連結會導到錯的位址",
    });
  }

  return { text: `${lines.join("\n")}\n`, changes };
}
