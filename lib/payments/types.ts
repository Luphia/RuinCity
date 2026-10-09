/**
 * 金流商介面。
 *
 * ★ 目前只有**示範金流**（`demo.ts`）。真正的金流商要由營運方決定 ——
 *   台灣常見的有綠界（ECPay）、藍新（NewebPay）、TapPay；Stripe 的支援國家清單
 *   在撰寫時不含台灣（以其官方清單為準）。
 *   選定之後實作這個介面即可，其餘流程（入帳、拆帳、開工）不用改：
 *
 *   1. `createCheckout`：建立訂單，回傳要把捐款人導去的付款頁
 *   2. 金流商付款完成 → 打我們的 webhook（`/api/payments/[processor]/webhook`）
 *   3. `verifyWebhook`：驗簽、取出訂單編號與**實際手續費** → `confirmDonation`
 *
 * 「付款完成」**只認 webhook**，不認瀏覽器導回來的那一頁 ——
 * 導回頁可以被偽造，webhook 有簽章。
 */

export interface CheckoutRequest {
  readonly donationId: number;
  readonly amountTwd: number;
  /** 顯示在付款頁上的說明，例如「RuinCity 區塊 N25.03° E121.56°」 */
  readonly description: string;
  /** 付款完成後把捐款人導回哪裡（只是導回，不代表付款成功） */
  readonly returnUrl: string;
}

export interface CheckoutSession {
  readonly processorRef: string;
  readonly redirectUrl: string;
}

export interface VerifiedPayment {
  readonly processorRef: string;
  readonly status: "PAID" | "FAILED";
  /** 金流商回報的實際手續費（新台幣）。沒有就以設定的費率估 */
  readonly feeTwd?: number;
  /** 金流商回報的實際金額 —— 必須和訂單金額一致，否則拒收 */
  readonly amountTwd: number;
}

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** 驗證 webhook；簽章不對回 null */
  verifyWebhook(req: Request): Promise<VerifiedPayment | null>;
}
