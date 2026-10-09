/**
 * 長期保存 → 給畫面用的 JSON。**伺服器專用。**
 */

import "server-only";

import { RENDER_V1, type RenderSpec, type SceneLicense } from "@/lib/scene/format";
import { KUBO_ADD_FLAGS } from "@/lib/ipfs/pack";
import { weiToBolt } from "@/lib/swarm/quote";

import type { ArchiveInfo } from "./archive";

export interface ArchiveView {
  readonly sceneCid: string;
  readonly dealIndexCid: string;
  readonly status: "PACKED" | "STORED" | "DONE";
  readonly statusLabel: string;
  readonly sizeMb: string;
  readonly blockCount: number;
  readonly retainUntil: string;
  readonly lastError: string | null;
  /** 有任何一筆委託是示範模式 */
  readonly demo: boolean;
  readonly deals: readonly {
    readonly network: string;
    readonly status: "SUBMITTED" | "ACTIVE" | "FAILED";
    readonly dealId: string | null;
    readonly txHash: string;
    readonly epochs: number;
    readonly startEpoch: number | null;
    readonly endEpoch: number | null;
    readonly replicas: number;
    readonly openReplicas: number | null;
    readonly costBolt: string;
    readonly error: string | null;
  }[];
  /** 從網站下載整包（CAR） */
  readonly carUrl: string;
  /** 在網站上用包裡的檢視器開（與從 IPFS 開是同一批位元組） */
  readonly browseUrl: string;
  /** 從 Boltchain 閘道取回（委託索引的 CAR 含整包） */
  readonly gatewayCarUrls: readonly string[];
  readonly kuboCommand: string;
  /** 寫在場景包 scene.json 裡的授權（CC0） */
  readonly license: SceneLicense | null;
}

const STATUS_TEXT: Record<ArchiveView["status"], string> = {
  PACKED: "已打包，尚未送交保存",
  STORED: "保存中（Boltchain SwarmStorage）",
  DONE: "保存期滿",
};

export function toArchiveView(
  key: string,
  info: ArchiveInfo | null,
  gateways: readonly string[],
  license: SceneLicense | null,
): ArchiveView | null {
  if (!info) return null;
  const { archive: a, deals } = info;
  const live = deals.filter((d) => d.status !== "FAILED");
  return {
    sceneCid: a.sceneCid,
    dealIndexCid: a.dealIndexCid,
    status: a.status,
    statusLabel: STATUS_TEXT[a.status],
    sizeMb: (a.bytes / 1e6).toFixed(1),
    blockCount: a.blockCount,
    retainUntil: a.retainUntil.toISOString().slice(0, 10),
    lastError: a.lastError,
    demo: live.some((d) => d.network === "demo"),
    deals: deals.map((d) => ({
      network: d.network,
      status: d.status,
      dealId: d.dealId,
      txHash: d.txHash,
      epochs: d.epochs,
      startEpoch: d.startEpoch,
      endEpoch: d.endEpoch,
      replicas: d.replicas,
      // 真的委託建立時就抽好了副本，所以空清單 = 還沒讀到（示範模式永遠讀不到）
      openReplicas: d.slots && d.slots.length ? d.slots.filter((s) => s.open).length : null,
      costBolt: weiToBolt(BigInt(d.costWei), 6),
      error: d.error,
    })),
    carUrl: `/api/blocks/${key}/scene.car`,
    browseUrl: `/api/blocks/${key}/scene/index.html`,
    gatewayCarUrls: gateways.map((g) => `${g}/ipfs/${a.dealIndexCid}?format=car`),
    kuboCommand: `ipfs add -r --only-hash ${KUBO_ADD_FLAGS} <資料夾>`,
    license,
  };
}

export const DEFAULT_RENDER: RenderSpec = RENDER_V1;
