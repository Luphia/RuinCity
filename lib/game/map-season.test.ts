import { describe, expect, it } from "vitest";

import { hasMap, pickMapSeason } from "./map-season";

const S0 = "s0";

describe("★ /map 要畫哪一場", () => {
  it("★ 我那一場優先 —— 就算下一場已經開放登記了", () => {
    // 這正是那個缺陷：第 7 天下一場開登記，s2 比較新但**沒有地圖**
    const seasons = [
      { id: 1, status: "RUNNING" },
      { id: 2, status: "REGISTRATION" },
    ];
    expect(pickMapSeason(null, { id: 1, status: "RUNNING" }, seasons, S0)).toBe("s1");
  });

  it("沒登入的訪客看最新的**有地圖**的一場，不看登記中的那一場", () => {
    const seasons = [
      { id: 1, status: "RUNNING" },
      { id: 2, status: "REGISTRATION" },
    ];
    expect(pickMapSeason(null, null, seasons, S0)).toBe("s1");
  });

  it("封盤中的賽季已經有地圖了（預覽本身就是內容）", () => {
    expect(pickMapSeason(null, null, [{ id: 5, status: "SEALED" }], S0)).toBe("s5");
    expect(hasMap("SEALED")).toBe(true);
    expect(hasMap("REGISTRATION")).toBe(false);
  });

  it("終戰期仍然看得到自己的地圖", () => {
    expect(pickMapSeason(null, { id: 3, status: "ENDING" }, [], S0)).toBe("s3");
  });

  it("出局／放棄的人（player 還在那一場）看的仍是那張圖", () => {
    // 判準是「在哪一場」，不是「還活著嗎」—— 廢墟也是他的廢墟
    expect(pickMapSeason(null, { id: 4, status: "RUNNING" }, [], S0)).toBe("s4");
  });

  it("只有登記中的賽季 → 退回開發地圖（而呼叫端要把 isFallback 講出來）", () => {
    expect(pickMapSeason(null, null, [{ id: 9, status: "REGISTRATION" }], S0)).toBe(S0);
  });

  it("明確指定就照做 —— 開發與除錯要看得到任何一場", () => {
    expect(pickMapSeason("s7", { id: 1, status: "RUNNING" }, [], S0)).toBe("s7");
  });

  it("多場有地圖時取最新的", () => {
    const seasons = [
      { id: 1, status: "ENDING" },
      { id: 2, status: "RUNNING" },
    ];
    expect(pickMapSeason(null, null, seasons, S0)).toBe("s2");
  });
});
