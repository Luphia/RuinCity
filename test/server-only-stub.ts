/**
 * `server-only` 在 Vitest 下的替身。
 *
 * 真正的 `server-only` 套件是 Next.js 的建置期哨兵 —— 它讓
 * 「伺服器模組被 client component import 了」變成一個編譯錯誤。
 * 那個保護在 `next build` 時仍然完整生效；這裡只是讓
 * `lib/server/*` 的整合測試在 Node 下 import 得進來。
 */
export {};
