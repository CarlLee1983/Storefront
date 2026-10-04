import { expect, test, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts, unlistProduct } from "../harness/admin-seed";
import { gotoProductList } from "../harness/admin-list";
import { analyzeWhenSettled } from "../harness/axe";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";

/** 既有的訂單頁有尺寸不足的控制項（不在這張票範圍）：只檢查無水平捲動與 axe 零違規。 */
async function assertNoOverflowAndAxe(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  expect((await analyzeWhenSettled(page)).violations).toEqual([]);
}

function taipeiLocalNow(): string {
  const value = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 19);
  // 秒數為 0 時 Chrome 把 datetime-local 正規化成 HH:MM，帶 :00 的值會被判為格式錯誤
  return value.endsWith(":00") ? value.slice(0, 16) : value;
}

/**
 * T24 整體商務演練（同一張 9,700 元訂單，手機與桌機各走一次）：燈具 3 x 1,000 一般配送、桌子 1 x 6,000 大型配送。
 * 金額與庫存的逐步斷言在 App 整合測試（apps/app/test/commerce-rehearsal.test.ts）；這裡以顧客與管理員的實際畫面走主要路徑，
 * 並以管理員商品頁的「在庫、不可售、保留、可售」對照每一步的庫存。
 */
for (const viewport of [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }]) {
  test(`${viewport.name}：9,700 元混合配送訂單走完分批交運、取消、退貨、物流遺失，累計退款 8,600（收款剩額 1,100），發票原額 9,700 折讓 8,600 餘額 1,100`, async ({ browser }) => {
    test.setTimeout(420_000);
    const suffix = `${viewport.width}`;
    const lampName = `演練燈具${suffix}`;
    const tableName = `演練桌子${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const [lampId, tableId] = await seedListedProducts(adminContext, { slug: `rehearsal-${suffix}`, name: `演練分類${suffix}`, description: "整體商務演練" }, [
      { name: lampName, priceTwd: 1000, stock: 3 },
      { name: tableName, priceTwd: 6000, stock: 1 },
    ]) as [number, number];
    const customer = createCustomer("演練顧客", `rehearsal-${suffix}@example.com`);
    const customerContext = await browser.newContext({ baseURL: BASE_URL, viewport });
    await customerContext.addCookies([memberSessionCookie({ token: customer.token })]);
    const admin = await adminContext.newPage();
    const page = await customerContext.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    admin.on("dialog", (dialog) => void dialog.accept());

    /** 管理員商品清單該列的庫存四個數字（單一變體商品，列上是它預設變體的數字）。 */
    const expectStock = async (name: string, stock: { onHand: number; unavailable: number; reserved: number; available: number }) => {
      await gotoProductList(admin, name);
      const row = admin.getByRole("row").filter({ has: admin.getByRole("link", { name, exact: true }) });
      await expect(row.locator("td[data-label='在庫數']")).toHaveText(String(stock.onHand));
      await expect(row.locator("td[data-label='不可售數']")).toHaveText(String(stock.unavailable));
      await expect(row.locator("td[data-label='保留數']")).toHaveText(String(stock.reserved));
      await expect(row.locator("td[data-label='可售數量']")).toHaveText(String(stock.available));
    };

    try {
      // 桌子設為大型配送
      await admin.goto(`/admin/products/${tableId}`);
      await admin.getByLabel("配送類型").selectOption({ label: "大型配送" });
      await admin.getByRole("button", { name: "儲存變更" }).click();
      await expect(admin).toHaveURL(/\/admin\/products\?saved=updated/);

      // 步驟 1：顧客結帳 9,700（9,000 + 100 + 600），全部保留；付款後轉已付款保留，實體不變
      let expectedCount = 0;
      for (const [productId, quantity] of [[lampId, 3], [tableId, 1]] as const) {
        await page.goto(`/products/${productId}`);
        const info = page.getByRole("region", { name: "商品資訊" });
        for (let count = 0; count < quantity; count += 1) {
          await info.getByRole("button", { name: "加入購物車", exact: true }).click();
          await expect(page.locator("#cart-count")).toHaveText(String(++expectedCount));
        }
      }
      await page.goto("/checkout");
      await expect(page.locator("#checkout-fee-standard-amount")).toHaveText("100");
      await expect(page.locator("#checkout-fee-large-amount")).toHaveText("600");
      await expect(page.locator("#checkout-total")).toHaveText("9,700");
      await page.getByLabel("收件人姓名").fill("演練王");
      await page.getByLabel("收件人電話").fill("0912345678");
      await page.getByLabel("收件地址").fill("台北市中正區重慶南路一段 122 號");
      await page.getByLabel(/我確認配送地點位於台灣本島/).check();
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      const orderId = /\/orders\/(\d+)/.exec(page.url())![1]!;
      await expectStock(lampName, { onHand: 3, unavailable: 0, reserved: 3, available: 0 });
      await expectStock(tableName, { onHand: 1, unavailable: 0, reserved: 1, available: 0 });
      await page.goto(`/orders/${orderId}`);
      await page.getByRole("button", { name: "前往付款", exact: true }).click();
      await page.getByRole("radio", { name: "成功", exact: true }).check();
      await page.getByRole("radio", { name: "立即回呼", exact: true }).check();
      await page.getByRole("button", { name: "送出", exact: true }).click();
      await expect(page.getByText("訂單狀態：已付款")).toBeVisible();
      await expectStock(lampName, { onHand: 3, unavailable: 0, reserved: 3, available: 0 });
      await expectStock(tableName, { onHand: 1, unavailable: 0, reserved: 1, available: 0 });
      await assertNoOverflowAndAxe(page, viewport.width);

      // 步驟 2：管理員交運燈具 2 件（桌子數量改 0）；顧客申請取消另 1 件，管理員核准，退款 1,000、一般運費不退
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByLabel(new RegExp(`${tableName}.*未交運 1`)).fill("0");
      await admin.getByLabel(new RegExp(`${lampName}.*未交運 3`)).fill("2");
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄這一批出貨。");
      await page.goto(`/orders/${orderId}`);
      const cancelForm = page.getByRole("region", { name: "取消申請" });
      await cancelForm.getByLabel(new RegExp(`${lampName}.*可取消 1`)).fill("1");
      await cancelForm.getByRole("button", { name: "申請取消" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已送出取消申請" })).toBeVisible();
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByRole("button", { name: "核准取消並退款" }).click();
      await expect(admin.getByRole("status")).toContainText("退款已成功退回");
      await expect(admin.getByRole("list", { name: "取消申請" })).toContainText("應退商品款 NT$ 1,000、運費 NT$ 0");
      await expectStock(lampName, { onHand: 1, unavailable: 0, reserved: 0, available: 1 });

      // 步驟 3：管理員記錄燈具批送達；顧客自助退回 1 件，管理員核准、收回、檢查合格，退款 1,000，運費 100 保留
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.waitForTimeout(1_000 - (Date.now() % 1_000) + 50);
      const batches = admin.getByRole("list", { name: "出貨批次" });
      await batches.getByText(/^物流回報/).click();
      await batches.getByLabel("回報種類").selectOption("delivered");
      await batches.getByLabel(/回報發生時間/).fill(taipeiLocalNow());
      await batches.getByRole("button", { name: "記錄物流回報" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄物流回報。");
      await page.goto(`/orders/${orderId}`);
      const returnForm = page.getByRole("region", { name: "退貨申請" });
      await returnForm.getByLabel(new RegExp(`${lampName}.*本批可自助退貨 2`)).fill("1");
      await returnForm.getByLabel(/退貨原因（選填）/).fill("演練退回");
      await returnForm.getByRole("button", { name: "送出自助退貨" }).click();
      await expect(page.getByRole("status").filter({ hasText: "已送出退貨申請" })).toBeVisible();
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByRole("button", { name: "核准退貨" }).click();
      await expect(admin.getByRole("status")).toContainText("已核准這案退貨申請");
      await admin.getByLabel(new RegExp(`${lampName}.*申請 1`)).fill("1");
      await admin.getByRole("button", { name: "記錄收回" }).click();
      await expect(admin.getByRole("status")).toContainText("已記錄收回");
      await admin.getByLabel("良品（轉可售）").fill("1");
      await admin.getByLabel("損壞品（隔離）").fill("0");
      await admin.getByRole("button", { name: "記錄檢查並退款" }).click();
      await expect(admin.getByRole("status")).toContainText("退款已成功退回");
      await expect(admin.getByRole("list", { name: "退貨申請" })).toContainText("應退商品款 NT$ 1,000、運費 NT$ 0");
      await expectStock(lampName, { onHand: 2, unavailable: 0, reserved: 0, available: 2 });

      // 步驟 4：桌子另批交運（大型配送，議定時段）後確認遺失，退商品 6,000 與大型運費 600，不回補庫存
      await admin.goto(`/admin/orders/${orderId}`);
      await admin.getByLabel("開始").fill("2026-10-10T09:00");
      await admin.getByLabel("結束").fill("2026-10-10T12:00");
      await admin.getByRole("button", { name: "確認交運這一批" }).click();
      await expect(admin.getByRole("status")).toHaveText("已記錄這一批出貨。");
      const tableBatch = admin.getByRole("list", { name: "出貨批次" }).getByRole("listitem").filter({ hasText: "第 2 批" }).first();
      await tableBatch.getByText("確認遺失", { exact: true }).click();
      await tableBatch.getByLabel(new RegExp(`${tableName}.*本批 1`)).fill("1");
      await tableBatch.getByRole("button", { name: "確認遺失並退款" }).click();
      await expect(admin.getByRole("status")).toContainText("已確認這批商品遺失");
      await expect(admin.getByRole("status")).toContainText("退款已成功退回");
      await expect(admin.getByRole("list", { name: "確認遺失紀錄" })).toContainText("應退商品款 NT$ 6,000、運費 NT$ 600");
      await expectStock(tableName, { onHand: 0, unavailable: 0, reserved: 0, available: 0 });

      // 步驟 5：管理員看到三筆退款與發票折讓；顧客看到時間線、退款、發票原額 9,700、折讓 8,600、餘額 1,100
      await admin.goto(`/admin/orders/${orderId}`);
      const refunds = admin.getByRole("region", { name: "退款資料表" });
      await expect(refunds).toContainText("取消申請核准");
      await expect(refunds).toContainText("退貨檢查完成");
      await expect(refunds).toContainText("物流確認遺失");
      await expect(refunds.getByRole("row").filter({ hasText: "已退回" })).toHaveCount(3);
      const adminInvoice = admin.getByRole("region", { name: "發票資料表" });
      await expect(adminInvoice.locator("td[data-label='原額']")).toHaveText("NT$ 9,700");
      await expect(adminInvoice.locator("td[data-label='折讓']")).toContainText("已折讓 NT$ 8,600");
      await expect(adminInvoice.locator("td[data-label='折讓']")).not.toContainText("憑證待補");
      await assertNoOverflowAndAxe(admin, viewport.width);

      await page.goto(`/orders/${orderId}`);
      const timeline = page.getByRole("region", { name: "進度與時間線" });
      const events = timeline.getByRole("list", { name: "事件時間線（台北時間）" }).getByRole("listitem");
      await expect(events.first()).toContainText("訂單成立");
      await expect(events.filter({ hasText: "退款已退回" })).toHaveCount(3);
      await expect(events.filter({ hasText: "折讓完成" })).toHaveCount(3);
      await expect(timeline).toContainText("確認物流遺失");
      await expect(timeline).toContainText("退款已退回 NT$ 6,600");
      await expect(timeline).toContainText("發票已開立 NT$ 9,700");
      await expect(timeline).not.toContainText("退款曾明確失敗");
      // 累計金額：已收款 9,700、已退回 8,600，兩者相差的收款剩額即 1,100（等於保留的一件燈具與一般運費）
      const amountOf = async (label: string) => Number((await timeline.getByText(label, { exact: true }).locator("xpath=following-sibling::dd").innerText()).replace(/[^\d]/g, ""));
      expect(await amountOf("已收款")).toBe(9700);
      expect(await amountOf("已退回")).toBe(8600);
      expect(await amountOf("憑證已折讓")).toBe(8600);
      expect(await amountOf("已收款") - await amountOf("已退回")).toBe(1100);
      await expect(timeline.getByText("待退回款項", { exact: true }).locator("xpath=following-sibling::dd")).toHaveText("NT$ 0");
      const invoices = page.locator("#invoices");
      await expect(invoices).toContainText("NT$ 9,700");
      await expect(invoices).toContainText("已折讓 3 筆，累計 NT$ 8,600");
      await expect(invoices).toContainText("折讓後餘額 NT$ 1,100");
      await assertNoOverflowAndAxe(page, viewport.width);
    } finally {
      await unlistProduct(adminContext.request, lampId);
      await unlistProduct(adminContext.request, tableId);
      await adminContext.close();
      await customerContext.close();
    }
  });
}
