import { describe, expect, it } from "vitest";

import { mergeExisting, parseEnv, renderFromTemplate } from "./env-file";

const secrets = { authSecret: "A".repeat(44), cronSecret: "c".repeat(48) };
const today = "2026-10-10";

describe(".env.local 的產生", () => {
  it("★ 從範本產生：兩個密鑰填好，其餘選填的維持註解", () => {
    const tpl = 'AUTH_SECRET=""\nCRON_SECRET=""\n# GEMINI_API_KEY=""\n# FAKE_PROVIDERS=1\n# PAYMENTS=demo\n';
    const out = renderFromTemplate(tpl, secrets, { demo: false });
    const env = parseEnv(out);
    expect(env.get("AUTH_SECRET")).toBe(secrets.authSecret);
    expect(env.get("CRON_SECRET")).toBe(secrets.cronSecret);
    expect(env.has("GEMINI_API_KEY")).toBe(false);
    expect(env.has("FAKE_PROVIDERS")).toBe(false);
    const demo = parseEnv(renderFromTemplate(tpl, secrets, { demo: true }));
    expect(demo.get("FAKE_PROVIDERS")).toBe("1");
    expect(demo.get("PAYMENTS")).toBe("demo");
  });

  it("★ 真正的 .env.example 產生出來，生效中的只有兩個密鑰", async () => {
    const { readFileSync } = await import("node:fs");
    const env = parseEnv(renderFromTemplate(readFileSync(".env.example", "utf8"), secrets, { demo: false }));
    expect([...env.keys()].sort()).toEqual(["AUTH_SECRET", "CRON_SECRET"]);
  });

  it("★ 已有檔案：不改使用者填過的值，只補缺的密鑰", () => {
    const existing = 'AUTH_SECRET="mine"\nGEMINI_API_KEY="g-key" # 我的\nCRON_SECRET=""\n';
    const { text, changes } = mergeExisting(existing, secrets, { demo: false, today });
    const env = parseEnv(text);
    expect(env.get("AUTH_SECRET")).toBe("mine");
    expect(env.get("GEMINI_API_KEY")).toBe("g-key");
    expect(env.get("CRON_SECRET")).toBe(secrets.cronSecret);
    expect(changes).toContainEqual({ key: "AUTH_SECRET", action: "kept" });
    expect(changes).toContainEqual({ key: "CRON_SECRET", action: "added" });
    expect(text).toContain('GEMINI_API_KEY="g-key" # 我的'); // 原樣保留，連註解都在
  });

  it("★ 舊的 Postgres 連線改為註解（值留著），AUTH_URL 保留但提醒", () => {
    const existing = 'DATABASE_URL="postgresql://u:p@host.neon.tech/db"\nAUTH_URL="http://localhost:5000"\n';
    const { text, changes } = mergeExisting(existing, secrets, { demo: true, today });
    const env = parseEnv(text);
    expect(env.has("DATABASE_URL")).toBe(false);
    expect(text).toContain('# DATABASE_URL="postgresql://u:p@host.neon.tech/db"');
    expect(env.get("AUTH_URL")).toBe("http://localhost:5000");
    expect(env.get("FAKE_PROVIDERS")).toBe("1");
    expect(env.get("PAYMENTS")).toBe("demo");
    expect(changes.find((c) => c.key === "DATABASE_URL")?.action).toBe("commented");
    expect(changes.find((c) => c.key === "AUTH_URL")?.note).toMatch(/不再需要/);
  });
});
