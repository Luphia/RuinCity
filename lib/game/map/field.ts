/**
 * 圓形鄰域統計。純函式，無 I/O。
 *
 * 公平性驗證要問「每位玩家半徑 R 內有幾格可建設 / 幾格高價值地形」。
 * 直接數是 250,000 格 × 1,257 格 = 3 億次，太慢；
 * 用每一列的前綴和，圓盤就退化成 2R+1 次區間查詢。
 */

import { MAP } from "../balance";
import { idx } from "./terrain";

export interface DiscField {
  readonly radius: number;
  /** 每格為圓心時，半徑內符合條件的格數 */
  readonly counts: Int32Array;
}

/**
 * 對一張 0/1 遮罩計算「以每格為圓心、半徑 R 的圓盤內有幾個 1」。
 *
 * 圓盤在地圖邊界會被裁掉 —— 這是刻意的：邊界外沒有格子，
 * 靠邊出生的人本來就少了可用空間，公平性檢查該看得到這件事。
 */
export function discCountField(mask: Uint8Array, radius: number): DiscField {
  const { width, height } = MAP;

  // rowPrefix[y][x] = 第 y 列前 x 格的累計（長度 width + 1）
  const stride = width + 1;
  const prefix = new Int32Array(height * stride);
  for (let y = 0; y < height; y++) {
    const base = y * stride;
    let acc = 0;
    for (let x = 0; x < width; x++) {
      acc += mask[idx(x, y, width)]!;
      prefix[base + x + 1] = acc;
    }
  }

  // 預先算好每個 dy 對應的水平半徑，避免內層開根號
  const spans = new Int32Array(2 * radius + 1);
  for (let dy = -radius; dy <= radius; dy++) {
    spans[dy + radius] = Math.floor(Math.sqrt(radius * radius - dy * dy));
  }

  const counts = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let total = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        const span = spans[dy + radius]!;
        const x0 = Math.max(0, x - span);
        const x1 = Math.min(width - 1, x + span);
        if (x1 < x0) continue;
        const base = yy * stride;
        total += prefix[base + x1 + 1]! - prefix[base + x0]!;
      }
      counts[idx(x, y, width)] = total;
    }
  }

  return { radius, counts };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
