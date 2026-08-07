import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // /lib/game 是純函式，沒有 I/O，不需要 DOM
    environment: "node",
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    /**
     * `*.integration.test.ts` 會開一個 WASM Postgres 並跑完全部 migration。
     * 第一次啟動大約 10–20 秒，所以 hook 的 timeout 要放寬。
     */
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      include: ["lib/game/**"],
      exclude: ["lib/game/**/*.test.ts", "lib/game/balance/**"],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
      /**
       * ★ `server-only` 是 Next.js 的建置期哨兵：它讓「這個模組被
       *   client component import 了」變成一個編譯錯誤。
       *   Vitest 不是 Next.js 的 bundler，解析不到那個套件 ——
       *   但整合測試要測的正是這些檔案。
       *   指到一個空模組即可：哨兵在 `next build` 時仍然有效。
       */
      "server-only": fileURLToPath(new URL("./test/server-only-stub.ts", import.meta.url)),
    },
  },
});
