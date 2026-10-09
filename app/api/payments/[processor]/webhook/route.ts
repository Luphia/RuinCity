/**
 * 金流商的付款通知。**入帳只認這裡**（驗簽之後）。
 * 入帳成功就在背景開工（`kickBlock`）。
 */

import { NextResponse } from "next/server";

import { withTransaction } from "@/lib/db/tx";
import { paymentProviderById } from "@/lib/payments/registry";
import { budgetConfig } from "@/lib/server/config";
import { confirmDonation, failDonation } from "@/lib/server/donations";
import { kickBlock } from "@/lib/server/kick";

export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ processor: string }> }) {
  const { processor } = await params;
  const provider = paymentProviderById(processor);
  if (!provider) return NextResponse.json({ error: "unknown processor" }, { status: 404 });
  const verified = await provider.verifyWebhook(req);
  if (!verified) return NextResponse.json({ error: "bad signature" }, { status: 400 });

  if (verified.status === "FAILED") {
    await withTransaction((tx) => failDonation(tx, provider.id, verified.processorRef));
    return NextResponse.json({ ok: true });
  }
  const r = await withTransaction((tx) =>
    confirmDonation(tx, {
      processor: provider.id,
      processorRef: verified.processorRef,
      amountTwd: verified.amountTwd,
      feeTwd: verified.feeTwd,
      now: Date.now(),
      config: budgetConfig(),
    }),
  );
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  if (!r.alreadyPaid) kickBlock(r.blockId);
  return NextResponse.json({ ok: true });
}
