/**
 * 載入 `.env.local` / `.env`。**要當作每支腳本的第一個 import。**
 *
 * ## ★ 為什麼是一個獨立的模組，而不是在腳本裡呼叫兩行
 *
 * 因為這樣寫是錯的：
 *
 *     import { config } from "dotenv";
 *     config({ path: ".env.local" });        // ← 看起來在前面
 *     import { getDb } from "../lib/db";     // ← 其實先跑
 *
 * import 會**先於**任何語句求值（ESM 如此，esbuild 轉出來的 CJS 也一樣把
 * require 提到最前面）。所以 `lib/db` 的模組本體會在 `config()` 之前執行，
 * 而它在模組載入時就建好連線物件 —— 拿到的是 placeholder。
 *
 * 症狀很難聯想到原因：`getaddrinfo ENOTFOUND unset.invalid`，
 * 而 `.env.local` 明明填得好好的。用 `withTransaction` 的地方碰巧沒事
 * （它是惰性的），只有走 `getDb()` 的會中 —— 於是同一支腳本裡
 * 一半的查詢正常、一半的查詢連到不存在的主機。
 *
 * 把載入放進一個 side-effect 模組，再讓它成為第一個 import，
 * 順序就由模組圖保證，不靠人記得。
 */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });
