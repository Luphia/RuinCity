/**
 * 開場畫面的即時數字：整個世界蓋到哪裡了。**伺服器專用。**
 */

import "server-only";

import { and, count, countDistinct, eq, inArray, isNotNull, isNull, ne, sum } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";
import { GRANT_PROCESSOR } from "@/lib/world/ledger";

export interface WorldStats {
  /** 已完成、可以進入的塊 */
  readonly completed: number;
  /** 有人捐過、還沒完成的塊（募款中或建設中） */
  readonly underway: number;
  /** 已入帳的捐款總額（微美元，扣手續費前；不含平台撥款） */
  readonly raisedMicros: number;
  /** 捐款人數（不含平台） */
  readonly donors: number;
  /** 交給 SwarmStorage 保存中（或保存期滿）的場景包 */
  readonly archived: number;
}

export async function worldStats(db: TxDb): Promise<WorldStats> {
  const [[done], [open], [money], [arch]] = await Promise.all([
    db.select({ n: count() }).from(schema.blocks).where(isNotNull(schema.blocks.completedAt)),
    db
      .select({ n: countDistinct(schema.blocks.id) })
      .from(schema.blocks)
      .innerJoin(schema.donations, and(eq(schema.donations.blockId, schema.blocks.id), eq(schema.donations.status, "PAID")))
      .where(isNull(schema.blocks.completedAt)),
    db
      .select({ gross: sum(schema.donations.grossMicros), donors: countDistinct(schema.donations.donorId) })
      .from(schema.donations)
      .where(and(eq(schema.donations.status, "PAID"), ne(schema.donations.processor, GRANT_PROCESSOR))),
    db
      .select({ n: count() })
      .from(schema.sceneArchives)
      .where(inArray(schema.sceneArchives.status, ["STORED", "DONE"])),
  ]);
  return {
    completed: done?.n ?? 0,
    underway: open?.n ?? 0,
    raisedMicros: Number(money?.gross ?? 0),
    donors: money?.donors ?? 0,
    archived: arch?.n ?? 0,
  };
}
