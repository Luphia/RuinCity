import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // /lib/game 是純函式，沒有 I/O，不需要 DOM
    environment: "node",
    include: ["lib/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["lib/game/**"],
      exclude: ["lib/game/**/*.test.ts", "lib/game/balance/**"],
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
