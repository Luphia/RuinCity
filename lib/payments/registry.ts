/**
 * 目前用哪一家金流。**伺服器專用。**
 *
 * `PAYMENTS=demo` → 示範金流。沒設 → 不收捐款（捐款按鈕會說明原因），
 * 而不是悄悄用示範金流 —— 「以為收到錢其實沒有」比「收不了錢」更糟。
 */

import "server-only";

import { demoPayments } from "./demo";
import type { PaymentProvider } from "./types";

export function paymentProvider(env: Record<string, string | undefined> = process.env): PaymentProvider | null {
  if (env.PAYMENTS === "demo") return demoPayments;
  return null;
}

export function paymentProviderById(id: string): PaymentProvider | null {
  return id === demoPayments.id ? demoPayments : null;
}

export function isDemoPayments(env: Record<string, string | undefined> = process.env): boolean {
  return env.PAYMENTS === "demo";
}
