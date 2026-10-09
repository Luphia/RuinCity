/**
 * 示範金流：**不收任何錢**，按一個按鈕就當作付款成功。
 *
 * 只在 `PAYMENTS=demo` 時啟用（本機開發、E2E、展示）。
 * 介面與真的金流商相同 —— 付款頁、webhook、驗簽一個都沒少，
 * 只是「簽章」是伺服器自己的 HMAC，付款頁是我們自己的一頁。
 * 這樣真的金流商接上來時，走的是已經被測過的同一條路。
 *
 * ★ 正式環境若誤開 `PAYMENTS=demo`，任何人都能免費灌捐款、灌票。
 *   所以畫面上會一直掛著「示範模式，未實際收款」的橫幅（`app/layout.tsx`）。
 */

import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { CheckoutRequest, CheckoutSession, PaymentProvider, VerifiedPayment } from "./types";

function secret(): string {
  return process.env.AUTH_SECRET || "ruincity-demo-payments";
}

export function demoSignature(processorRef: string, amountTwd: number): string {
  return createHmac("sha256", secret()).update(`${processorRef}:${amountTwd}`).digest("hex");
}

export const demoPayments: PaymentProvider = {
  id: "demo",
  label: "示範金流（不實際收款）",

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const processorRef = `demo-${req.donationId}`;
    return { processorRef, redirectUrl: `/donate/demo/${req.donationId}` };
  },

  async verifyWebhook(req: Request): Promise<VerifiedPayment | null> {
    const body = (await req.json().catch(() => null)) as {
      processorRef?: unknown;
      amountTwd?: unknown;
      signature?: unknown;
      status?: unknown;
    } | null;
    if (!body || typeof body.processorRef !== "string" || typeof body.amountTwd !== "number") return null;
    if (typeof body.signature !== "string") return null;
    const expected = Buffer.from(demoSignature(body.processorRef, body.amountTwd), "hex");
    const given = Buffer.from(body.signature, "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return {
      processorRef: body.processorRef,
      amountTwd: body.amountTwd,
      status: body.status === "FAILED" ? "FAILED" : "PAID",
    };
  },
};
