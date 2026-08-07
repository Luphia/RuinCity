"use client";

import { useEffect, useState } from "react";

/**
 * 伺服器校正時鐘。倒數計時器都應該用這個，而不是 `Date.now()`。
 *
 * ★ 為什麼不能在 render 裡直接讀客戶端時鐘：
 *   1. 客戶端時鐘不可信（CLAUDE.md 第三條界線）——
 *      把系統時間往前調就能讓所有倒數瞬間歸零；
 *   2. React Compiler 的 purity 規則會擋下 render 中的不純函式，
 *      而那規則是對的：時間應該在邊界取一次，不是散在畫面各處。
 *
 * 做法照 `docs/07` §2.4：伺服器 render 時把 `serverTime` 帶下來，
 * 客戶端只在 effect 裡量「掛載之後過了多久」，兩者相加就是校正過的現在。
 * 客戶端時鐘的**絕對值**從頭到尾沒被信任，只用到它的**間隔**。
 *
 * 首次 render（含 SSR）回傳的就是 `serverTime` 本身，不會有 hydration 落差。
 *
 * ★ `Math.max` 不是防呆，是這個 hook 正確性的一部分：
 *   伺服器重新 render（例如做完一次升級）會給一個更新的 `serverTime`，
 *   但 `useState` 的初始值只在掛載時採用一次。取兩者較大值，
 *   新的伺服器時間能立刻生效，而且時間**只會向前**——
 *   不會因為換算誤差讓倒數往回跳。
 */
export function useServerClock(serverTime: number, intervalMs = 1000): number {
  const [ticked, setTicked] = useState(serverTime);

  useEffect(() => {
    // 只在 effect 內讀客戶端時鐘，而且只取它的「間隔」
    const start = Date.now();
    const id = setInterval(() => setTicked(serverTime + (Date.now() - start)), intervalMs);
    return () => clearInterval(id);
  }, [serverTime, intervalMs]);

  return Math.max(ticked, serverTime);
}
