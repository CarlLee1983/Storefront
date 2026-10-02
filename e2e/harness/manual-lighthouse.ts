/** Optional, interactive local acceptance only; never imported by CI. Run serve.ts first. */
import { chromium, expect } from "@playwright/test";
import { adminAccessHeaders } from "./admin-access";
import { assignSharedCategory } from "./admin-categories";
import { BASE_URL } from "./constants";

// The fixed harness origin deliberately cannot be changed to preview/production.
const browser = await chromium.launch({ channel: "chrome", headless: false });
const context = await browser.newContext({ baseURL: BASE_URL });
const adminContext = await browser.newContext({ baseURL: BASE_URL, extraHTTPHeaders: adminAccessHeaders() });
const admin = await adminContext.newPage();
const name = `Lighthouse 手工花器 ${Date.now()}`;
try {
  await admin.goto("/admin/products/new");
  await admin.getByLabel("名稱", { exact: true }).fill(name);
  await admin.getByLabel("說明", { exact: true }).fill("日常選物，三張商品圖片的本機驗收資料。");
  await admin.getByLabel("單價（新台幣整數元）").fill("680");
  await admin.getByRole("button", { name: "新增商品", exact: true }).click();
  await assignSharedCategory(admin, name);
  const row = admin.getByRole("row").filter({ hasText: name });
  await row.getByLabel(`${name}的庫存增減量`).fill("10");
  await row.getByRole("button", { name: "調整庫存" }).click();
  await row.getByRole("link", { name: "編輯" }).click();
  const detail = `/products/${new URL(admin.url()).pathname.split("/").pop()!}`;
  const images = await admin.evaluate(() => ["#164e63", "#9f1239", "#3f6212"].map(color => {
    const canvas = document.createElement("canvas"); canvas.width = 1600; canvas.height = 1200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#eee7dc"; ctx.fillRect(0, 0, 1600, 1200);
    ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(800, 660, 260, 380, 0, 0, Math.PI * 2); ctx.fill();
    return canvas.toDataURL("image/png").split(",")[1]!;
  }));
  await expect(admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）")).toBeEnabled();
  await admin.getByLabel("商品圖片（JPEG、PNG 或 WebP，20 MB 以內）").setInputFiles(images.map((data, index) => ({ name: `vase-${index}.png`, mimeType: "image/png", buffer: Buffer.from(data, "base64") })));
  await admin.getByRole("button", { name: "上傳商品圖片", exact: true }).click();
  await expect(admin.locator("#image-status")).toContainText("已上傳商品圖片");
  await expect(admin.locator("#product-images img")).toHaveCount(3);
  await admin.goto("/admin");
  await row.getByRole("button", { name: "重新上架", exact: true }).click();
  await row.getByText("上架中", { exact: true }).waitFor();
  await adminContext.close();
  const page = await context.newPage();
  await page.goto(detail);
  await page.getByRole("button", { name: "加入購物車", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已加入購物車" }).waitFor();
  await page.goto("/cart");
  console.log(`Chrome ${browser.version()} ready. Manually audit these URLs in this same context:`);
  console.log([BASE_URL, `${BASE_URL}${detail}`, `${BASE_URL}/cart`].join("\n"));
  console.log("DevTools → Lighthouse: Navigation, Mobile, Performance + Accessibility. Disable Clear storage to preserve the populated cart. Save HTML and JSON reports. Close Chrome when finished.");
  await new Promise<void>(resolve => browser.on("disconnected", () => resolve()));
} catch (error) {
  await browser.close();
  throw error;
}
