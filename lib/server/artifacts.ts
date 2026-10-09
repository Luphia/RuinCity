/**
 * 產出的圖：**區塊完成前一律不給。** 伺服器專用。
 *
 * 「地圖在完成前不能進入」不能只靠頁面不顯示 —— 圖的網址是猜得到的
 * （`/api/blocks/{key}/art/SCENE/3`），所以檢查放在**出圖的地方**，不在頁面上。
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { TxDb } from "@/lib/db/tx";

export const ARTIFACT_KINDS = ["SCENE", "TILE", "DSM", "TEXTURE"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function isArtifactKind(v: string): v is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(v);
}

export type ArtifactResult =
  | { readonly ok: true; readonly mime: string; readonly data: Uint8Array }
  | { readonly ok: false; readonly reason: "NOT_FOUND" | "NOT_COMPLETE" };

export async function readArtifact(
  db: TxDb,
  key: string,
  kind: ArtifactKind,
  kindIndex: number,
  size: "full" | "thumb",
): Promise<ArtifactResult> {
  const [row] = await db
    .select({
      completedAt: schema.blocks.completedAt,
      mime: schema.artifacts.mime,
      data: size === "full" ? schema.artifacts.data : schema.artifacts.thumb,
    })
    .from(schema.blocks)
    .leftJoin(
      schema.artifacts,
      and(
        eq(schema.artifacts.blockId, schema.blocks.id),
        eq(schema.artifacts.kind, kind),
        eq(schema.artifacts.kindIndex, kindIndex),
      ),
    )
    .where(eq(schema.blocks.key, key))
    .limit(1);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (!row.completedAt) return { ok: false, reason: "NOT_COMPLETE" };
  if (!row.data || !row.mime) return { ok: false, reason: "NOT_FOUND" };
  return { ok: true, mime: row.mime, data: new Uint8Array(row.data) };
}

export interface ArtifactIndexEntry {
  readonly kind: ArtifactKind;
  readonly kindIndex: number;
  readonly width: number;
  readonly height: number;
  readonly label: string | null;
}

/** 完成的區塊有哪些圖（不含位元組）。未完成回 null */
export async function listArtifacts(db: TxDb, key: string): Promise<ArtifactIndexEntry[] | null> {
  const [block] = await db
    .select({ id: schema.blocks.id, completedAt: schema.blocks.completedAt })
    .from(schema.blocks)
    .where(eq(schema.blocks.key, key));
  if (!block?.completedAt) return null;
  const rows = await db
    .select({
      kind: schema.artifacts.kind,
      kindIndex: schema.artifacts.kindIndex,
      width: schema.artifacts.width,
      height: schema.artifacts.height,
      label: schema.artifacts.label,
    })
    .from(schema.artifacts)
    .where(eq(schema.artifacts.blockId, block.id))
    .orderBy(schema.artifacts.kind, schema.artifacts.kindIndex);
  return rows.filter((r): r is ArtifactIndexEntry => isArtifactKind(r.kind));
}
