import type { APIRequestContext, Page } from "@playwright/test";

/** 開啟以名稱關鍵字篩選的後台商品清單：清單有分頁（每頁 15 筆），新建的商品不一定在第一頁。 */
export async function gotoProductList(admin: Page, name: string) {
  return admin.goto(`/admin?q=${encodeURIComponent(name)}`);
}

/** 讀出（可帶篩選條件的）後台商品清單所有分頁的 HTML。 */
export async function fetchProductListHtml(admin: APIRequestContext, query: Record<string, string> = {}): Promise<string> {
  let html = "";
  for (let page = 1; page <= 20; page++) {
    const params = new URLSearchParams({ ...query, page: String(page) });
    const part = await (await admin.get(`/admin?${params}`, { maxRetries: 3 })).text();
    html += part;
    if (!part.includes(`page=${page + 1}`)) break;
  }
  return html;
}

/** 以訂單編號查找後台訂單清單：新單會把舊單擠出第 1 頁，用編號查找才找得到指定的訂單（#123）。 */
export async function gotoOrderList(admin: Page, orderId: number | string) {
  return admin.goto(`/admin/orders?orderId=${orderId}`);
}
