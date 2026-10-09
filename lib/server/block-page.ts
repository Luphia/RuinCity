/**
 * 區塊頁的資料：狀態 + 產出清單 + 我的捐款。**伺服器專用。**
 * 區塊頁（server component）與輪詢用的 API 共用這一份。
 */

import "server-only";

import type { RenderSpec } from "@/lib/scene/format";
import { swarmGateways } from "@/lib/swarm/registry";
import { parseBlockKey } from "@/lib/world/grid";

import { archiveOf, frozenRender } from "./archive";
import { DEFAULT_RENDER, toArchiveView, type ArchiveView } from "./archive-view";
import { listArtifacts } from "./artifacts";
import { loadBlockState, deriveState } from "./blocks";
import { myDonations, type MyDonation } from "./donations";
import { db, stateDeps } from "./runtime";
import { toBlockView, type BlockView } from "./view";

export interface BlockPageData {
  readonly view: BlockView;
  readonly mine: readonly MyDonation[];
  readonly serverTime: number;
  /** 完成的塊才有：場景包與 SwarmStorage 的保存狀態 */
  readonly archive: ArchiveView | null;
  /** 3D 的渲染規格（凍結在場景包裡的那一份） */
  readonly render: RenderSpec;
}

export async function getBlockPage(key: string, viewerId: string | null): Promise<BlockPageData | null> {
  const id = parseBlockKey(key);
  if (!id) return null;
  const deps = await stateDeps();
  const now = Date.now();
  const state = (await loadBlockState(db(), key, now, deps)) ?? deriveState(id, null, [], [], now, deps);
  const artifacts = state.status === "COMPLETE" ? await listArtifacts(db(), key) : null;
  const view = toBlockView(state, {
    twdPerUsd: deps.config.twdPerUsd,
    enabled: deps.enabled,
    estimates: state.estimates,
    artifacts,
  });
  const mine = viewerId ? await myDonations(db(), viewerId, key) : [];
  const blockId = state.row?.id ?? null;
  const done = state.status === "COMPLETE" && blockId !== null;
  const archive = done ? toArchiveView(key, await archiveOf(db(), blockId), swarmGateways()) : null;
  const render = done ? await frozenRender(db(), blockId) : DEFAULT_RENDER;
  return { view, mine, serverTime: now, archive, render };
}
