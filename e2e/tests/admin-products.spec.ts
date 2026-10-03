import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { featureProducts, seedListedProducts, unlistProductsByPrefix } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { loadCatalog } from "../seed/catalog";
import { gotoProductList } from "../harness/admin-list";

const PREFIX = "桌機示範";
const LONG_NAME = "桌機長名稱精心挑選的手工實木落地燈與閱讀角落家具以及可以長久使用的居家陳設";

function geometry(row: Locator) {
  return row.locator("td").evaluateAll(cells => cells.map(cell => {
    const box = cell.getBoundingClientRect();
    return { x: box.x, width: box.width, height: box.height };
  }));
}

test("桌機商品表格容納 32 件商品，操作與庫存錯誤維持可用版面", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 1280, height: 900 } });
  const admin = await context.newPage();
  try {
    const catalog = loadCatalog();
    expect(catalog.products).toHaveLength(32);
    const ids = new Map<string, number>();
    for (const category of catalog.categories) {
      const group = catalog.products.filter(product => product.category === category.slug);
      const seeded = await seedListedProducts(context, { slug: `admin-products-${category.slug}`, name: category.name, description: category.blurb }, [
        ...group.map(product => ({ name: `${PREFIX}${product.name}`, priceTwd: product.priceTwd, stock: product.onHand })),
        ...(category === catalog.categories[0] ? [{ name: LONG_NAME, priceTwd: 1200, stock: 20 }] : []),
      ]);
      group.forEach((product, index) => ids.set(product.name, seeded[index]!));
      if (category === catalog.categories[0]) ids.set(LONG_NAME, seeded.at(-1)!);
    }
    const [featuredId] = await seedListedProducts(context, { slug: "admin-products-sibling", name: "後台外殼1280", description: "共用後台頁面測試" }, [
      { name: "桌機相鄰精選商品", priceTwd: 1200, stock: 5 },
    ]);
    await featureProducts(context.request, [featuredId!]);
    const unlisted = await context.request.post("/admin/products/new", {
      form: { name: "桌機尚未上架商品", description: "待上傳封面", priceTwd: "1200" },
      headers: { origin: BASE_URL }, maxRedirects: 0,
    });
    expect(unlisted.status()).toBe(303);
    await admin.goto(`/admin/products/${ids.get(LONG_NAME)}`);
    await admin.locator('textarea[name="description"]').fill("這段商品說明刻意寫得很長，商品清單只需要決策欄位，不應讓說明文字撐高每一列。".repeat(4));
    await admin.getByRole("button", { name: "儲存變更", exact: true }).click();
    await expect(admin).toHaveURL(/\/admin\?saved=updated/);
    const saleProduct = catalog.products.find(product => product.compareAtPriceTwd !== null)!;
    await admin.goto(`/admin/products/${ids.get(saleProduct.name)}`);
    await admin.getByLabel("原價（選填）").fill(String(saleProduct.compareAtPriceTwd));
    await admin.getByRole("button", { name: "儲存變更", exact: true }).click();
    await expect(admin).toHaveURL(/\/admin\?saved=updated/);

    const table = admin.getByRole("region", { name: "管理資料表" });
    // 清單每頁 15 筆：32 件商品分成 15、15、2 三頁，並有分頁導覽
    await gotoProductList(admin, PREFIX);
    await expect(table.locator("thead th")).toHaveText(["封面", "商品名稱", "分類", "售價", "原價", "在庫", "不可售", "保留", "可售", "狀態", "精選", "操作"]);
    await expect(table.locator("tbody tr")).toHaveCount(15);
    const firstPage = await table.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(firstPage.scrollWidth, `第 1 頁（15 列）width=${firstPage.width} scrollWidth=${firstPage.scrollWidth}`).toBeLessThanOrEqual(firstPage.width);
    await expect(admin.getByRole("navigation", { name: "商品列表分頁" })).toBeVisible();
    await admin.goto(`/admin?q=${encodeURIComponent(PREFIX)}&page=3`);
    await expect(table.locator("tbody tr")).toHaveCount(2);

    const saleName = `${PREFIX}${saleProduct.name}`;
    await gotoProductList(admin, saleName);
    const saleRow = table.getByRole("row", { name: new RegExp(saleName) });
    await expect(saleRow.locator("td").nth(3)).toHaveText(`NT$ ${saleProduct.priceTwd.toLocaleString("en-US")}`);
    await expect(saleRow.locator("td").nth(4)).toHaveText(`NT$ ${saleProduct.compareAtPriceTwd!.toLocaleString("en-US")}`);
    const otherName = `${PREFIX}${catalog.products[0]!.name}`;
    await gotoProductList(admin, otherName);
    const other = table.getByRole("row", { name: new RegExp(otherName) });
    await expect(other.locator("td").nth(4)).toHaveText("—");
    const otherCells = await geometry(other);

    await gotoProductList(admin, LONG_NAME);
    const row = table.getByRole("row", { name: new RegExp(LONG_NAME) });
    await expect(row.locator("td").nth(0).getByRole("img", { name: `${LONG_NAME}的封面` })).toBeVisible();
    await expect(row.locator("td").nth(2)).toHaveText(catalog.categories[0]!.name);
    await expect(row.locator("td").nth(3)).toHaveText("NT$ 1,200");
    await expect(row.locator("td").nth(4)).toHaveText("—");
    await expect(row.locator("td").nth(5)).toHaveText("20");
    await expect(row.locator("td").nth(6)).toHaveText("0");
    await expect(row.locator("td").nth(7)).toHaveText("0");
    await expect(row.locator("td").nth(8)).toHaveText("20");
    await expect(row.locator("td").nth(9)).toHaveText("上架中");
    await expect(row.locator("td").nth(1)).toHaveText(LONG_NAME);
    await expect(table).not.toContainText("這段商品說明");

    const layout = await table.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
    expect(layout.scrollWidth, `product table width=${layout.width} scrollWidth=${layout.scrollWidth}`).toBeLessThanOrEqual(layout.width);
    expect(await admin.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280);
    await testInfo.attach("admin-products-1280", { body: await admin.screenshot({ fullPage: true }), contentType: "image/png" });
    const cells = await geometry(row);
    // 長名稱換行呈現（不截斷）：連結高度超過單行；而且說明文字不會撐高列，列高不超過操作欄（兩排控制項）的高度
    expect((await row.locator(".product-title-link").boundingBox())!.height).toBeGreaterThan(44);
    expect(cells[1]!.height).toBeLessThanOrEqual(otherCells[1]!.height);
    for (const index of [3, 4, 5, 6, 7, 8]) {
      const alignment = await row.locator("td").nth(index).evaluate(cell => ({ align: getComputedStyle(cell).textAlign, numbers: getComputedStyle(cell).fontVariantNumeric }));
      expect(alignment).toEqual({ align: "right", numbers: "tabular-nums" });
    }

    const actions = [row.getByRole("link", { name: "編輯" }), row.getByRole("button", { name: "下架", exact: true }), row.getByLabel(`${LONG_NAME}的庫存增減量`), row.getByRole("button", { name: "調整庫存" })];
    const boxes = await Promise.all(actions.map(control => control.boundingBox()));
    for (const box of boxes) { expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44); }
    // 操作欄可換行：相鄰控制項之間不論橫向或縱向都要留 8px
    for (let index = 1; index < boxes.length; index++) {
      const previous = boxes[index - 1]!, current = boxes[index]!;
      expect(Math.max(current.x - (previous.x + previous.width), current.y - (previous.y + previous.height))).toBeGreaterThanOrEqual(8);
    }
    const input = actions[2]!;
    await expect(input).toHaveAttribute("placeholder", "±增減");
    expect(await input.evaluate(element => {
      const input = element as HTMLInputElement;
      const style = getComputedStyle(input);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      context.font = style.font;
      return input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - context.measureText(input.placeholder).width;
    })).toBeGreaterThanOrEqual(0);

    const before = await geometry(row);
    await input.fill("0");
    await row.getByLabel(`${LONG_NAME}的庫存調整原因`).fill("E2E 補貨");
    await actions[3]!.click();
    await expect(admin.getByRole("alert")).toContainText("增減量");
    await expect(row.getByLabel(`${LONG_NAME}的庫存增減量`)).toHaveAttribute("aria-describedby", "listing-error");
    const after = await geometry(row);
    expect(after).toEqual(before);
    expect((await table.evaluate(element => element.scrollWidth))).toBeLessThanOrEqual(layout.width);
  } finally {
    await unlistProductsByPrefix(context.request, PREFIX);
    await unlistProductsByPrefix(context.request, "桌機長名稱");
    await unlistProductsByPrefix(context.request, "桌機相鄰");
    await context.close();
  }
});

test("手機商品卡片可完成庫存、上下架與精選操作，768px 回到表格", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 375, height: 900 } });
  const admin = await context.newPage();
  const name = `手機卡片${LONG_NAME}`;
  const card = admin.getByRole("region", { name: "管理資料表" }).locator("tbody tr").filter({ hasText: name });
  try {
    await seedListedProducts(context, { slug: "admin-products-mobile", name: "手機卡片分類", description: "手機商品管理卡片測試" }, [
      { name, priceTwd: 1200, stock: 5 },
    ]);
    await gotoProductList(admin, name);
    await expect(card).toBeVisible();
    await expect(card.locator("td").nth(0).getByRole("img", { name: `${name}的封面` })).toBeVisible();
    await expect(card.locator("td").nth(3)).toHaveText("NT$ 1,200");
    await expect(card.locator("td").nth(8)).toHaveText("5");
    await expect(card.locator("td").nth(9)).toHaveText("上架中");
    await expect(card.locator("td").nth(10)).toContainText("設為精選");
    const region = admin.getByRole("region", { name: "管理資料表" });
    const mobileLayout = await region.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, rowDisplay: getComputedStyle(element.querySelector("tbody tr")!).display }));
    expect(mobileLayout.rowDisplay).toBe("grid");
    expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.width);
    expect(await admin.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const controls = card.locator('a, button, input:not([type="hidden"])');
    const boxes = await controls.evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      expect(Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0).toBe(false);
    }
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await admin.screenshot({ path: "/tmp/storefront-admin-products-375.png", fullPage: true });

    await card.getByLabel(`${name}的庫存增減量`).fill("+3");
    await card.getByLabel(`${name}的庫存調整原因`).fill("E2E 補貨");
    await card.getByRole("button", { name: "調整庫存" }).click();
    await expect(admin).toHaveURL(/saved=stock/);
    await expect(card.locator("td").nth(8)).toHaveText("8");
    await card.getByRole("button", { name: `標為精選：${name}` }).click();
    await expect(admin).toHaveURL(/saved=feature/);
    await expect(card.locator("td").nth(10)).toContainText("精選");
    await card.getByRole("button", { name: `取消精選：${name}` }).click();
    await expect(admin).toHaveURL(/saved=unfeature/);
    await card.getByRole("button", { name: "下架", exact: true }).click();
    await expect(admin).toHaveURL(/saved=unlist/);
    await expect(card.locator("td").nth(9)).toHaveText("已下架");
    await card.getByRole("button", { name: "重新上架" }).click();
    await expect(admin).toHaveURL(/saved=relist/);
    await expect(card.locator("td").nth(9)).toHaveText("上架中");

    await admin.setViewportSize({ width: 767, height: 900 });
    expect(await card.evaluate(element => getComputedStyle(element).display)).toBe("grid");
    expect(await admin.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(767);
    await admin.setViewportSize({ width: 768, height: 900 });
    await expect(card).toBeVisible();
    expect(await card.evaluate(element => getComputedStyle(element).display)).toBe("table-row");
    await expect(region.locator("thead th")).toHaveCount(12);
    await admin.screenshot({ path: "/tmp/storefront-admin-products-768.png", fullPage: true });
  } finally {
    await unlistProductsByPrefix(context.request, "手機卡片");
    await context.close();
  }
});

test("清單操作成功後保留搜尋、狀態篩選與頁碼", async ({ browser }) => {
  test.setTimeout(120_000);
  const PRESERVE = "保留篩選";
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 1280, height: 900 } });
  const admin = await context.newPage();
  try {
    await seedListedProducts(context, { slug: "admin-preserve", name: "保留篩選分類", description: "清單操作保留篩選" },
      Array.from({ length: 17 }, (_, index) => ({ name: `${PRESERVE}${String(index).padStart(2, "0")}`, priceTwd: 100, stock: 1 })));
    const url = `/admin?q=${encodeURIComponent(PRESERVE)}&status=listed&page=2`;
    await admin.goto(url);
    const table = admin.getByRole("region", { name: "管理資料表" });
    await expect(table.locator("tbody tr")).toHaveCount(2);
    const expectPreserved = async (saved: string) => {
      const current = new URL(admin.url());
      expect(current.pathname).toBe("/admin");
      expect(Object.fromEntries(current.searchParams)).toEqual({ q: PRESERVE, status: "listed", page: "2", saved });
    };
    // 下架第 2 頁的一件：回到同一份清單（仍是第 2 頁），訊息顯示在上方
    await table.locator("tbody tr").first().getByRole("button", { name: "下架", exact: true }).click();
    await expect(admin.getByRole("status")).toHaveText("已下架商品。");
    await expectPreserved("unlist");
    await expect(table.locator("tbody tr")).toHaveCount(1);
    // 庫存調整也一樣（不測精選：精選是全域名額，會干擾首頁 spec）
    const row = table.locator("tbody tr").first();
    await row.getByLabel(/的庫存增減量/).fill("+1");
    await row.getByLabel(/的庫存調整原因/).fill("E2E 補貨");
    await row.getByRole("button", { name: "調整庫存" }).click();
    await expect(admin.getByRole("status")).toHaveText("已調整庫存。");
    await expectPreserved("stock");
  } finally {
    await unlistProductsByPrefix(context.request, PRESERVE);
    await context.close();
  }
});
