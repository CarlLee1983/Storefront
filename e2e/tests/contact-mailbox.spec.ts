import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { adminAccessHeaders } from "../harness/admin-access";
import { seedListedProducts } from "../harness/admin-seed";
import { BASE_URL } from "../harness/constants";
import { createCustomer } from "../harness/customer-fixture";
import { memberSessionCookie } from "../harness/session-cookie";

const VIEWPORTS = [{ name: "手機", width: 375, height: 812 }, { name: "桌機", width: 1280, height: 900 }] as const;

/** 無水平捲動、主要區域的操作元件至少 44px（句子中的行內連結除外）、無 axe 違規。 */
async function assertAccessibleLayout(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "page overflow").toBeLessThanOrEqual(width);
  for (const control of await page.locator("main :is(a, button, input):not([role=status] a)").all()) {
    if (!(await control.isVisible())) continue;
    const box = await control.boundingBox();
    if (!box) continue;
    expect(box.height, `${await control.textContent()} 高度`).toBeGreaterThanOrEqual(44);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function customerPage(browser: Browser, token: string, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport });
  await context.addCookies([memberSessionCookie({ token })]);
  return { context, page: await context.newPage() };
}

/** 在帳戶頁送出聯絡 email，並回到信箱開啟最新一封信。 */
async function requestAndOpenLatestMail(page: Page, email: string) {
  await page.goto("/account");
  await page.getByRole("textbox", { name: /聯絡 email/ }).fill(email);
  await page.getByRole("button", { name: "寄出驗證信" }).click();
  await page.goto("/account/mailbox");
  await page.getByRole("link", { name: "請驗證你的聯絡 email" }).first().click();
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：未驗證顧客先被帶去帳戶頁，從自己的信箱驗證後可結帳；換址未驗證前不取代、歷史信件保持原地址`, async ({ browser }) => {
    const customer = createCustomer("信箱顧客");
    const { context, page } = await customerPage(browser, customer.token, viewport);
    try {
      // 首次結帳前須驗證：被帶去帳戶頁並說明原因
      await page.goto("/checkout");
      await expect(page).toHaveURL(/\/account\?reason=checkout$/);
      await expect(page.getByRole("status")).toContainText("首次結帳前，請先驗證聯絡 email");
      await expect(page.getByText("尚未驗證聯絡 email")).toBeVisible();
      await assertAccessibleLayout(page, viewport.width);

      // 送出後等待驗證；信在自己的模擬信箱，內容與收件地址可見
      await page.getByRole("textbox", { name: "聯絡 email" }).fill("first@example.com");
      await page.getByRole("button", { name: "寄出驗證信" }).click();
      await expect(page.getByRole("status")).toContainText("驗證信已寄到你的模擬信箱");
      await expect(page.getByText("等待驗證：")).toContainText("first@example.com");
      await page.goto("/checkout");
      await expect(page).toHaveURL(/\/account\?reason=checkout$/);

      await page.goto("/account/mailbox");
      await assertAccessibleLayout(page, viewport.width);
      await page.getByRole("link", { name: "請驗證你的聯絡 email" }).click();
      await expect(page.getByText("收件地址")).toBeVisible();
      await expect(page.locator(".meta")).toContainText("first@example.com");
      await assertAccessibleLayout(page, viewport.width);

      // 開啟驗證連結需要按下確認才會驗證
      await page.getByRole("link", { name: "驗證 first@example.com" }).click();
      await expect(page).toHaveURL(/\/account\/verify\?token=/);
      await assertAccessibleLayout(page, viewport.width);
      await page.getByRole("button", { name: "確認驗證" }).click();
      await expect(page).toHaveURL(/\/account\?verified=1$/);
      await expect(page.getByRole("status")).toContainText("已完成驗證");
      await expect(page.getByText("已驗證：")).toContainText("first@example.com");

      // 已驗證後可以進入結帳頁
      await page.goto("/checkout");
      await expect(page).toHaveURL(/\/checkout$/);

      // 換址：新地址驗證前仍用既有已驗證地址
      await page.goto("/account");
      await page.getByRole("textbox", { name: "更換聯絡 email" }).fill("second@example.com");
      await page.getByRole("button", { name: "寄出驗證信" }).click();
      await expect(page.getByText("已驗證：")).toContainText("first@example.com");
      await expect(page.getByText("等待驗證：")).toContainText("second@example.com");
      await page.goto("/checkout");
      await expect(page).toHaveURL(/\/checkout$/);

      // 驗證新地址後，歷史信件仍是原收件地址
      await page.goto("/account/mailbox");
      await page.getByRole("link", { name: "請驗證你的聯絡 email" }).first().click();
      await page.getByRole("link", { name: "驗證 second@example.com" }).click();
      await page.getByRole("button", { name: "確認驗證" }).click();
      await expect(page.getByText("已驗證：")).toContainText("second@example.com");
      await page.goto("/account/mailbox");
      const items = page.locator(".mail-card");
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toContainText("second@example.com");
      await expect(items.nth(1)).toContainText("first@example.com");
      await items.nth(1).getByRole("link").click();
      await expect(page.locator(".meta")).toContainText("first@example.com");
      await expect(page.getByText("這個地址已完成驗證。")).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test("顧客只能讀自己的信箱，別人的信與驗證連結都不可用", async ({ browser }) => {
  const alice = createCustomer("甲顧客");
  const bob = createCustomer("乙顧客");
  const a = await customerPage(browser, alice.token, VIEWPORTS[1]);
  const b = await customerPage(browser, bob.token, VIEWPORTS[1]);
  try {
    await requestAndOpenLatestMail(a.page, "alice-isolation@example.com");
    const mailUrl = a.page.url();
    const verifyHref = await a.page.getByRole("link", { name: /^驗證 / }).getAttribute("href");
    expect(verifyHref).toContain("/account/verify?token=");

    // 乙的信箱是空的；直接開甲的信與甲的驗證連結都不行
    await b.page.goto("/account/mailbox");
    await expect(b.page.getByRole("heading", { name: "信箱還是空的" })).toBeVisible();
    expect((await b.page.goto(mailUrl))?.status()).toBe(404);
    await expect(b.page.getByText("找不到這封信")).toBeVisible();
    await b.page.goto(verifyHref!);
    await b.page.getByRole("button", { name: "確認驗證" }).click();
    await expect(b.page.getByRole("alert")).toContainText("驗證連結無效");
    await b.page.goto("/account");
    await expect(b.page.getByText("尚未驗證聯絡 email")).toBeVisible();

    // 甲的請求沒有被乙消耗
    await a.page.goto(verifyHref!);
    await a.page.getByRole("button", { name: "確認驗證" }).click();
    await expect(a.page.getByText("已驗證：")).toContainText("alice-isolation@example.com");

    // 未登入者看不到信箱
    const anonymous = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await anonymous.newPage();
      await page.goto("/account/mailbox");
      await expect(page).toHaveURL(/\/login\?next=/);
    } finally {
      await anonymous.close();
    }
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：管理員查投遞結果、開關失敗演練並重送，看不到驗證連結`, async ({ browser }) => {
    const customer = createCustomer(`投遞顧客${viewport.name}`);
    const { context, page } = await customerPage(browser, customer.token, viewport);
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    const admin = await adminContext.newPage();
    const email = `delivery-${viewport.name === "手機" ? "mobile" : "desktop"}@example.com`;
    try {
      await admin.goto("/admin/mail");
      const toggle = async (name: string) => {
        await admin.getByRole("button", { name }).click();
        await expect(admin.getByRole("status")).toContainText("已更新投遞演練設定");
      };
      await toggle("開啟投遞失敗");

      // 失敗演練開啟：顧客看到投遞失敗，信箱沒有信
      await page.goto("/account");
      await page.getByRole("textbox", { name: "聯絡 email" }).fill(email);
      await page.getByRole("button", { name: "寄出驗證信" }).click();
      await expect(page.getByRole("alert")).toContainText("驗證信投遞失敗");
      await page.goto("/account/mailbox");
      await expect(page.getByRole("heading", { name: "信箱還是空的" })).toBeVisible();

      // 管理端看到失敗與實際收件地址；先重送一次（演練仍開啟，仍失敗），再關閉演練後重送
      await admin.goto("/admin/mail");
      const row = admin.locator("tbody tr").filter({ hasText: email }).first();
      await expect(row).toContainText("投遞失敗");
      await assertAccessibleLayout(admin, viewport.width);
      await row.getByRole("button", { name: /重送信件/ }).click();
      await expect(admin.getByRole("status")).toContainText("這次投遞仍失敗");
      await toggle("關閉投遞失敗");
      await admin.locator("tbody tr").filter({ hasText: email }).first().getByRole("button", { name: /重送信件/ }).click();
      await expect(admin.getByRole("status")).toContainText("信件已送達顧客信箱");
      await expect(admin.locator("tbody tr").filter({ hasText: email }).first()).toContainText("已送達");

      // 顧客收到信、驗證連結只在顧客自己的信裡；管理頁不含連結與憑證
      await page.goto("/account/mailbox");
      await page.getByRole("link", { name: "請驗證你的聯絡 email" }).click();
      const href = await page.getByRole("link", { name: /^驗證 / }).getAttribute("href");
      const token = new URL(href!, BASE_URL).searchParams.get("token")!;
      const adminHtml = await (await adminContext.request.get("/admin/mail")).text();
      expect(adminHtml).not.toContain(token);
      expect(adminHtml).not.toContain("/account/verify");
    } finally {
      // 失敗演練是全域狀態：不論成敗都關掉，不影響其他 spec
      await adminContext.request.post("/admin/mail", { form: { intent: "set-failure", enabled: "0" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      await context.close();
      await adminContext.close();
    }
  });
}

// 投遞失敗演練是全域狀態（mail_controls）：所有會開關它的情境必須留在這個檔案，同檔的測試依序執行，不會互相干擾
for (const viewport of VIEWPORTS) {
  test(`${viewport.name}：下單通知投遞失敗不影響訂單，管理員在待辦重送後顧客收到信，別人看不到（與投遞失敗演練同檔序列執行）`, async ({ browser }) => {
    const suffix = `${viewport.width}`;
    const productName = `通知商品${suffix}`;
    const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders(), viewport });
    let productId: number | undefined;
    try {
      [productId] = await seedListedProducts(adminContext, { slug: `notice-${suffix}`, name: `通知分類${suffix}`, description: "通知測試" }, [{ name: productName, priceTwd: 500, stock: 3 }]);
    } catch (error) {
      await adminContext.close();
      throw error;
    }

    const customerName = `通知顧客${suffix}`;
    const customer = createCustomer(customerName, `notice-${suffix}@example.com`);
    const other = createCustomer(`旁人${suffix}`, `bystander-${suffix}@example.com`);
    const { context, page } = await customerPage(browser, customer.token, viewport);
    const otherSide = await customerPage(browser, other.token, viewport);
    const admin = await adminContext.newPage();
    try {
      // 投遞失敗演練開啟時下單：訂單照常成立，信箱沒有信
      await admin.goto("/admin/mail");
      await admin.getByRole("button", { name: "開啟投遞失敗" }).click();
      await expect(admin.getByRole("status")).toContainText("已更新投遞演練設定");

      await page.goto(`/products/${productId!}`);
      await page.getByRole("region", { name: "商品資訊" }).getByRole("button", { name: "加入購物車", exact: true }).click();
      await expect(page.locator("#cart-count")).toHaveText("1");
      await page.goto("/checkout");
      await page.getByLabel("收件人姓名").fill("通知王");
      await page.getByLabel("收件人電話").fill("0912345678");
      await page.getByLabel("收件地址").fill("台北市中正區重慶南路一段 122 號");
      await page.getByRole("button", { name: "送出訂單" }).click();
      await expect(page).toHaveURL(/\/orders\/(\d+)\?placed=1$/);
      await page.goto("/account/mailbox");
      await expect(page.getByRole("heading", { name: "信箱還是空的" })).toBeVisible();

      // 管理端待辦：標出待處理，留有失敗的投遞與實際收件地址
      await admin.goto("/admin/mail");
      const row = admin.locator("tbody tr").filter({ hasText: customerName }).first();
      await expect(row).toContainText("待處理");
      await expect(row).toContainText("下單通知");
      await expect(row).toContainText(`notice-${suffix}@example.com：投遞失敗`);
      await assertAccessibleLayout(admin, viewport.width);

      // 關閉演練後重送：顧客收到信，待辦消失，處理人留在紀錄
      await admin.getByRole("button", { name: "關閉投遞失敗" }).click();
      await admin.locator("tbody tr").filter({ hasText: customerName }).first().getByRole("button", { name: /重送信件/ }).click();
      await expect(admin.getByRole("status")).toContainText("信件已送達顧客信箱");
      const resolved = admin.locator("tbody tr").filter({ hasText: customerName }).first();
      await expect(resolved).not.toContainText("待處理");
      await expect(resolved).toContainText("重送");

      await page.goto("/account/mailbox");
      await expect(page.locator(".mail-card")).toHaveCount(1);
      await expect(page.locator(".mail-card")).toContainText("下單通知");
      await assertAccessibleLayout(page, viewport.width);
      await page.locator(".mail-card").getByRole("link").click();
      await expect(page.getByText(/已成立，應付 NT\$500/)).toBeVisible();

      // 別人的信箱沒有這封信
      await otherSide.page.goto("/account/mailbox");
      await expect(otherSide.page.getByRole("heading", { name: "信箱還是空的" })).toBeVisible();
    } finally {
      // 失敗演練是全域狀態：不論成敗都關掉，不影響其他 spec
      await adminContext.request.post("/admin/mail", { form: { intent: "set-failure", enabled: "0" }, headers: { origin: BASE_URL }, maxRedirects: 0 });
      await context.close();
      await otherSide.context.close();
      await adminContext.close();
    }
  });
}
