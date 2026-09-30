import { removeFromCart, type Cart, type CartLine } from "../cart/cart";

type CheckoutResult = Awaited<ReturnType<Env["APP"]["checkout"]>>;

/** 結帳被拒時某一筆訂單明細的問題；型別直接取自 App 的 `checkout_rejected` 回傳，不另外手寫一份。 */
export type CheckoutIssue = Extract<CheckoutResult, { reason: "checkout_rejected" }>["issues"][number];

const priceFormat = new Intl.NumberFormat("zh-TW");
const twd = (amount: number) => `NT$ ${priceFormat.format(amount)}`;

/** 逐筆原因 → 提示文字；`line` 是購物車裡那一筆（找不到就用商品編號當名稱）。 */
export function describeIssue(issue: CheckoutIssue, line: Pick<CartLine, "name" | "unitPriceTwd"> | undefined): string {
  const name = `「${line?.name ?? `商品 #${issue.productId}`}」`;
  switch (issue.kind) {
    case "price_changed":
      return `${name}的單價已變動為 ${twd(issue.currentUnitPriceTwd)}（你看到的是 ${twd(line?.unitPriceTwd ?? 0)}）。`;
    case "unlisted":
      return `${name}已下架，無法結帳，請移除。`;
    case "insufficient_stock":
      return `${name}的可售數量不足，請減少數量或移除。`;
    case "product_not_found":
      return `${name}已不存在，請移除。`;
  }
}

/** 把價格變動的那幾筆改成新單價，其餘不變；沒有可套用的變動就回傳原購物車。 */
export function applyPriceChanges(cart: Cart, issues: readonly CheckoutIssue[]): Cart {
  const newPrices = new Map<number, number>();
  for (const issue of issues) {
    if (issue.kind === "price_changed" && Number.isSafeInteger(issue.currentUnitPriceTwd) && issue.currentUnitPriceTwd >= 1) {
      newPrices.set(issue.productId, issue.currentUnitPriceTwd);
    }
  }
  if (newPrices.size === 0) return cart;
  return {
    ...cart,
    lines: cart.lines.map((line) => {
      const price = newPrices.get(line.productId);
      return price === undefined ? line : { ...line, unitPriceTwd: price };
    }),
  };
}

export function removeLines(cart: Cart, productIds: readonly number[]): Cart {
  return productIds.reduce(removeFromCart, cart);
}

export interface CheckoutFailure {
  message: string;
  /** 欄位名稱 → 錯誤訊息（訊息由 App 的驗證產生，已是可顯示的文字）。 */
  fields: Record<string, string[]>;
  issues: CheckoutIssue[];
}

/** 結帳 RPC 的失敗結果 → 頁面訊息；`unauthorized` 由頁面另外處理（導向登入）。 */
export function describeCheckoutFailure(result: {
  reason: string;
  fields?: Record<string, string[]>;
  issues?: CheckoutIssue[];
}): CheckoutFailure {
  const messages: Record<string, string> = {
    checkout_rejected: "有商品無法結帳，請依下列說明修正後再送出。",
    invalid_input: "輸入有誤，請修正後再送出。",
    // 同一個冪等鍵帶了不同內容（例如另一個分頁改過購物車）；頁面會清掉舊鍵，下一次送出用新鍵
    idempotency_key_reused: "這次結帳的內容和先前送出的不同，已重新準備，請確認內容後再送出一次。",
    checkout_unavailable: "目前無法完成結帳，請稍後再試。",
  };
  return {
    message: messages[result.reason] ?? "結帳失敗，請稍後再試。",
    fields: result.fields ?? {},
    issues: result.issues ?? [],
  };
}
