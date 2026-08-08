import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ★ 這條規則寫成測試，因為它靠讀碼守不住。
 *
 * 「我在哪一場賽季」在這個 app 裡被問了十次。十份實作各自有一組
 * 略微不同的條件，而它們遲早會對同一位玩家給出不同的答案 ——
 * 那不是假設，它已經發生過一次：**玩家的地圖畫的是另一場的世界**。
 *
 * 所以：只有 `current-player.ts` 可以用 email 解析出玩家，
 * 只有 `account.ts` 可以用 email 解析出帳號。任何新增的第三份實作
 * 都會在這裡被擋下來，而不是在某位玩家的地圖上。
 */

const ALLOWED = new Set(["lib/server/current-player.ts", "lib/server/account.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("★ 「我在哪一場」只能有一份實作", () => {
  it("沒有別的檔案用 email 去查玩家", () => {
    const root = process.cwd();
    const offenders = [...walk(join(root, "app")), ...walk(join(root, "lib"))]
      .map((f) => f.slice(root.length + 1))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => readFileSync(join(root, rel), "utf8").includes("schema.users.email"));

    expect(
      offenders,
      `這些檔案自己寫了一份身分／賽季解析，改用 lib/server/current-player.ts：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
