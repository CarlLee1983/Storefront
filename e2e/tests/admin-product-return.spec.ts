import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { analyzeWhenSettled } from "../harness/axe";
import { BASE_URL } from "../harness/constants";

const list = (page: Page) => page.getByRole("region", { name: "管理資料表" }).locator("tbody tr");

async function expectSameResults(page: Page, expected: string[], prefix: string, categoryId: string) {
  await expect(page.getByRole("textbox", { name: "搜尋商品名稱" })).toHaveValue(prefix);
  await expect(page.getByRole("combobox", { name: "分類" })).toHaveValue(categoryId);
  await expect(page.getByRole("combobox", { name: "商品狀態" })).toHaveValue("listed");
  await expect(page.getByRole("navigation", { name: "商品列表分頁" }).getByRole("link", { name: "2", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(list(page)).toHaveCount(2);
  const actual = await list(page).locator("td:nth-child(2) a").allTextContents();
  expect(actual).toEqual(expected);
}

test("商品編輯從篩選後第 2 頁返回原結果，無效來源使用預設列表", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const prefix = `商品返回${Date.now()}`;
  let ids: number[] = [];
  try {
    ids = await seedListedProducts(context, { slug: `return-products-${Date.now()}`, name: `${prefix}分類`, description: "商品列表返回測試" },
      Array.from({ length: 17 }, (_, index) => ({ name: `${prefix}${String(index).padStart(2, "0")}`, priceTwd: 100, stock: 1 })));
    await page.goto(`/admin/products/${ids[0]}`);
    const categoryId = await page.getByLabel("分類", { exact: true }).inputValue();
    await seedListedProducts(context, { slug: `return-excluded-${Date.now()}`, name: `${prefix}其他分類`, description: "不在篩選結果中" },
      [{ name: `${prefix}其他分類商品`, priceTwd: 100, stock: 1 }]);
    const unlisted = await context.request.post("/admin/products/new", {
      form: { name: `${prefix}未上架`, description: "不在篩選結果中", priceTwd: "100" },
      headers: { origin: BASE_URL }, maxRedirects: 0,
    });
    expect(unlisted.status()).toBe(303);
    const listUrl = `/admin/products?${new URLSearchParams({ q: prefix, status: "listed", category: categoryId, page: "2" })}`;

    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/admin/products");
      await page.getByRole("textbox", { name: "搜尋商品名稱" }).fill(prefix);
      await page.getByRole("combobox", { name: "分類" }).selectOption(categoryId);
      await page.getByRole("combobox", { name: "商品狀態" }).selectOption("listed");
      await page.getByRole("button", { name: "篩選" }).click();
      await expect(list(page)).toHaveCount(15);
      await page.getByRole("navigation", { name: "商品列表分頁" }).getByRole("link", { name: /下一頁/ }).click();
      await expect(list(page)).toHaveCount(2);
      const expected = await list(page).locator("td:nth-child(2) a").allTextContents();
      expect(expected.every(name => name.startsWith(prefix))).toBe(true);
      await expectSameResults(page, expected, prefix, categoryId);
      const first = list(page).first();
      const edit = first.getByRole("link", { name: "編輯", exact: true });
      await edit.click();
      const detailUrl = page.url();
      expect(new URL(detailUrl).searchParams.get("returnTo")).toBe(listUrl);
      const breadcrumb = page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "商品管理" });
      await expect(breadcrumb).toHaveAttribute("href", listUrl);
      await expect(page.getByRole("link", { name: "取消", exact: true })).toHaveAttribute("href", listUrl);
      await expect(page.getByRole("link", { name: "回商品管理" })).toHaveAttribute("href", listUrl);
      if (width === 375) await page.getByRole("button", { name: "開啟後台選單" }).click();
      await expect(page.getByRole("navigation", { name: "後台導覽" }).getByRole("link", { name: "商品管理" })).toHaveAttribute("aria-current", "page");
      if (width === 375) await page.keyboard.press("Escape");
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
      await page.screenshot({ path: `/tmp/storefront-product-return-${width}.png`, fullPage: true });
      await breadcrumb.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`${BASE_URL}${listUrl}`);
      await expectSameResults(page, expected, prefix, categoryId);

      await list(page).first().getByRole("link", { name: "編輯", exact: true }).click();
      await page.getByRole("link", { name: "取消", exact: true }).click();
      await expect(page).toHaveURL(`${BASE_URL}${listUrl}`);
      await expectSameResults(page, expected, prefix, categoryId);

      await list(page).first().getByRole("link", { name: "編輯", exact: true }).click();
      const basicForm = page.locator("form").filter({ has: page.getByRole("button", { name: "儲存變更" }) });
      await basicForm.getByLabel("原價（選填）").fill("1");
      await page.getByRole("button", { name: "儲存變更" }).click();
      await expect(page.getByRole("alert")).toBeVisible();
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(listUrl);
      await expect(basicForm.getByLabel("原價（選填）")).toHaveValue("1");
      await basicForm.getByLabel("原價（選填）").fill("");
      await page.locator('textarea[name="description"]').fill(`${prefix}已更新${width}`);
      await page.getByRole("button", { name: "儲存變更" }).click();
      await expect(page).toHaveURL(`${BASE_URL}${listUrl}&saved=updated`);
      await expect(page.getByRole("status")).toHaveText("已儲存商品。");
      await expectSameResults(page, expected, prefix, categoryId);

      await page.goto(listUrl);
      await list(page).first().getByRole("link", { name: "編輯", exact: true }).click();
      const options = page.getByRole("form", { name: "選項維度" });
      await options.getByLabel("選項維度 1 名稱").fill("顏色");
      await options.getByLabel("預設變體的選項值 1").fill("原色");
      await options.getByRole("button", { name: "套用選項維度" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已儲存選項與變體。" })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("returnTo")).toBe(listUrl);
      await expect(page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "商品管理" })).toHaveAttribute("href", listUrl);
      await page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "商品管理" }).click();
      await expectSameResults(page, expected, prefix, categoryId);
    }

    for (const returnTo of [null, "https://evil.example/admin/products", "/admin/orders?q=x", "//evil.example", "/admin/products?returnTo=%2Fadmin%2Forders"]) {
      const detail = `/admin/products/${ids[0]}${returnTo === null ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}`;
      await page.goto(detail);
      await expect(page.getByRole("navigation", { name: "麵包屑" }).getByRole("link", { name: "商品管理" })).toHaveAttribute("href", "/admin/products");
      await expect(page.getByRole("link", { name: "取消", exact: true })).toHaveAttribute("href", "/admin/products");
      await page.getByRole("button", { name: "儲存變更" }).click();
      await expect(page).toHaveURL(`${BASE_URL}/admin/products?saved=updated`);
    }
  } finally {
    if (ids.length) await unlistProductsByPrefix(context.request, prefix);
    await context.close();
  }
});
