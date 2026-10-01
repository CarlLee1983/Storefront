import { expect, type Page } from "@playwright/test";

/** 在後台商品清單把商品標為精選；完成時停在 /admin。商品必須已經存在。 */
export async function featureProduct(admin: Page, productName: string) {
  await admin.goto("/admin");
  await admin.getByRole("row", { name: new RegExp(productName) }).getByRole("button", { name: /^標為精選/ }).click();
  await expect(admin.getByRole("status")).toHaveText("已標為精選商品。");
}

/** 首頁精選區的名額。 */
export const HOME_FEATURED_LIMIT = 4;

/**
 * 各首頁 spec 能標為精選的件數。精選是全域狀態，各 spec 又可能並行：合計不超過首頁名額，
 * 每支 spec 標的商品就一定都在精選區裡，斷言才能以自己的商品為準。
 */
export const FEATURED_BUDGET = { homepage: 2, toast: 2 } as const;

/** 固定名額前提：這支 spec 實際標的件數必須等於它的額度，且各支額度合計不超過首頁名額。 */
export function expectFeaturedWithinBudget(owner: keyof typeof FEATURED_BUDGET, featuredCount: number) {
  expect(featuredCount, `${owner} 實際標的精選件數`).toBe(FEATURED_BUDGET[owner]);
  expect(Object.values(FEATURED_BUDGET).reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(HOME_FEATURED_LIMIT);
}
