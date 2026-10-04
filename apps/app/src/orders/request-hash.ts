import type { CheckoutInput } from "./input";

/**
 * 結帳內容的指紋：明細依變體編號排序、連同（已 trim 的）收件資訊（不含顧客確認的運費：它只是下單當下的比對值，重送時已成立的訂單照舊回傳），序列化後取 SHA-256 hex。
 * 冪等鍵只保證「同一次結帳」，同一個鍵帶了不同內容是誤用；訂單成立時把指紋寫進訂單，
 * 重送時比對（見 `service.ts`）。不含冪等鍵本身。
 */
export async function requestHash({ lines, shippingInfo }: Pick<CheckoutInput, "lines" | "shippingInfo">): Promise<string> {
  const canonical = JSON.stringify({
    lines: lines
      .map(({ variantId, quantity, seenUnitPriceTwd }) => [variantId, quantity, seenUnitPriceTwd])
      .sort(([a], [b]) => a! - b!),
    shippingInfo: [shippingInfo.name, shippingInfo.phone, shippingInfo.address],
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
