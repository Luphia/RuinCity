import { config } from "dotenv";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";

/**
 * 端對端：世界地圖 → 區塊 → 捐款（示範金流）→ 施工 → 完工 → 進入。
 *
 * 需要以示範模式啟動（CI 的 e2e job 有設定）；資料庫是與 app 同一個 SQLite 檔：
 *   FAKE_PROVIDERS=1 PAYMENTS=demo MAP_STYLE_URL=/map-style-blank.json
 *
 * 登入不走 magic link（production build 不印連結）：直接在資料庫建一個 session，
 * 把 cookie 塞給瀏覽器 —— Auth.js 的 database session 本來就是這樣認人的。
 */

config({ path: ".env.local", quiet: true });

/** 與 app 同一個資料庫（沒設就是 app 的預設檔） */
const DB = process.env.DATABASE_URL || "file:./data/ruincity.db";

async function signIn(page: Page, who: string) {
  const db = createClient({ url: DB, authToken: process.env.DATABASE_AUTH_TOKEN || undefined, timeout: 10_000 });
  const id = `e2e-${who}-${Date.now()}`;
  await db.execute({ sql: "insert into auth_users (id, email, name) values (?, ?, ?)", args: [id, `${id}@e2e.local`, who] });
  // 時間是毫秒整數（schema 的 timestamp_ms）
  await db.execute({
    sql: "insert into auth_sessions (session_token, user_id, expires) values (?, ?, ?)",
    args: [`tok-${id}`, id, Date.now() + 86_400_000],
  });
  db.close();
  await page.context().addCookies([{ name: "authjs.session-token", value: `tok-${id}`, url: "http://127.0.0.1:3100" }]);
}

/** 每次跑用不同的區塊，免得撞到上一次留下的資料 */
function freshKey(): string {
  const n = Math.floor(Math.random() * 400);
  return `${(-10 - Math.floor(n / 20) * 0.01).toFixed(2)}_${(-60 + (n % 20) * 0.01).toFixed(2)}`;
}

test.describe("世界地圖", () => {
  test("開場畫面：按「進入城市」進到世界地圖", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("splash")).toBeVisible();
    await expect(page.getByRole("heading", { name: "RuinCity" })).toBeVisible();
    await page.getByTestId("enter-city").click();
    await page.waitForURL(/\/world$/);
    await expect(page.getByTestId("world-map").locator("canvas")).toBeVisible({ timeout: 15_000 });
  });

  test("地圖畫得出格線，點一下就看得到那一塊", async ({ page }) => {
    await page.goto("/world");
    await expect(page.getByTestId("demo-banner")).toBeVisible();
    const map = page.getByTestId("world-map");
    await expect(map.locator("canvas")).toBeVisible({ timeout: 15_000 });
    const box = (await map.boundingBox())!;
    expect(box.height).toBeGreaterThan(300);
    await page.waitForTimeout(1500);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId("block-popup")).toContainText("N25.03° E121.56°");
  });

  test("怎麼運作：列出每一項經費", async ({ page }) => {
    await page.goto("/about");
    for (const t of ["金流手續費", "保存", "稅金與規費", "材質", "3D 圖資", "依捐款金額投票", "畫面必須擬真"]) {
      await expect(page.getByText(t).first()).toBeVisible();
    }
  });
});

test.describe("一塊地圖的一生", () => {
  test.setTimeout(300_000);

  test("★ 捐款 → 施工中只有數字 → 投票翻盤換模型 → 完工後才能進入", async ({ page, request }) => {
    const key = freshKey();
    await signIn(page, "donor");
    await page.goto(`/b/${key}`);
    await expect(page.getByTestId("status")).toHaveText("尚無捐款");
    for (const m of ["meter-tokens-needed", "meter-money-needed", "meter-tokens-spent", "meter-money-spent"]) {
      await expect(page.getByTestId(m)).toBeVisible();
    }
    await expect(page.getByTestId("budget-sheet")).toContainText("標記座標場景圖 ×100");

    // 捐款，投 Google
    await page.getByTestId("donate-amount").fill("300");
    await page.getByTestId("donate-vote").selectOption("google");
    await page.getByTestId("donate-submit").click();
    await page.waitForURL(/\/donate\/demo\//);
    await page.getByTestId("demo-pay").click();
    await page.waitForURL(new RegExp(`/b/${key}`));

    // 施工中：圖拿不到
    await expect(page.getByTestId("status")).toHaveText(/建設中|募款中/);
    const blocked = await request.get(`/api/blocks/${key}/art/TILE/0`);
    expect(blocked.status()).toBe(403);
    await expect(page.getByTestId("meter-tokens-spent")).not.toHaveText("0", { timeout: 60_000 });

    // 再捐一筆投 OpenAI，票數翻盤
    await page.getByTestId("donate-amount").fill("1500");
    await page.getByTestId("donate-vote").selectOption("openai");
    await page.getByTestId("donate-submit").click();
    await page.waitForURL(/\/donate\/demo\//);
    await page.getByTestId("demo-pay").click();
    await page.waitForURL(new RegExp(`/b/${key}`));
    await expect(page.getByTestId("vote-panel")).toContainText("目前領先");
    // 擬真：Claude 不在投票選項裡，只當勘查員
    await expect(page.getByTestId("donate-vote").locator("option[value=anthropic]")).toHaveCount(0);
    await expect(page.getByTestId("vote-note")).toContainText("Claude");

    // 等完工（背景施工 + worker）
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/blocks/${key}`);
          return ((await res.json()) as { view: { status: string } }).view.status;
        },
        { timeout: 240_000, intervals: [3000] },
      )
      .toBe("COMPLETE");

    await page.goto(`/b/${key}`);
    await expect(page.getByTestId("status")).toHaveText("已完成");
    await expect(page.getByTestId("tile-image")).toBeVisible();

    // 漫遊：第三人稱走進這一塊；從第一個標記座標出發，按「查看」看 AI 在那裡畫的景象
    await page.getByTestId("walk-start").click();
    await expect(page.getByTestId("walk-mode")).toBeVisible();
    await expect(page.getByTestId("walk-position")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("walk-joystick")).toBeVisible(); // 手機：觸控搖桿
    await page.getByTestId("walk-interact").click();
    await expect(page.getByTestId("walk-scene")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("walk-scene")).toBeHidden();
    await page.getByTestId("walk-close").click();
    await expect(page.getByTestId("walk-mode")).toBeHidden();
    const art = await request.get(`/api/blocks/${key}/art/TILE/0`);
    expect(art.status()).toBe(200);
    expect(art.headers()["content-type"]).toBe("image/webp");

    // 兩家都畫過：Google 在翻盤前、OpenAI 在翻盤後
    const data = (await (await request.get(`/api/blocks/${key}`)).json()) as {
      view: { completed: { credits: { provider: string }[] } };
    };
    const credited = data.view.completed.credits.map((c) => c.provider).join(" ");
    expect(credited).toContain("Gemini");
    expect(credited).toContain("GPT Image");

    // 永久保存：下一輪排程打包成場景包、交給（示範的）SwarmStorage
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/blocks/${key}`);
          return ((await res.json()) as { archive: { status: string } | null }).archive?.status ?? "NONE";
        },
        { timeout: 90_000, intervals: [3000] },
      )
      .toBe("STORED");
    await page.reload();
    await expect(page.getByTestId("archive-panel")).toBeVisible();
    await expect(page.getByTestId("archive-status")).toContainText("示範模式");
    const sceneCid = (await page.getByTestId("scene-cid").textContent())!.trim();
    expect(sceneCid).toMatch(/^bafy/);
    await expect(page.getByTestId("archive-deals")).toContainText("3 個副本");
    await expect(page.getByTestId("scene-license")).toContainText("CC0 1.0");

    // 整包下載：根就是畫面上的 CID
    const car = await request.get(`/api/blocks/${key}/scene.car`);
    expect(car.status()).toBe(200);
    expect(car.headers()["content-type"]).toContain("application/vnd.ipld.car");
    expect(car.headers()["x-ipfs-roots"]).toBe(sceneCid);

    // 在網站上用包裡的檢視器開：讀到 scene.json、雜湊驗證通過
    const viewer = await page.context().newPage();
    await viewer.goto(`/api/blocks/${key}/scene/index.html`);
    await expect(viewer.getByText(/全部 \d+ 個檔案的 SHA-256 都與 scene\.json 相符/)).toBeVisible({ timeout: 30_000 });
    const manifest = (await (await request.get(`/api/blocks/${key}/scene/scene.json`)).json()) as { license: { id: string } };
    expect(manifest.license.id).toBe("CC0-1.0");
    await viewer.close();
  });

  test("沒有完成的塊拿不到場景包", async ({ request }) => {
    expect((await request.get(`/api/blocks/-45.67_12.34/scene.car`)).status()).toBe(404);
    expect((await request.get(`/api/blocks/-45.67_12.34/scene/index.html`)).status()).toBe(404);
    expect((await request.get(`/api/archive`)).status()).toBe(200);
  });
});
