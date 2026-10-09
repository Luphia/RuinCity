import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { serializeClient } from "./serial";

let dir: string;
let raw: Client;
let client: Client;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ruincity-serial-"));
  raw = createClient({ url: `file:${join(dir, "t.db")}`, timeout: 2_000 });
  client = serializeClient(raw, 300);
  await client.execute("PRAGMA journal_mode = WAL");
  await client.execute("create table t (n integer)");
});

afterAll(() => {
  raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("行程內的資料庫鎖", () => {
  it("★ 兩個交易同時開：排成先後，不會在 SQLite 的 busy handler 裡互相卡死", async () => {
    const run = async (n: number) => {
      const tx = await client.transaction("write");
      try {
        const { rows } = await tx.execute("select count(*) as c from t");
        await new Promise((r) => setTimeout(r, 20)); // 讓另一個交易有機會插隊
        await tx.execute({ sql: "insert into t (n) values (?)", args: [Number(rows[0]!.c) + n * 0] });
        await tx.commit();
      } catch (e) {
        await tx.rollback();
        throw e;
      }
    };
    await Promise.all([run(1), run(2), run(3)]);
    const { rows } = await client.execute("select n from t order by rowid");
    // 每個交易都讀到前一個提交後的計數 → 0, 1, 2（沒有兩個讀到同一個舊值）
    expect(rows.map((r) => Number(r.n))).toEqual([0, 1, 2]);
  });

  it("★ 交易裡用了交易外的連線：逾時後丟出講得出原因的錯誤，而不是永遠卡住", async () => {
    const tx = await client.transaction("write");
    await expect(client.execute("select 1")).rejects.toThrow(/交易的 callback 裡用了交易外的 db/);
    await tx.rollback();
    // 鎖放掉之後一切照常
    expect((await client.execute("select 1 as one")).rows[0]!.one).toBe(1);
  });
});
