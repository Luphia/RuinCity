/**
 * 捐款入帳之後**立刻**開工，而不是等下一次排程。**伺服器專用。**
 *
 * 用 Next 的 `after()`：回應先送出去，施工在背景跑到時間上限
 * （`maxDuration`）。排程（`/api/cron/build`、`pnpm worker`）是安全網：
 * 這裡沒跑完的、伺服器重啟中斷的，下一輪會接著做 —— 租約保證不會兩邊同時畫同一塊。
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { after } from "next/server";

import { schema } from "@/lib/db";

import { runBlock } from "./builder";
import { builderDeps, db } from "./runtime";

/** 背景施工最多跑多久（要比路由的 maxDuration 短，留時間釋放租約） */
const KICK_BUDGET_MS = 50_000;

export function kickBlock(blockId: number) {
  after(async () => {
    try {
      const [b] = await db().select({ key: schema.blocks.key }).from(schema.blocks).where(eq(schema.blocks.id, blockId));
      if (!b) return;
      const deps = await builderDeps(`after-${randomUUID().slice(0, 8)}`);
      await runBlock(deps, b.key, Date.now() + KICK_BUDGET_MS);
    } catch (e) {
      // 排程會接手；這裡只要留下紀錄
      console.error("[kick] 背景施工失敗", e);
    }
  });
}
