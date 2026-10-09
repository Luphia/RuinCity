/**
 * 建立一筆捐款 → 導去金流商的付款頁。
 *
 * 這裡**不入帳**：入帳只認金流商的 webhook（`/api/payments/[processor]/webhook`）。
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { withTransaction } from "@/lib/db/tx";
import { paymentProvider } from "@/lib/payments/registry";
import { budgetConfig } from "@/lib/server/config";
import { REJECTION_TEXT, attachProcessorRef, createDonation } from "@/lib/server/donations";
import { enabledProviders } from "@/lib/providers/registry";
import { blockShortLabel, parseBlockKey } from "@/lib/world/grid";
import { PAINTERS } from "@/lib/world/pricing";

const body = z.object({
  amountTwd: z.number().int(),
  vote: z.enum(PAINTERS as unknown as [string, ...string[]]).nullable(),
  wish: z.string().max(500).nullable().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "請先登入" }, { status: 401 });

  const provider = paymentProvider();
  if (!provider) {
    return NextResponse.json(
      { error: "金流尚未設定 —— 目前無法收款。營運方設定金流商之後即可捐款。" },
      { status: 503 },
    );
  }
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "金額或選項不正確" }, { status: 400 });
  const block = parseBlockKey(key);
  if (!block) return NextResponse.json({ error: REJECTION_TEXT.BAD_BLOCK }, { status: 404 });

  const created = await withTransaction((tx) =>
    createDonation(tx, {
      blockKey: key,
      donorId: session.user!.id!,
      amountTwd: parsed.data.amountTwd,
      vote: (parsed.data.vote as (typeof PAINTERS)[number] | null) ?? null,
      wish: parsed.data.wish ?? null,
      processor: provider.id,
      enabled: enabledProviders(),
      config: budgetConfig(),
    }),
  );
  if (!created.ok) return NextResponse.json({ error: REJECTION_TEXT[created.reason] }, { status: 400 });

  const origin = new URL(req.url).origin;
  const checkout = await provider.createCheckout({
    donationId: created.donationId,
    amountTwd: parsed.data.amountTwd,
    description: `RuinCity 區塊 ${blockShortLabel(block)}`,
    returnUrl: `${origin}/b/${key}`,
  });
  await withTransaction((tx) => attachProcessorRef(tx, created.donationId, checkout.processorRef));
  return NextResponse.json({ redirectUrl: checkout.redirectUrl });
}
