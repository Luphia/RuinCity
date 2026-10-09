import { config } from "dotenv";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";

/**
 * 端對端：世界地圖 → 區塊 → 捐款（示範金流）→ 施工 → 完工 → 進入。
 *
 * 需要一個真的 Postgres，並以示範模式啟動（CI 的 e2e job 有設定）：
 *   FAKE_PROVIDERS=1 PAYMENTS=demo MAP_STYLE_URL=/map-style-blank.json
 *
 * 登入不走 magic link（production build 不印連結）：直接在資料庫建一個 session，
 * 把 cookie 塞給瀏覽器 —— Auth.js 的 database session 本來就是這樣認人的。
 */

config({ path: ".env.local", quiet: true });

const DB = process.env.DATABASE_URL;

async function signIn(page: Page, who: string) {
  const db = new Client({ connectionString: DB });
  await db.connect();
  const id = `e2e-${who}-${Date.now()}`;
  await db.query("insert into auth_users (id, email, name) values ($1, $2, $3)", [id, `${id}@e2e.local`, who]);
  await db.query("insert into auth_sessions (session_token, user_id, expires) values ($1, $2, now() + interval '1 day')", [
    `tok-${id}`,
    id,
  ]);
  await db.end();
  await page.context().addCookies([{ name: "authjs.session-token", value: `tok-${id}`, url: "http://127.0.0.1:3100" }]);
}

/** 每次跑用不同的區塊，免得撞到上一次留下的資料 */
function freshKey(): string {
  const n = Math.floor(Math.random() * 400);
  return `${(-10 - Math.floor(n / 20) * 0.01).toFixed(2)}_${(-60 + (n % 20) * 0.01).toFixed(2)}`;
}

test.describe("世界地圖", () => {
  test("地圖畫得出格線，點一下就看得到那一塊", async ({ page }) => {
    await page.goto("/");
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
  test.skip(!DB, "需要 DATABASE_URL");
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

    // 整包下載：根就是畫面上的 CID
    const car = await request.get(`/api/blocks/${key}/scene.car`);
    expect(car.status()).toBe(200);
    expect(car.headers()["content-type"]).toContain("application/vnd.ipld.car");
    expect(car.headers()["x-ipfs-roots"]).toBe(sceneCid);

    // 在網站上用包裡的檢視器開：讀到 scene.json、雜湊驗證通過
    const viewer = await page.context().newPage();
    await viewer.goto(`/api/blocks/${key}/scene/index.html`);
    await expect(viewer.getByText(/全部 \d+ 個檔案的 SHA-256 都與 scene\.json 相符/)).toBeVisible({ timeout: 30_000 });
    await viewer.close();
  });

  test("沒有完成的塊拿不到場景包", async ({ request }) => {
    expect((await request.get(`/api/blocks/-45.67_12.34/scene.car`)).status()).toBe(404);
    expect((await request.get(`/api/blocks/-45.67_12.34/scene/index.html`)).status()).toBe(404);
    expect((await request.get(`/api/archive`)).status()).toBe(200);
  });
});
