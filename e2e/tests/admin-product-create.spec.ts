import { expect, test } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL } from "../harness/constants";
import { analyzeWhenSettled } from "../harness/axe";

for (const width of [375, 1280]) {
  test(`新增商品頁可操作且無障礙（${width}px）`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      expect((await page.goto("/admin"))?.status()).toBe(200);
      await expect(page.getByLabel("名稱", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "新增商品", exact: true })).toHaveCount(0);
      const createLink = page.getByRole("main").getByRole("link", { name: "新增商品", exact: true });
      await expect(createLink).toHaveAttribute("href", "/admin/products/new");
      await createLink.click();
      await expect(page).toHaveURL(`${BASE_URL}/admin/products/new`);
      await expect(page.getByRole("heading", { name: "新增商品" })).toBeVisible();
      if (width === 375) await page.getByRole("button", { name: "開啟後台選單" }).click();
      await expect(page.getByRole("navigation", { name: "後台導覽" }).getByRole("link", { name: "商品管理" })).toHaveAttribute("aria-current", "page");
      if (width === 375) await page.keyboard.press("Escape");
      await expect(page.getByRole("link", { name: "取消", exact: true })).toHaveAttribute("href", "/admin");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);

      const name = `新增頁${width}-${Date.now()}`;
      await page.getByLabel("名稱", { exact: true }).fill(name);
      await page.getByLabel("說明", { exact: true }).fill("從新增頁建立");
      await page.getByLabel("單價（新台幣整數元）").fill("680");
      await page.getByRole("button", { name: "新增商品", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`^${BASE_URL}/admin/products/\\d+\\?saved=created$`));
      await expect(page.getByRole("status").filter({ hasText: "已新增商品。" })).toHaveText("已新增商品。");
      await expect(page.getByLabel("名稱", { exact: true })).toHaveValue(name);
    } finally {
      await context.close();
    }
  });
}

test("新增商品驗證保留輸入，舊清單及未知動作不會建立商品", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const name = `無效新增-${Date.now()}`;
    const form = { name, description: "保留的說明", priceTwd: "0" };
    const invalid = await context.request.post("/admin/products/new", { form, headers: { origin: BASE_URL }, maxRedirects: 0 });
    expect(invalid.status()).toBe(200);
    const body = await invalid.text();
    expect(body).toContain(name);
    expect(body).toContain(form.description);
    expect(body).toContain('value="0"');

    for (const [path, submitted] of [
      ["/admin/products/new", { ...form, priceTwd: "680", intent: "unknown" }],
      ["/admin", { ...form, priceTwd: "680" }],
    ] as const) {
      const rejected = await context.request.post(path, { form: submitted, headers: { origin: BASE_URL }, maxRedirects: 0 });
      expect(rejected.status(), path).toBe(400);
    }
    const listing = await (await context.request.get(`/admin?q=${encodeURIComponent(name)}`)).text();
    expect(listing).toContain("沒有符合篩選條件的商品");
    expect(listing).not.toContain(`>${name}</a>`);
  } finally {
    await context.close();
  }
});

test("新增商品 GET 與 POST 都要求管理員身分", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": "invalid" } });
  try {
    expect((await context.request.get("/admin/products/new")).status()).toBe(403);
    const denied = await context.request.post("/admin/products/new", {
      form: { name: `拒絕新增-${Date.now()}`, description: "", priceTwd: "680" },
      headers: { origin: BASE_URL },
      maxRedirects: 0,
    });
    expect(denied.status()).toBe(403);
  } finally {
    await context.close();
  }
});
