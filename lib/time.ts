/**
 * 時間權威。
 *
 * 所有時間以**伺服器 `now()`** 為準，客戶端時間完全不信任
 * （加速器、改系統時間都擋在這裡）。
 *
 * API 回應一律附帶 `serverTime`，客戶端計算
 * `offset = serverTime − clientTime` 並用它校正所有倒數計時器顯示。
 * 見 docs/07-tech-architecture.md §2.4。
 *
 * 包成 async 也有實務理由：`Date.now()` 是不純的，
 * 直接寫在 Server Component 的 render 裡會被 React Compiler 的
 * purity 規則擋下 —— 而那個規則是對的，時間本來就該從邊界取得一次。
 */
export async function serverNow(): Promise<number> {
  return Date.now();
}

/** 附加在所有 API 回應上，讓客戶端能校正時鐘 */
export async function withServerTime<T extends object>(
  payload: T,
): Promise<T & { serverTime: string }> {
  return { ...payload, serverTime: new Date(await serverNow()).toISOString() };
}
