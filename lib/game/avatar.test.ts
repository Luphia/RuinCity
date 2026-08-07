import { describe, expect, it } from "vitest";

import {
  AVATAR_PALETTE,
  AVATAR_SIZE,
  avatarParts,
  avatarSvg,
  renderAvatar,
  sanitiseStewardName,
  STEWARD_NAME_MAX,
} from "./avatar";

describe("執政官頭像", () => {
  it("32×32", () => {
    expect(renderAvatar(1)).toHaveLength(AVATAR_SIZE * AVATAR_SIZE);
  });

  it("★ 同一個 seed 永遠畫出同一張臉", () => {
    expect(renderAvatar(4242)).toEqual(renderAvatar(4242));
    expect(avatarParts(4242)).toEqual(avatarParts(4242));
  });

  it("★ 左右對稱 —— 隨機組合才會看起來像一張臉而不是雜訊", () => {
    const g = renderAvatar(7);
    // 眼睛、義眼、傷疤是刻意不對稱的，所以只檢查臉以外的列
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < AVATAR_SIZE / 2; x++) {
        expect(g[y * AVATAR_SIZE + x]).toBe(g[y * AVATAR_SIZE + (AVATAR_SIZE - 1 - x)]);
      }
    }
  });

  it("600 位執政官不會全長一樣", () => {
    const seen = new Set(
      Array.from({ length: 600 }, (_, i) => renderAvatar(i).join(",")),
    );
    // 432 種組合，600 個 seed —— 撞臉是必然的，但不能只有幾張
    expect(seen.size).toBeGreaterThan(100);
  });

  it("每一格都是合法的調色盤索引", () => {
    const g = renderAvatar(99);
    for (const v of g) expect(v).toBeLessThan(AVATAR_PALETTE.length);
  });

  it("畫得出東西 —— 不是一張空圖", () => {
    const g = renderAvatar(3);
    expect(g.filter((v) => v !== 0).length).toBeGreaterThan(200);
  });

  it("★ SVG 把同色的橫向連續格併成一個 rect", () => {
    const svg = avatarSvg(11);
    const rects = svg.match(/<rect/g)?.length ?? 0;
    expect(rects).toBeGreaterThan(0);
    // 沒合併的話會接近 1,024 個
    expect(rects).toBeLessThan(400);
    expect(svg).toContain("shape-rendering=\"crispEdges\"");
  });

  it("SVG 放大時仍然是整數座標（像素風不能有半格）", () => {
    const svg = avatarSvg(11, 4);
    expect(svg).toContain('width="128"');
    expect(svg).not.toMatch(/[xy]="\d+\.\d+"/);
  });
});

describe("重新命名", () => {
  it("去掉多餘空白", () => {
    expect(sanitiseStewardName("  灰   喉  ")).toBe("灰 喉");
  });

  it("空字串不算改名", () => {
    expect(sanitiseStewardName("   ")).toBeNull();
  });

  it("★ 用字元數截斷，不是 byte 數 —— 中文名字不能被砍成半個字", () => {
    const long = "灰喉灰喉灰喉灰喉灰喉灰喉灰喉";
    const out = sanitiseStewardName(long)!;
    expect([...out]).toHaveLength(STEWARD_NAME_MAX);
  });

  it("emoji 也算一個字元", () => {
    const out = sanitiseStewardName("🐟".repeat(20))!;
    expect([...out]).toHaveLength(STEWARD_NAME_MAX);
  });
});
