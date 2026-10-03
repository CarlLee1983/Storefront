/** 售後申請（取消、退貨）內容的 SHA-256 hex（明細依訂單明細編號排序，同樣內容得到同樣指紋）；同鍵不同內容靠它認出來。 */
export async function hashCaseRequest(items: { orderLineId: number; quantity: number }[], reason: string): Promise<string> {
  const normalized = JSON.stringify({ items: [...items].sort((a, b) => a.orderLineId - b.orderLineId), reason });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
