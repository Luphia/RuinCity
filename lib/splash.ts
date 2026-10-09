/**
 * 開場畫面：從象山俯視荒廢的臺北 101。
 *
 * 圖由 `pnpm splash:paint` 用與區塊相同的正典、擬真規格與畫師畫出來，
 * 存成 `public/splash/` 裡的一張 WebP，資訊寫進 `splash.generated.ts`（一起提交）。
 * 還沒畫之前 `SPLASH` 是 null，開場畫面只有標題與按鈕 —— 不拿任何非擬真的圖頂替。
 */

export interface SplashImage {
  /** `/splash/xiangshan-<雜湊>.webp`：內容變了網址就變，可以長期快取 */
  readonly src: string;
  readonly width: number;
  readonly height: number;
  /** 101 在畫面中的水平位置（0–1）。直式螢幕裁切時以它為中心，塔才不會被切掉 */
  readonly focusX: number;
  readonly provider: string;
  readonly model: string;
  readonly paintedAt: string;
  readonly bibleVersion: string;
  /** 構圖參考的街景拍攝年月；沒有參考時為 null */
  readonly referenceDate: string | null;
  readonly license: "CC0-1.0";
}

export { SPLASH } from "./splash.generated";
