/** 把我在這一塊的所有捐款改投某一家（或撤回） */

import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { withTransaction } from "@/lib/db/tx";
import { setMyVote } from "@/lib/server/donations";
import { enabledProviders } from "@/lib/providers/registry";
import { PROVIDER_ORDER, type ProviderId } from "@/lib/world/pricing";

const body = z.object({ vote: z.enum(PROVIDER_ORDER as unknown as [string, ...string[]]).nullable() });

const TEXT = {
  NOT_FOUND: "這一塊還沒有任何捐款。",
  BLOCK_COMPLETE: "這一塊已經完成，不能再改票。",
  PROVIDER_DISABLED: "這一家模型目前停用中。",
} as const;

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "請先登入" }, { status: 401 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "選項不正確" }, { status: 400 });
  const r = await withTransaction((tx) =>
    setMyVote(tx, {
      blockKey: key,
      donorId: session.user!.id!,
      vote: parsed.data.vote as ProviderId | null,
      enabled: enabledProviders(),
    }),
  );
  if (!r.ok) return NextResponse.json({ error: TEXT[r.reason] }, { status: 400 });
  return NextResponse.json({ changed: r.changed });
}
