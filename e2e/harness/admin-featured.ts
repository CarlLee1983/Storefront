import { expect, type Page } from "@playwright/test";

/** 在後台商品清單把商品標為精選；完成時停在 /admin。商品必須已經存在。 */
export async function featureProduct(admin: Page, productName: string) {
  await admin.goto("/admin");
  await admin.getByRole("row", { name: new RegExp(productName) }).getByRole("button", { name: /^標為精選/ }).click();
  await expect(admin.getByRole("status")).toHaveText("已標為精選商品。");
}
