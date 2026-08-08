/**
 * 領土外框：一組格子的「對外邊」。純函式，渲染與測試共用。
 *
 * ★ 參照同類作品的畫法（docs/09 §12）：領土不是把格子塗滿 ——
 *   塗滿會蓋掉地形 —— 而是沿著**邊界**描一圈。
 *   演算法：每一格看四鄰，鄰居不在集合裡的那一側就是外框的一段。
 */

export interface TileXY {
  readonly x: number;
  readonly y: number;
}

export type EdgeSide = "N" | "S" | "E" | "W";

export interface OutlineEdge {
  readonly x: number;
  readonly y: number;
  readonly side: EdgeSide;
}

export function outlineEdges(tiles: readonly TileXY[]): OutlineEdge[] {
  const set = new Set(tiles.map((t) => `${t.x},${t.y}`));
  const out: OutlineEdge[] = [];
  for (const t of tiles) {
    if (!set.has(`${t.x},${t.y - 1}`)) out.push({ x: t.x, y: t.y, side: "N" });
    if (!set.has(`${t.x},${t.y + 1}`)) out.push({ x: t.x, y: t.y, side: "S" });
    if (!set.has(`${t.x - 1},${t.y}`)) out.push({ x: t.x, y: t.y, side: "W" });
    if (!set.has(`${t.x + 1},${t.y}`)) out.push({ x: t.x, y: t.y, side: "E" });
  }
  return out;
}

/** 一段外框在世界座標裡的兩個端點（格邊，不是格心） */
export function edgeSegment(e: OutlineEdge): readonly [number, number, number, number] {
  switch (e.side) {
    case "N":
      return [e.x, e.y, e.x + 1, e.y];
    case "S":
      return [e.x, e.y + 1, e.x + 1, e.y + 1];
    case "W":
      return [e.x, e.y, e.x, e.y + 1];
    case "E":
      return [e.x + 1, e.y, e.x + 1, e.y + 1];
  }
}
