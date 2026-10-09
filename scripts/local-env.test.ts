import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseEnv } from "./env-file";
import { ensureLocalEnv, newSecrets } from "./local-env";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ruincity-env-"));
  copyFileSync(".env.example", join(root, ".env.example"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const read = () => parseEnv(readFileSync(join(root, ".env.local"), "utf8"));

describe("密鑰隨機產生", () => {
  it("★ 每次都不同、長度足夠：AUTH_SECRET 32 位元組、CRON_SECRET 24 位元組", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const s = newSecrets();
      expect(Buffer.from(s.authSecret, "base64")).toHaveLength(32);
      expect(s.cronSecret).toMatch(/^[0-9a-f]{48}$/);
      seen.add(s.authSecret);
      seen.add(s.cronSecret);
    }
    expect(seen.size).toBe(100);
  });

  it("★ 沒有 .env.local：產生一份，兩個密鑰都是隨機值，權限 0600", () => {
    const r = ensureLocalEnv({ root });
    expect(r.created).toBe(true);
    const env = read();
    expect(env.get("AUTH_SECRET")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(env.get("CRON_SECRET")).toMatch(/^[0-9a-f]{48}$/);
    expect(statSync(join(root, ".env.local")).mode & 0o777).toBe(0o600);
    // 兩台機器（兩次產生）拿到的不同
    const other = mkdtempSync(join(tmpdir(), "ruincity-env-"));
    copyFileSync(".env.example", join(other, ".env.example"));
    ensureLocalEnv({ root: other });
    const env2 = parseEnv(readFileSync(join(other, ".env.local"), "utf8"));
    rmSync(other, { recursive: true, force: true });
    expect(env2.get("AUTH_SECRET")).not.toBe(env.get("AUTH_SECRET"));
    expect(env2.get("CRON_SECRET")).not.toBe(env.get("CRON_SECRET"));
  });

  it("★ 已經有的密鑰不換（換掉 AUTH_SECRET 會讓所有人被登出），空的才補", () => {
    writeFileSync(join(root, ".env.local"), 'AUTH_SECRET="existing"\nCRON_SECRET=""\n');
    ensureLocalEnv({ root });
    const first = read();
    expect(first.get("AUTH_SECRET")).toBe("existing");
    expect(first.get("CRON_SECRET")).toMatch(/^[0-9a-f]{48}$/);
    ensureLocalEnv({ root });
    expect(read().get("CRON_SECRET")).toBe(first.get("CRON_SECRET"));
  });

  it("--force：備份後重新產生，兩個密鑰都換新", () => {
    ensureLocalEnv({ root });
    const before = read();
    const r = ensureLocalEnv({ root, force: true });
    expect(r.backup).not.toBeNull();
    expect(read().get("AUTH_SECRET")).not.toBe(before.get("AUTH_SECRET"));
    expect(parseEnv(readFileSync(r.backup!, "utf8")).get("AUTH_SECRET")).toBe(before.get("AUTH_SECRET"));
  });
});
