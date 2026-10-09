import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { auth } from "@/auth";
import { schema } from "@/lib/db";
import { withTransaction } from "@/lib/db/tx";
import { demoPayments, demoSignature } from "@/lib/payments/demo";
import { isDemoPayments } from "@/lib/payments/registry";
import { budgetConfig } from "@/lib/server/config";
import { confirmDonation, failDonation } from "@/lib/server/donations";
import { kickBlock } from "@/lib/server/kick";
import { db } from "@/lib/server/runtime";

export const metadata = { title: "示範付款" };
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 示範金流的「付款頁」。
 *
 * ★ 按下按鈕走的是**和真的 webhook 同一條路**：組一個帶簽章的通知、
 *   交給 `demoPayments.verifyWebhook` 驗、再 `confirmDonation`。
 *   真的金流商接上來時，這一頁消失，其餘一行都不用改。
 */
export default async function DemoCheckout({ params }: { params: Promise<{ id: string }> }) {
  if (!isDemoPayments()) notFound();
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) redirect(`/signin?callbackUrl=/donate/demo/${id}`);

  const [d] = await db()
    .select({
      id: schema.donations.id,
      donorId: schema.donations.donorId,
      amountTwd: schema.donations.amountTwd,
      status: schema.donations.status,
      processorRef: schema.donations.processorRef,
      key: schema.blocks.key,
    })
    .from(schema.donations)
    .innerJoin(schema.blocks, eq(schema.blocks.id, schema.donations.blockId))
    .where(eq(schema.donations.id, Number(id)));
  if (!d || d.donorId !== session.user.id || !d.processorRef) notFound();

  async function settle(formData: FormData) {
    "use server";
    const outcome = formData.get("outcome") === "fail" ? "FAILED" : "PAID";
    const body = { processorRef: d!.processorRef!, amountTwd: d!.amountTwd, status: outcome, signature: demoSignature(d!.processorRef!, d!.amountTwd) };
    const verified = await demoPayments.verifyWebhook(new Request("http://demo/webhook", { method: "POST", body: JSON.stringify(body) }));
    if (!verified) throw new Error("示範簽章驗證失敗");
    if (verified.status === "FAILED") {
      await withTransaction((tx) => failDonation(tx, "demo", verified.processorRef));
    } else {
      const r = await withTransaction((tx) =>
        confirmDonation(tx, { processor: "demo", processorRef: verified.processorRef, amountTwd: verified.amountTwd, now: Date.now(), config: budgetConfig() }),
      );
      if (r.ok && !r.alreadyPaid) kickBlock(r.blockId);
    }
    redirect(`/b/${d!.key}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-col gap-4 px-6 py-12">
      <h1 className="text-xl font-bold">示範付款</h1>
      <p className="text-ash text-sm leading-relaxed">
        這是示範金流，<b className="text-parchment">不會實際收款</b>。按下「付款成功」會照真實流程入帳、拆帳，
        並立刻開始施工。
      </p>
      <dl className="border-ink-mid grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded border p-4 text-sm">
        <dt className="text-ash">區塊</dt>
        <dd>{d.key}</dd>
        <dt className="text-ash">金額</dt>
        <dd>NT${d.amountTwd.toLocaleString("en-US")}</dd>
        <dt className="text-ash">狀態</dt>
        <dd>{d.status}</dd>
      </dl>
      {d.status === "PENDING" ? (
        <form action={settle} className="flex gap-2">
          <button name="outcome" value="paid" data-testid="demo-pay" className="bg-rust text-ink flex-1 rounded px-4 py-2.5 font-bold">
            付款成功
          </button>
          <button name="outcome" value="fail" className="border-ink-mid text-ash rounded border px-4 py-2.5">
            付款失敗
          </button>
        </form>
      ) : (
        <a href={`/b/${d.key}`} className="text-rust underline">
          回到區塊
        </a>
      )}
    </main>
  );
}
