import { type Cart, type CartLine } from "../cart/cart";

type CheckoutResult = Awaited<ReturnType<Env["APP"]["checkout"]>>;

/** 結帳被拒時某一筆訂單明細的問題；型別直接取自 App 的 `checkout_rejected` 回傳，不另外手寫一份。 */
export type CheckoutIssue = Extract<CheckoutResult, { reason: "checkout_rejected" }>["issues"][number];

const priceFormat = new Intl.NumberFormat("zh-TW");
const twd = (amount: number) => `NT$ ${priceFormat.format(amount)}`;

/** 逐筆原因 → 提示文字；`line` 是購物車裡那一筆（找不到就用商品編號當名稱）。 */
export function describeIssue(issue: CheckoutIssue, line: Pick<CartLine, "name" | "label" | "unitPriceTwd"> | undefined): string {
  const name = `「${line ? (line.label ? `${line.name}（${line.label}）` : line.name) : `商品 #${issue.variantId}`}」`;
  switch (issue.kind) {
    case "price_changed":
      return `${name}的售價已更新為 ${twd(issue.currentUnitPriceTwd)}。請確認總金額，再決定是否更新購物車。`;
    case "unlisted":
      return `${name}目前無法購買，請從購物車移除。`;
    case "discontinued":
      return `${name}已停賣，請從購物車移除。`;
    case "insufficient_stock":
      return `${name}的可售數量不足，請減少數量或移除。`;
    case "variant_not_found":
      return `${name}目前無法購買，請從購物車移除。`;
  }
}

/** 把價格變動的那幾筆改成新單價，其餘不變；沒有可套用的變動就回傳原購物車。 */
export function applyPriceChanges(cart: Cart, issues: readonly CheckoutIssue[]): Cart {
  const newPrices = new Map<number, number>();
  for (const issue of issues) {
    if (issue.kind === "price_changed" && Number.isSafeInteger(issue.currentUnitPriceTwd) && issue.currentUnitPriceTwd >= 1) {
      newPrices.set(issue.variantId, issue.currentUnitPriceTwd);
    }
  }
  if (newPrices.size === 0) return cart;
  return {
    ...cart,
    lines: cart.lines.map((line) => {
      const price = newPrices.get(line.variantId);
      return price === undefined ? line : { ...line, unitPriceTwd: price };
    }),
  };
}

export interface CheckoutFailure {
  message: string;
  /** 顧客欄位名稱 → 固定文案；不回顯 App 原始文字。 */
  fields: Record<string, string[]>;
  issues: CheckoutIssue[];
}

export interface CheckoutValidationIssue {
  path: readonly PropertyKey[];
  code: string;
}

function customerFields(issues: readonly CheckoutValidationIssue[], remoteFields: Record<string, string[]>): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const [parent, child] = issue.path;
    if (parent !== "shippingInfo") continue;
    const key = child === "name" || child === "phone" || child === "address" ? child : "shippingInfo";
    const message = key === "shippingInfo" ? "請確認收件人姓名、電話與地址後再送出。"
      : key === "phone" ? (issue.code === "too_small" ? "請填寫收件人電話。" : "請確認收件人電話格式。")
      : key === "name" ? (issue.code === "too_big" ? "收件人姓名太長，請縮短後再試。" : "請填寫收件人姓名。")
      : issue.code === "too_big" ? "收件地址太長，請縮短後再試。" : "請填寫收件地址。";
    (fields[key] ??= []).includes(message) || fields[key]!.push(message);
  }
  if (Object.hasOwn(remoteFields, "shippingInfo") && !["name", "phone", "address", "shippingInfo"].some((key) => fields[key])) {
    fields.shippingInfo = ["請確認收件人姓名、電話與地址後再送出。"];
  }
  if (Object.hasOwn(remoteFields, "idempotencyKey") || issues.some((issue) => issue.path[0] === "idempotencyKey")) {
    fields.idempotencyKey = ["這次結帳未能完成，請確認購物車與收件資訊後再送出。"];
  }
  return fields;
}

/** 結帳 RPC 的失敗結果 → 頁面訊息；`unauthorized` 由頁面另外處理（導向登入）。 */
export function describeCheckoutFailure(result: {
  reason: string;
  fields?: Record<string, string[]>;
  issues?: CheckoutIssue[];
}, validationIssues: readonly CheckoutValidationIssue[] = []): CheckoutFailure {
  const messages: Record<string, string> = {
    checkout_rejected: "有商品目前無法結帳，請依下列說明調整購物車。",
    invalid_input: "輸入有誤，請確認資料後再送出。",
    // 同一個冪等鍵帶了不同內容（例如另一個分頁改過購物車）；頁面會清掉舊鍵，下一次送出用新鍵
    idempotency_key_reused: "結帳內容已有變動，請確認商品與總金額後再送出一次。",
    // 運費在顧客確認之後被調整；結帳頁重新載入會取得新的運費，顧客確認新總額後再送出
    shipping_fee_changed: "運費已調整，請確認新的運費與總金額後再送出。",
    checkout_unavailable: "目前無法完成結帳，請稍後再試。",
  };
  return {
    message: Object.hasOwn(messages, result.reason) ? messages[result.reason]! : "目前無法完成結帳，請稍後再試。",
    fields: result.reason === "invalid_input" ? customerFields(validationIssues, result.fields ?? {}) : {},
    issues: result.issues ?? [],
  };
}
