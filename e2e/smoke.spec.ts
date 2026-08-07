import { expect, test } from "@playwright/test";

test.describe("M0 smoke", () => {
  test("首頁顯示 RuinCity 與當前廢曆日期", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { level: 1 })).toContainText("RuinCity");
    // 曆法純函式有跑起來 → 頁面上必然出現「廢曆 41 年 · N 月 N 日」
    await expect(page.getByText(/廢曆 41 年 · \d+ 月 \d+ 日/)).toBeVisible();
    // 示範賽季開打 4 天 → 遊戲月 5 → 夏季
    await expect(page.getByText("夏 · 焦土")).toBeVisible();
  });

  test("未登入時 /base 導向登入頁", async ({ page }) => {
    await page.goto("/base");
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("登入");
  });

  test("cron 端點在沒有 secret 的環境回應 ok", async ({ request }) => {
    const res = await request.get("/api/cron/settle");
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
