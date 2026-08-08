import { expect, test } from "@playwright/test";

/**
 * 地圖渲染的端對端檢查。
 *
 * 這裡驗不了「好不好看」，但驗得到 M1b 驗收條件裡真正會出事的那幾件：
 * 畫布有沒有真的畫出東西、sprite 數會不會隨縮放爆炸、手勢有沒有接上。
 */

test.describe("地圖", () => {
  test("畫布掛載，而且畫出的內容會隨相機改變", async ({ page }) => {
    await page.goto("/map");

    const canvas = page.getByTestId("map-canvas");
    await expect(canvas).toBeVisible();

    // 等 chunk 下載完並畫上去
    await expect(page.getByTestId("sprite-count")).toContainText("chunk", { timeout: 15_000 });
    await page.waitForTimeout(800);

    // ★ 為什麼比較兩張截圖，而不是直接讀 canvas 的像素：
    //   WebGL 預設 `preserveDrawingBuffer: false`，合成完就把 buffer 丟了，
    //   事後用 drawImage 讀回來一定是空的。開啟它會讓手機掉幀，
    //   不值得為了測試而付這個代價。
    //   「畫面會隨相機改變」能證明的事情是一樣的：空畫布不會變。
    const before = await canvas.screenshot();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 400);
    await page.waitForTimeout(800);
    const after = await canvas.screenshot();

    expect(before.byteLength).toBeGreaterThan(1000);
    expect(Buffer.compare(before, after)).not.toBe(0);
  });

  test("★ sprite 數在任何縮放層級都是有界的", async ({ page }) => {
    await page.goto("/map");
    await expect(page.getByTestId("sprite-count")).toContainText("chunk", { timeout: 15_000 });

    const readCount = async () => {
      const text = (await page.getByTestId("sprite-count").textContent()) ?? "";
      return Number(/sprite (\d+)/.exec(text)?.[1] ?? "0");
    };

    const canvas = page.getByTestId("map-canvas");
    const box = (await canvas.boundingBox())!;

    // 一路縮到最遠（L3 = 全圖 250,000 格都在畫面上）
    for (let i = 0; i < 12; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 400);
    }
    await expect(page.getByTestId("zoom-label")).toHaveText("戰略", { timeout: 5000 });
    await page.waitForTimeout(1200);

    // 全圖只有 64 個 chunk，加上三座遺跡 —— 絕不該是「一格一 sprite」的量級
    const atL3 = await readCount();
    expect(atL3).toBeGreaterThan(0);
    expect(atL3).toBeLessThan(200);

    // 放大回 L1
    for (let i = 0; i < 20; i++) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -400);
    }
    await expect(page.getByTestId("zoom-label")).toHaveText("局部", { timeout: 5000 });
    await page.waitForTimeout(1200);
    expect(await readCount()).toBeLessThan(200);
  });

  test("點擊格子會選取，而且座標落在地圖範圍內", async ({ page }) => {
    await page.goto("/map");
    await expect(page.getByTestId("sprite-count")).toContainText("chunk", { timeout: 15_000 });

    const box = (await page.getByTestId("map-canvas").boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3);
    await expect(page.getByTestId("selected-tile")).toContainText(",", { timeout: 5000 });

    const text = await page.getByTestId("selected-tile").textContent();
    const match = /\((\d+), (\d+)\)/.exec(text ?? "");
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(0);
    expect(Number(match![1])).toBeLessThan(500);
    expect(Number(match![2])).toBeLessThan(500);
  });

  test("縮放層級標籤跟著手勢切換", async ({ page }) => {
    await page.goto("/map");
    const label = page.getByTestId("zoom-label");
    await expect(label).toHaveText("區域", { timeout: 10_000 });

    const box = (await page.getByTestId("map-canvas").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -400);
    await expect(label).toHaveText("局部");
  });

  /**
   * ★ 離開地圖頁再回來。
   *
   * PixiJS 的 `app.destroy(true, …)` 會連 WebGL context 一起銷毀，而
   * context 綁在那個 `<canvas>` 元素上。只要「銷毀舊場景」與「建立新場景」
   * 碰到同一個 canvas，第二個場景拿到的就是一個已死的 context ——
   * 症狀是 `Could not retrieve shader source (WebGL context may be lost)`
   * 加上一串 `Attribute aPosition is not present in the shader`。
   *
   * 這個 case 走的是使用者每天都會走的路（切到別的分頁再切回來），
   * 而它會在 console 留下那組錯誤 —— 所以這裡連 console 一起看。
   */
  test("★ 離開再回來，畫布還是活的（WebGL context 沒被前一個場景帶走）", async ({ page }) => {
    const shaderErrors: string[] = [];
    page.on("console", (m) => {
      const t = m.text();
      if (/shader|context may be lost|not present in the shader/i.test(t)) shaderErrors.push(t);
    });

    for (let round = 0; round < 3; round++) {
      await page.goto("/map");
      await expect(page.getByTestId("sprite-count")).toContainText("chunk", { timeout: 15_000 });
      // 場景起不來時會出現這一格，而不是無限「載入中…」
      await expect(page.getByTestId("map-scene-error")).toHaveCount(0);
      // 每次掛載只會有一塊畫布 —— 多出來的代表舊的沒清掉
      expect(await page.locator("canvas").count()).toBe(1);
      await page.goto("/");
    }

    expect(shaderErrors, shaderErrors.join("\n")).toEqual([]);
  });
});

test("總覽 API 回傳三座遺跡與 600 個出生點", async ({ request }) => {
  const res = await request.get("/api/map/overview");
  expect(res.ok()).toBe(true);
  const json = await res.json();
  expect(json.ruins).toHaveLength(3);
  expect(json.spawns).toHaveLength(600);
  // chunk 網格由地圖尺寸推導（900×900 → 15×15），不寫死
  expect(json.chunk).toMatchObject({
    size: 64,
    cols: Math.ceil(json.width / 64),
    rows: Math.ceil(json.height / 64),
  });
  expect(json.width).toBe(900);
  // 公平性驗證的數字在封盤期要公開（`docs/13` §3）
  expect(json.fairness).toHaveLength(5);
  for (const check of json.fairness) expect(check.pass).toBe(true);
});
