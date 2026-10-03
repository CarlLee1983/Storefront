import { expect, test } from "@playwright/test";
import { analyzeWhenSettled } from "../harness/axe";

const pages = [
  { path: "/about", status: 200, heading: "關於靜物" },
  { path: "/faq", status: 200, heading: "常見問題" },
  { path: "/returns", status: 200, heading: "退換貨說明" },
  { path: "/not-a-real-page", status: 404, heading: "找不到這個頁面" },
  { path: "/500", status: 500, heading: "頁面暫時無法顯示" },
] as const;

for (const width of [375, 1280]) {
  test(`內容與錯誤頁於 ${width}px 可讀且無障礙`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const { path, status, heading } of pages) {
      expect((await page.goto(path))?.status(), path).toBe(status);
      await expect(page.locator("main").getByRole("heading", { level: 1, name: heading })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), path).toBe(true);
      expect((await analyzeWhenSettled(page)).violations, path).toEqual([]);
    }
  });
}

test("關於、常見問題與退換貨頁提供完整購物資訊和聯絡出口", async ({ page }) => {
  await page.goto("/about");
  const about = page.locator("main");
  await expect(about).toContainText("你可以先瀏覽商品並加入購物車，結帳前再登入。");
  await expect(about).toContainText("付款後 3 個工作天內出貨，以宅配送達台灣本島");
  await expect(about).toContainText("不提供組裝與安裝");
  await expect(about).toContainText("這是示範網站，不實際出貨。");
  await expect(about.getByRole("link", { name: "hello@gravito.dev" })).toHaveAttribute("href", "mailto:hello@gravito.dev");

  await page.goto("/faq");
  const faq = page.locator("main");
  await expect(faq.locator("h2")).toHaveText(["需要登入才能挑商品嗎？", "可以怎麼付款？", "何時出貨？配送到哪裡？", "大型家具如何配送？", "發票如何取得？", "可以退換貨嗎？", "如何聯絡靜物？"]);
  await expect(faq).toContainText("結帳前須用 LINE 或 Google 登入");
  await expect(faq).toContainText("兩種登入方式各自獨立");
  await expect(faq).toContainText("購物車只保存在目前的瀏覽器，換裝置不會同步");
  await expect(faq).toContainText("訂單可能轉為已逾期");
  await expect(faq).toContainText("電子發票會寄到你登入時使用的 email。");
  await expect(faq).not.toContainText("編輯審閱註記");
  await expect(faq.getByRole("link", { name: "退換貨說明" })).toHaveAttribute("href", "/returns");
  await expect(faq.getByRole("link", { name: "hello@gravito.dev" })).toHaveCount(2);

  await page.goto("/returns");
  const returns = page.locator("main");
  await expect(returns.locator("h2")).toHaveText(["申請期限", "商品條件", "收回與運費", "退款"]);
  await expect(returns).toContainText("自到貨隔日起 7 天內可提出退換貨申請");
  await expect(returns).toContainText("退回運費由靜物負擔");
  await expect(returns).toContainText("14 個工作天內將款項退至原付款方式");
  await expect(returns).toContainText("付款後無法自行取消");
  await expect(returns.getByRole("link", { name: "hello@gravito.dev" })).toHaveCount(2);
  for (const link of await returns.getByRole("link", { name: "hello@gravito.dev" }).all()) {
    await expect(link).toHaveAttribute("href", "mailto:hello@gravito.dev");
  }
});

test("一般、商品與分類 404 使用相同內容，搜尋可前往結果頁", async ({ page }) => {
  const paths = ["/not-a-real-page", "/products/999999999", "/categories/no-such-category"];
  let firstBody = "";
  for (const path of paths) {
    expect((await page.goto(path))?.status(), path).toBe(404);
    await expect(page).toHaveTitle("找不到頁面｜靜物");
    const main = page.locator("main");
    await expect(main.getByRole("heading", { level: 1, name: "找不到這個頁面" })).toBeVisible();
    await expect(main.getByText("網址可能有誤，或頁面已移動。你可以搜尋商品，或繼續瀏覽全部商品。")).toBeVisible();
    await expect(main.getByRole("searchbox", { name: "搜尋商品" })).toBeVisible();
    await expect(main.getByRole("link", { name: "全部商品" })).toHaveAttribute("href", "/products");
    const body = await main.innerText();
    if (firstBody) expect(body).toBe(firstBody);
    else firstBody = body;
  }
  await page.locator("main").getByRole("searchbox", { name: "搜尋商品" }).fill("花器");
  await page.locator("main").getByRole("button", { name: "搜尋" }).click();
  await expect(page).toHaveURL(/\/search\?q=%E8%8A%B1%E5%99%A8$/);
  await expect(page.getByRole("heading", { level: 1, name: "搜尋：花器" })).toBeVisible();
});

test("500 顯示顧客可用的恢復出口", async ({ page }) => {
  expect((await page.goto("/500"))?.status()).toBe(500);
  await expect(page).toHaveTitle("暫時無法顯示頁面｜靜物");
  const main = page.locator("main");
  await expect(main).toContainText("目前無法載入這個頁面，請稍後重新整理。如果仍無法開啟，可以先瀏覽全部商品。");
  await expect(main.getByRole("link", { name: "全部商品" })).toHaveAttribute("href", "/products");
  await expect(main).not.toContainText(/伺服器|錯誤代碼|500/);
});
