import { describe, expect, it } from "vitest";

import { edgeSegment, outlineEdges } from "./territory";

describe("outlineEdges", () => {
  it("孤格：四邊都是外框", () => {
    expect(outlineEdges([{ x: 5, y: 5 }])).toHaveLength(4);
  });

  it("2×1 相鄰：共用邊不算，外框 6 段", () => {
    const edges = outlineEdges([
      { x: 5, y: 5 },
      { x: 6, y: 5 },
    ]);
    expect(edges).toHaveLength(6);
    // 兩格之間的那條邊（5 的 E、6 的 W）不存在
    expect(edges.find((e) => e.x === 5 && e.side === "E")).toBeUndefined();
    expect(edges.find((e) => e.x === 6 && e.side === "W")).toBeUndefined();
  });

  it("2×2 實心方塊：外框恰好 8 段，內部十字不算", () => {
    const edges = outlineEdges([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
    expect(edges).toHaveLength(8);
  });

  it("edgeSegment 給的是格邊，不是格心", () => {
    expect(edgeSegment({ x: 3, y: 7, side: "N" })).toEqual([3, 7, 4, 7]);
    expect(edgeSegment({ x: 3, y: 7, side: "S" })).toEqual([3, 8, 4, 8]);
    expect(edgeSegment({ x: 3, y: 7, side: "E" })).toEqual([4, 7, 4, 8]);
  });
});
