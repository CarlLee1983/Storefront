import { expect, type Page } from "@playwright/test";

/** 在商品頁逐件加入目前選取的變體；每次都確認購買數量已儲存，徽章顯示購物車筆數。 */
export async function addVariantQuantityFromDetail(page: Page, quantity: number, expectedLines: number): Promise<void> {
  const info = page.getByRole("region", { name: "商品資訊" });
  for (let count = 0; count < quantity; count += 1) {
    await info.getByRole("button", { name: "加入購物車", exact: true }).click();
    await expect(info.getByRole("status")).toHaveText(`已加入購物車，目前 ${count + 1} 件。`);
    await expect(page.locator("#cart-count")).toHaveText(String(expectedLines));
  }
}
