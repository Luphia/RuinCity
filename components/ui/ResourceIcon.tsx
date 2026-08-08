/**
 * 資源圖示。12×12 像素，程式生成（`lib/game/resource-icon.ts`）。
 *
 * ★ 圖示不是唯一的資訊來源：`title` 與 `aria-label` 帶著名字，
 *   所以讀螢幕器與滑鼠停留仍然講得出「糧食」。
 *
 * ★ SVG 只算一次（模組層級的快取）。這個元件在 HUD 上一次出現四個、
 *   在戰報裡可能出現幾十個，而形狀是常數 —— 每次 render 重算純粹是浪費。
 */

import {
  RESOURCE_KINDS,
  RESOURCE_NAME,
  resourceIconSvg,
  type ResourceKind,
} from "@/lib/game/resource-icon";

const CACHE = new Map<string, string>();

function svgOf(kind: ResourceKind, pixelSize: number): string {
  const key = `${kind}:${pixelSize}`;
  let hit = CACHE.get(key);
  if (!hit) {
    hit = resourceIconSvg(kind, pixelSize);
    CACHE.set(key, hit);
  }
  return hit;
}

export interface ResourceIconProps {
  readonly kind: ResourceKind;
  /** 一個像素畫成幾 px。1 → 12px 見方，2 → 24px */
  readonly size?: number;
  readonly className?: string;
}

export function ResourceIcon({ kind, size = 1, className }: ResourceIconProps) {
  return (
    <span
      title={RESOURCE_NAME[kind]}
      aria-label={RESOURCE_NAME[kind]}
      role="img"
      className={`inline-block shrink-0 align-middle ${className ?? ""}`}
      style={{ width: 12 * size, height: 12 * size, lineHeight: 0 }}
      dangerouslySetInnerHTML={{ __html: svgOf(kind, size) }}
    />
  );
}

export interface ResourceAmountsProps {
  /** 只畫大於 0 的項目 */
  readonly amounts: Partial<Record<ResourceKind, number>>;
  readonly size?: number;
  readonly className?: string;
  /** 全部都是 0 時要不要畫點東西 */
  readonly emptyLabel?: string;
}

/**
 * 一串「圖示 + 數字」。成本、掠奪、轉移全部走這裡 ——
 * 這種列表以前是 `糧120 木80` 這樣的字串，在窄螢幕上會斷成沒有意義的碎片。
 */
export function ResourceAmounts({
  amounts,
  size = 1,
  className,
  emptyLabel,
}: ResourceAmountsProps) {
  const rows = RESOURCE_KINDS.filter((k) => (amounts[k] ?? 0) > 0);
  if (rows.length === 0) return emptyLabel ? <span className={className}>{emptyLabel}</span> : null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 ${className ?? ""}`}>
      {rows.map((k) => (
        <span key={k} className="inline-flex items-center gap-0.5 tabular-nums">
          <ResourceIcon kind={k} size={size} />
          {Math.round(amounts[k] ?? 0).toLocaleString()}
        </span>
      ))}
    </span>
  );
}
