import { describe, expect, it } from "vitest";

import { explainDbError, missingRelation } from "./diagnose";

describe("missingRelation：42P01 藏在 cause 鏈深處也要找得到", () => {
  it("drizzle 的包裝：外層 Failed query、內層才是 Postgres 錯誤", () => {
    const pg = Object.assign(new Error('relation "terrain_files" does not exist'), {
      code: "42P01",
    });
    const wrapped = Object.assign(
      new Error('Failed query: select count(*) from "terrain_files" …'),
      { cause: pg },
    );
    expect(missingRelation(wrapped)).toBe("terrain_files");
  });

  it("只有 code 沒有訊息也算（回 ?）", () => {
    expect(missingRelation(Object.assign(new Error("boom"), { code: "42P01" }))).toBe("?");
  });

  it("其他錯誤回 null，explain 保留原訊息", () => {
    const e = new Error("connection refused");
    expect(missingRelation(e)).toBeNull();
    expect(explainDbError(e)).toBe("connection refused");
  });

  it("explain 給的是能照做的下一步", () => {
    const pg = Object.assign(new Error('relation "terrain_files" does not exist'), {
      code: "42P01",
    });
    expect(explainDbError(Object.assign(new Error("Failed query"), { cause: pg }))).toContain(
      "pnpm db:migrate",
    );
  });

  it("cause 成環不會無窮迴圈", () => {
    const a = new Error("a");
    (a as { cause?: unknown }).cause = a;
    expect(missingRelation(a)).toBeNull();
  });
});
