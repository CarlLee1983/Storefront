export const pageDescriptions: Record<string, string> = {
  "/": "靜物挑選家具、燈具與器物，讓客廳、餐廳、臥室與工作區都有安放日常的地方。",
  "/products": "瀏覽靜物的家具、燈具與器物，依價格與上架時間挑選適合家裡的商品。",
  "/sale": "查看靜物目前標有原價的特價商品，挑選適合日常空間的家具與器物。",
  "/search": "在靜物搜尋家具、燈具與器物。",
  "/cart": "查看購物車中的商品、數量與金額，準備結帳。",
  "/checkout": "確認商品與收件資訊，送出靜物訂單。",
  "/orders": "查看訂單的付款、出貨狀態與收件資訊。",
  "/login": "使用 LINE 或 Google 登入，繼續結帳並查看訂單。",
  "/about": "認識靜物的家居選物，以及付款、配送與購物方式。",
  "/faq": "查看靜物的付款、配送、發票、退換貨與聯絡資訊。",
  "/returns": "了解靜物的 7 天猶豫期、商品退回方式與退款時程。",
  "/404": "這個頁面目前無法瀏覽；可以搜尋商品或前往全部商品。",
  "/500": "頁面暫時無法顯示，請稍後再試，或前往全部商品繼續瀏覽。",
};

export const notFoundDescription = pageDescriptions["/404"]!;

/** Keep shared previews short and free of markup, even when catalog copy has paragraphs. */
export function previewText(value: string | null | undefined, fallback: string): string {
  const plain = (value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return fallback;
  return plain.length > 160 ? `${plain.slice(0, 159).trimEnd()}…` : plain;
}
