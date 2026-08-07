/**
 * 選 driver：Neon 走 serverless，其餘一律走 node-postgres。
 *
 * ## ★ 為什麼需要選
 *
 * `@neondatabase/serverless` 不是「一個 Postgres client」，
 * 它是**專門對 Neon 端點說話**的 client —— 走 WebSocket / HTTP 到
 * Neon 的閘道，而不是 Postgres 的 TCP wire protocol。
 *
 * 所以把它指向 `127.0.0.1:5432` 上的一個正常 Postgres 會連不上，
 * 而且錯誤長得像網路問題（`ErrorEvent { type: 'error' }`），
 * 完全不會提示「你用錯 driver 了」。
 *
 * 本機開發用 docker 起一個 Postgres 是再正常不過的事，
 * 所以 URL 不是 Neon 的時候就換成 `pg` 的 TCP pool。
 * 兩邊都支援交易，`withTransaction` 的保證不變。
 *
 * ★ 選擇的依據是 **URL 的 host**，不是環境變數也不是 NODE_ENV ——
 *   「這個位址說哪一種協定」本來就只有 URL 知道。
 */

/** Vercel Postgres 底下就是 Neon */
const NEON_HOSTS = [/\.neon\.tech$/i, /\.vercel-storage\.com$/i];

export function isNeonUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return NEON_HOSTS.some((re) => re.test(host));
  } catch {
    // 解析不了就當成一般 Postgres —— 讓 pg 去給出真正的錯誤訊息
    return false;
  }
}
