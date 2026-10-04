import { expect, test } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { BASE_URL } from "../harness/constants";
import { analyzeWhenSettled } from "../harness/axe";

const groups = [
  { label: "商品與庫存", links: [["商品管理", "/admin"], ["分類管理", "/admin/categories"], ["庫存流水", "/admin/stock-movements"], ["低庫存提醒", "/admin/low-stock"]] },
  { label: "訂單與售後", links: [["訂單管理", "/admin/orders"], ["取消審核", "/admin/cancellations"], ["退貨處理", "/admin/returns"]] },
  { label: "款項與憑證", links: [["付款補查", "/admin/payments"], ["退款待辦", "/admin/refunds"], ["發票待辦", "/admin/invoices"]] },
  { label: "設定與通知", links: [["運費設定", "/admin/shipping"], ["信件投遞", "/admin/mail"]] },
] as const;

test("桌機分組導覽可找到全部功能且不遮擋內容", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto("/admin");
    const nav = page.getByRole("navigation", { name: "後台導覽" });
    await expect(nav.getByRole("heading")).toHaveText(groups.map(group => group.label));
    await expect(nav.getByRole("link")).toHaveCount(12);
    const navBox = (await nav.boundingBox())!;
    const mainBox = (await page.getByRole("main").boundingBox())!;
    expect(navBox.x + navBox.width).toBeLessThanOrEqual(mainBox.x);
    for (const group of groups) {
      const list = nav.getByRole("list", { name: group.label });
      await expect(list.getByRole("link")).toHaveText(group.links.map(([label]) => label));
      for (const [label, path] of group.links) {
        await list.getByRole("link", { name: label, exact: true }).click();
        await expect(page).toHaveURL(`${BASE_URL}${path}`);
        await expect(page.getByRole("heading", { name: label, exact: true, level: 1 })).toBeVisible();
        await expect(nav.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
        await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
      }
    }
  } finally {
    await context.close();
  }
});

test("直接開啟深層頁面可由麵包屑返回所屬列表", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
  try {
    const page = await context.newPage();
    for (const [path, parent, href, title] of [
      ["/admin/products/new", "商品管理", "/admin", "新增商品"],
      ["/admin/products/999999999", "商品管理", "/admin", "編輯商品"],
      ["/admin/categories/999999999", "分類管理", "/admin/categories", "修改分類"],
      ["/admin/orders/999999999", "訂單管理", "/admin/orders", "訂單"],
    ] as const) {
      await page.goto(path);
      const breadcrumb = page.getByRole("navigation", { name: "麵包屑" });
      await expect(breadcrumb.getByRole("link", { name: parent, exact: true })).toHaveAttribute("href", href);
      await expect(breadcrumb.locator('[aria-current="page"]')).toHaveText(title);
      await breadcrumb.getByRole("link", { name: parent, exact: true }).click();
      await expect(page).toHaveURL(`${BASE_URL}${href}`);
      await expect(page.getByRole("heading", { name: parent, exact: true, level: 1 })).toBeVisible();
    }
  } finally {
    await context.close();
  }
});

test("手機抽屜可用鍵盤開關並到達所有功能", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 375, height: 667 } });
  try {
    const page = await context.newPage();
    await page.goto("/admin");
    const open = page.getByRole("button", { name: "開啟後台選單" });
    const drawer = page.getByRole("dialog", { name: "後台選單" });
    await expect(open).toBeVisible();
    await expect(page.getByRole("navigation", { name: "後台導覽" })).toHaveCount(0);
    await open.focus();
    await page.keyboard.press("Enter");
    await expect(drawer).toBeVisible();
    const close = drawer.getByRole("button", { name: "關閉後台選單" });
    await expect(close).toBeFocused();
    for (const control of await drawer.locator("a, button").all()) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press("Tab");
    await expect(drawer.getByRole("link", { name: "商品管理", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(close).toBeFocused();
    for (const [label] of groups.flatMap(group => [...group.links])) {
      await page.keyboard.press("Tab");
      await expect(drawer.getByRole("link", { name: label, exact: true })).toBeFocused();
    }
    expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(open).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "前往前台", exact: true })).toBeFocused();

    for (const group of groups) {
      for (const [label, path] of group.links) {
        await open.click();
        const nav = drawer.getByRole("navigation", { name: "後台導覽" });
        await expect(nav.getByRole("heading")).toHaveText(groups.map(item => item.label));
        await expect(nav.getByRole("link")).toHaveCount(12);
        await nav.getByRole("list", { name: group.label }).getByRole("link", { name: label, exact: true }).click();
        await expect(page).toHaveURL(`${BASE_URL}${path}`);
        await expect(drawer).not.toBeVisible();
        await expect(page.getByRole("heading", { name: label, exact: true, level: 1 })).toBeVisible();
      }
    }
    await open.click();
    await close.click();
    await expect(open).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    expect((await analyzeWhenSettled(page)).violations).toEqual([]);
  } finally {
    await context.close();
  }
});

test("短視窗及版型切換仍能操作導覽與內容", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport: { width: 1280, height: 480 } });
  try {
    const page = await context.newPage();
    await page.goto("/admin/orders");
    const nav = page.getByRole("navigation", { name: "後台導覽" });
    await nav.getByRole("link", { name: "信件投遞", exact: true }).click();
    await expect(page).toHaveURL(`${BASE_URL}/admin/mail`);
    await expect(page.getByRole("heading", { level: 1, name: "信件投遞" })).toBeVisible();

    await page.setViewportSize({ width: 1023, height: 667 });
    const open = page.getByRole("button", { name: "開啟後台選單" });
    const drawer = page.getByRole("dialog", { name: "後台選單" });
    await open.click();
    await expect(drawer).toBeVisible();
    await expect(nav).toHaveCount(1);
    await page.setViewportSize({ width: 1024, height: 667 });
    await expect(drawer).not.toBeVisible();
    await expect(open).not.toBeVisible();
    await expect(nav).toHaveCount(1);
    await expect(nav.getByRole("link", { name: "信件投遞", exact: true })).toBeFocused();
    await expect(page.getByRole("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
    await nav.getByRole("link", { name: "商品管理", exact: true }).click();
    await expect(page).toHaveURL(`${BASE_URL}/admin`);

    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/admin/products/new");
      const name = width === 1280 ? "admin-desktop" : "admin-mobile";
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path });
      await testInfo.attach(name, { path, contentType: "image/png" });
      if (width === 375) {
        await expect(drawer).not.toBeVisible();
        await open.click();
        await expect(nav.getByRole("link", { name: "商品管理", exact: true })).toHaveAttribute("aria-current", "page");
        const drawerPath = testInfo.outputPath("admin-drawer.png");
        await page.screenshot({ path: drawerPath });
        await testInfo.attach("admin-drawer", { path: drawerPath, contentType: "image/png" });
        await page.keyboard.press("Escape");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      expect((await analyzeWhenSettled(page)).violations).toEqual([]);
    }
  } finally {
    await context.close();
  }
});
