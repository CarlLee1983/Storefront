import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL } from "../harness/constants";

async function assertNoOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const overflowing = await page.locator(".admin-categories, .admin-categories table, .admin-categories tbody, .admin-categories tr").evaluateAll((nodes) =>
    nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.tagName));
  expect(overflowing).toEqual([]);
}

async function assertControlSizes(page: Page) {
  for (const control of await page.locator('main a, main button, main input:not([type="hidden"])').all()) {
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.width, await control.evaluate((element) => element.outerHTML)).toBeGreaterThanOrEqual(44);
    expect(box.height, await control.evaluate((element) => element.outerHTML)).toBeGreaterThanOrEqual(44);
  }
}

for (const width of [375, 1280]) {
  test(`分類管理頁建立、列表與操作分隔（${width}px）`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width, height: 900 } });
    try {
      const page = await context.newPage();
      expect((await page.goto("/admin"))?.status()).toBe(200);
      await expect(page.getByLabel("分類名稱")).toHaveCount(0);
      const categoryNav = page.getByRole("navigation", { name: "後台導覽" }).getByRole("link", { name: "分類管理" });
      await categoryNav.click();
      await expect(page).toHaveURL(`${BASE_URL}/admin/categories`);
      await expect(categoryNav).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("heading", { name: "新增分類" })).toBeVisible();
      await assertNoOverflow(page, width);
      await assertControlSizes(page);

      const slug = `e2e-admin-categories-${width}-${Date.now()}`;
      const name = `分類列表${width}`;
      await page.getByLabel("分類名稱").fill(name);
      await page.getByLabel("分類說明").fill("分類管理版面測試");
      await page.getByLabel("網址代稱").fill(slug);
      await page.getByRole("button", { name: "建立分類" }).click();
      await expect(page).toHaveURL(`${BASE_URL}/admin/categories?saved=created`);
      await expect(page.getByRole("status")).toHaveText("已建立分類。");
      const table = page.getByRole("region", { name: "分類資料表" }).getByRole("table");
      await expect(table.getByRole("columnheader")).toHaveText(["圖片", "名稱", "代稱", "說明", "商品數", "上架商品數", "操作", "刪除"]);
      const row = table.getByRole("row", { name: new RegExp(slug) });
      await expect(row.getByRole("cell")).toHaveCount(8);
      await expect(row.locator('td[data-label="商品數"]')).toHaveText("0");
      await expect(row.locator('td[data-label="上架商品數"]')).toHaveText("0");
      const modify = row.getByRole("link", { name: `修改${name}（含圖片）` });
      const remove = row.getByRole("button", { name: `刪除${name}` });
      await expect(modify).toHaveAttribute("href", /\/admin\/categories\/\d+$/);
      await expect(modify).toBeVisible();
      await expect(remove).toBeVisible();
      const editBox = (await modify.boundingBox())!;
      const deleteBox = (await remove.boundingBox())!;
      if (width === 375) {
        expect(deleteBox.y - (editBox.y + editBox.height)).toBeGreaterThanOrEqual(8);
      } else {
        expect(deleteBox.x - (editBox.x + editBox.width)).toBeGreaterThanOrEqual(8);
      }
      await assertNoOverflow(page, width);
      await assertControlSizes(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("分類建立驗證保留輸入；未知動作與舊商品清單不能建立分類", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const slug = `e2e-category-validation-${Date.now()}`;
    const name = "分類驗證原名";
    const form = { intent: "create-category", categoryName: name, categoryDescription: "保留的說明", categorySlug: slug };
    const post = (path: string, submitted: Record<string, string>) => context.request.post(path, {
      form: submitted, headers: { origin: BASE_URL }, maxRedirects: 0,
    });
    const created = await post("/admin/categories", form);
    expect(created.status()).toBe(303);
    expect(created.headers().location).toBe("/admin/categories?saved=created");
    const duplicate = await post("/admin/categories", { ...form, categoryName: "重複分類名稱" });
    expect(duplicate.status()).toBe(200);
    const duplicateBody = await duplicate.text();
    expect(duplicateBody).toContain("這個代稱已被使用");
    expect(duplicateBody).toContain('value="重複分類名稱"');
    expect(duplicateBody).toContain('value="保留的說明"');
    expect(duplicateBody).toContain(`value="${slug}"`);
    const invalid = await post("/admin/categories", { ...form, categorySlug: "Bad Slug" });
    expect(invalid.status()).toBe(200);
    const invalidBody = await invalid.text();
    expect(invalidBody).toContain("代稱只能使用小寫英文");
    expect(invalidBody).toContain('value="Bad Slug"');
    expect(invalidBody).toContain(`value="${name}"`);
    for (const [path, submitted] of [
      ["/admin/categories", { ...form, intent: "unknown" }],
      ["/admin/categories", { categoryName: "缺少動作", categoryDescription: "說明", categorySlug: `${slug}-missing` }],
      ["/admin", { ...form, categoryName: "舊頁不應建立" }],
    ] as const) {
      expect((await post(path, submitted)).status(), path).toBe(400);
    }
    const page = await context.newPage();
    await page.goto("/admin/categories");
    await expect(page.getByRole("row", { name: new RegExp(slug) })).toHaveCount(1);
    await expect(page.getByText("重複分類名稱")).toHaveCount(0);
    await expect(page.getByText("舊頁不應建立")).toHaveCount(0);
    await expect(page.getByText("缺少動作")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("分類建立 GET 與 POST 都要求管理員身分", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { "Cf-Access-Jwt-Assertion": "invalid" } });
  try {
    expect((await context.request.get("/admin/categories")).status()).toBe(403);
    const denied = await context.request.post("/admin/categories", {
      form: { intent: "create-category", categoryName: "拒絕建立", categoryDescription: "說明", categorySlug: `e2e-denied-${Date.now()}` },
      headers: { origin: BASE_URL }, maxRedirects: 0,
    });
    expect(denied.status()).toBe(403);
  } finally {
    await context.close();
  }
});
