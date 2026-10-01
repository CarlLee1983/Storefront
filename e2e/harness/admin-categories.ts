import { expect, type Page } from "@playwright/test";

/**
 * 各個 spec 共用的分類：只為了讓商品能上架。名稱刻意很短，導覽列才不會因為分類太多而換行。
 * 各 spec 可能同時（不同 worker）要求它存在，所以建立採「已存在就略過」。
 */
export const SHARED_CATEGORY = { slug: "e2e-shared", name: "E2E共用", description: "E2E 測試共用的分類" };

/** 在 /admin 建立分類；表單送出後停在 /admin。 */
export async function createCategory(admin: Page, category: { slug: string; name: string; description: string }) {
  await admin.goto("/admin");
  await admin.getByLabel("分類名稱").fill(category.name);
  await admin.getByLabel("分類說明").fill(category.description);
  await admin.getByLabel("網址代稱").fill(category.slug);
  await admin.getByRole("button", { name: "建立分類" }).click();
}

/**
 * 確保共用分類存在。另一個 worker 同時建立時，後到者會得到「代稱已被使用」；
 * 這時不直接當成已存在，而是回後台確認清單裡真的有這個代稱與名稱的分類，否則測試失敗。
 */
export async function ensureSharedCategory(admin: Page) {
  await admin.goto("/admin");
  if (await admin.getByRole("row", { name: new RegExp(SHARED_CATEGORY.slug) }).count()) return;
  await createCategory(admin, SHARED_CATEGORY);
  const outcome = admin.getByRole("status").or(admin.getByRole("alert"));
  await expect(outcome).toContainText(/已建立分類|這個代稱已被使用/);
  if ((await outcome.textContent())?.includes("這個代稱已被使用")) {
    await admin.goto("/admin");
    const existing = admin.getByRole("row", { name: new RegExp(SHARED_CATEGORY.slug) });
    await expect(existing).toContainText(SHARED_CATEGORY.name);
  }
}

/** 在商品編輯頁選擇分類並儲存；完成時停在 /admin。 */
export async function assignCategory(admin: Page, productName: string, categoryName: string) {
  await admin.goto("/admin");
  await admin.getByRole("row", { name: new RegExp(productName) }).getByRole("link", { name: "編輯" }).click();
  await admin.getByLabel("分類", { exact: true }).selectOption({ label: categoryName });
  await admin.getByRole("button", { name: "儲存" }).click();
  await expect(admin.getByRole("status")).toHaveText("已儲存商品。");
}

/** 讓商品歸到共用分類（必要時先建立）。商品必須已經存在。 */
export async function assignSharedCategory(admin: Page, productName: string) {
  // 先等新增商品的表單送出完成（列表出現這件商品），再換頁
  await expect(admin.getByRole("row", { name: new RegExp(productName) })).toBeVisible();
  await ensureSharedCategory(admin);
  await assignCategory(admin, productName, SHARED_CATEGORY.name);
}
